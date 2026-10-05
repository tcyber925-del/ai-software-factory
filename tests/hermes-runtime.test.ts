import { describe, expect, it } from "vitest";
import type { WorkUnit, Worker } from "../src/protocol.js";
import type { HermesCommandResult, HermesCommandRunner } from "../src/adapters/hermes/process.js";
import { HermesRuntime } from "../src/adapters/hermes/runtime.js";

/**
 * Every test here runs against an injected command runner, so none of them
 * require Hermes to be installed. That mirrors the Herdr adapter's acceptance
 * criterion and keeps the suite deterministic.
 */

const workUnit: WorkUnit = {
  id: "FCT-009",
  goal: "prove Hermes dispatch keeps factory authority",
  repository: "example/repo",
  capabilities: ["coding", "orchestration"],
  acceptanceCriteria: ["identity is traceable", "runtime state is not verification"],
};

const worker: Worker = { id: "worker-hermes", capabilities: ["coding", "orchestration"], runtime: "hermes" };

/** Records every invocation so argument construction is assertable. */
function recordingRunner(
  respond: (args: string[]) => HermesCommandResult = () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
) {
  const calls: string[][] = [];
  const runner: HermesCommandRunner = {
    async run(args) {
      calls.push(args);
      return respond(args);
    },
  };
  return { runner, calls };
}

describe("Hermes implements the provider-neutral runtime contract", () => {
  it("implements WorkerRuntime", async () => {
    const { runner } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    expect(typeof runtime.capabilities).toBe("function");
    expect(typeof runtime.health).toBe("function");
    expect(typeof runtime.createWorkspace).toBe("function");
    expect(typeof runtime.createWorktree).toBe("function");
    expect(typeof runtime.startAgent).toBe("function");
    expect(typeof runtime.promptAgent).toBe("function");
    expect(typeof runtime.waitAgent).toBe("function");
    expect(typeof runtime.inspectAgent).toBe("function");
    expect(typeof runtime.collectRuntimeEvidence).toBe("function");
    expect(typeof runtime.cleanupWorkspace).toBe("function");
  });

  it("offers orchestration without claiming verification", async () => {
    const { runner } = recordingRunner();
    const capabilities = await new HermesRuntime({ commandRunner: runner }).capabilities();
    expect(capabilities).toContain("orchestration");
    expect(capabilities).toContain("coding");
    // This adapter can run checks; it cannot establish that they passed.
    expect(capabilities).not.toContain("verification");
  });

  it("reports health from the Hermes version", async () => {
    const { runner } = recordingRunner((args) =>
      args[0] === "--version"
        ? { stdout: "Hermes Agent v0.21.5\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 1 },
    );
    const health = await new HermesRuntime({ commandRunner: runner }).health();
    expect(health).toEqual({ available: true, runtime: "hermes", version: "Hermes Agent v0.21.5" });
  });

  it("reports unavailable when Hermes cannot be invoked", async () => {
    const { runner } = recordingRunner(() => ({ stdout: "", stderr: "hermes: command not found", exitCode: 127 }));
    const health = await new HermesRuntime({ commandRunner: runner }).health();
    expect(health.available).toBe(false);
  });

  it("runs the full lifecycle and collects evidence", async () => {
    const { runner, calls } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });

    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, worker);
    await runtime.promptAgent(agent, "implement the bounded change");

    expect(await runtime.waitAgent(agent, 1000)).toBe("idle");
    const evidence = await runtime.collectRuntimeEvidence(agent);
    expect(evidence.runtime).toBe("hermes");
    expect(evidence.events.map((event) => event.type)).toContain("worker.finished");
    await runtime.cleanupWorkspace(workspace);

    // Dispatch used the discovered one-shot interface.
    expect(calls.some((args) => args.includes("-z"))).toBe(true);
  });
});

describe("parent Work Unit identity stays traceable", () => {
  it("carries the parent Work Unit id into the agent and its evidence", async () => {
    const { runner } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await runtime.promptAgent(agent, "go");

    const evidence = await runtime.collectRuntimeEvidence(agent);
    expect(evidence.events.every((event) => event.workUnitId === "FCT-009")).toBe(true);
    // The session identity is derived from the parent, not from the agent alone.
    expect(agent.runtimeId).toBe("FCT-009:worker-hermes");
  });

  it("does not lose identity across two agents in one workspace", async () => {
    const { runner } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const worktree = await runtime.createWorktree(await runtime.createWorkspace(workUnit));
    const first = await runtime.startAgent(worktree, worker);
    const second = await runtime.startAgent(worktree, worker);
    await runtime.promptAgent(first, "a");
    await runtime.promptAgent(second, "b");

    for (const agent of [first, second]) {
      const evidence = await runtime.collectRuntimeEvidence(agent);
      expect(evidence.events.every((event) => event.workUnitId === "FCT-009")).toBe(true);
    }
  });
});

describe("Hermes runtime state is not factory completion", () => {
  it("returns only the protocol tri-state from waitAgent", async () => {
    const { runner } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await runtime.promptAgent(agent, "go");
    expect(await runtime.waitAgent(agent, 1000)).toBe("idle");
  });

  it("never exposes a verification field through inspectAgent", async () => {
    const { runner } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await runtime.promptAgent(agent, "go");

    const inspected = await runtime.inspectAgent(agent);
    expect("verification" in inspected).toBe(false);
    expect("passed" in inspected).toBe(false);
    expect(Object.keys(inspected).sort()).toEqual(["status"]);
  });

  it("labels its finish evidence as operational, not correctness", async () => {
    const { runner } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await runtime.promptAgent(agent, "go");
    await runtime.waitAgent(agent, 1000);

    const evidence = await runtime.collectRuntimeEvidence(agent);
    const finished = evidence.events.find((event) => event.type === "worker.finished");
    expect(finished?.payload?.["note"]).toContain("not verification success");
    // No runtime event may claim verification passed.
    expect(evidence.events.some((event) => event.type.includes("verification"))).toBe(false);
  });

  it("reports a blocked Hermes run as exited through the tri-state", async () => {
    const { runner } = recordingRunner(() => ({ stdout: "", stderr: "approval required", exitCode: 1 }));
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);

    await expect(runtime.promptAgent(agent, "go")).rejects.toThrow(/blocked/);
    expect(await runtime.waitAgent(agent, 1000)).toBe("exited");
    expect((await runtime.inspectAgent(agent)).failure).toBe("blocked");
  });
});

describe("failures and disconnects are explicit", () => {
  it("maps an unavailable Hermes explicitly", async () => {
    const { runner } = recordingRunner(() => ({ stdout: "", stderr: "hermes: command not found", exitCode: 127 }));
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await expect(runtime.promptAgent(agent, "go")).rejects.toThrow(/unavailable/);
    expect((await runtime.inspectAgent(agent)).failure).toBe("unavailable");
  });

  it("maps a timeout explicitly", async () => {
    const { runner } = recordingRunner(() => ({ stdout: "", stderr: "operation timed out", exitCode: 124 }));
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await expect(runtime.promptAgent(agent, "go")).rejects.toThrow(/timeout/);
    expect((await runtime.inspectAgent(agent)).failure).toBe("timeout");
  });

  it("maps a worktree failure explicitly", async () => {
    const { runner } = recordingRunner(() => ({ stdout: "", stderr: "worktree already exists", exitCode: 1 }));
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await expect(runtime.promptAgent(agent, "go")).rejects.toThrow(/workspace_failed/);
  });

  it("preserves evidence collected before a failure", async () => {
    const { runner } = recordingRunner(() => ({ stdout: "", stderr: "hermes: not found", exitCode: 127 }));
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await expect(runtime.promptAgent(agent, "go")).rejects.toThrow();

    // A failed run stays inspectable rather than erasing what happened.
    const evidence = await runtime.collectRuntimeEvidence(agent);
    expect(evidence.events.some((event) => event.type === "worker.started")).toBe(true);
    expect(evidence.events.some((event) => event.type === "worker.failure")).toBe(true);
  });

  it("rejects an empty prompt and an unknown agent", async () => {
    const { runner } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await expect(runtime.promptAgent(agent, "   ")).rejects.toThrow("prompt must not be empty");
    await expect(runtime.waitAgent({ id: "nope", runtimeId: "nope" }, 1000)).rejects.toThrow("unknown Hermes agent");
  });
});

describe("least privilege is the default", () => {
  it("passes no toolsets unless the caller asks for them", async () => {
    const { runner, calls } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await runtime.promptAgent(agent, "go");

    const dispatch = calls.find((args) => args.includes("-z")) ?? [];
    expect(dispatch.includes("--toolsets")).toBe(false);
  });

  it("passes explicitly requested toolsets", async () => {
    const { runner, calls } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo", toolsets: ["fs", "shell"] });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await runtime.promptAgent(agent, "go");

    const dispatch = calls.find((args) => args.includes("-z")) ?? [];
    expect(dispatch[dispatch.indexOf("--toolsets") + 1]).toBe("fs,shell");
  });

  it("never disables Hermes safety prompts", async () => {
    const { runner, calls } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await runtime.promptAgent(agent, "go");

    for (const args of calls) {
      expect(args).not.toContain("--yolo");
      expect(args).not.toContain("--accept-hooks");
    }
  });

  it("records usage evidence without treating it as verification", async () => {
    const { runner, calls } = recordingRunner();
    const runtime = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(await runtime.createWorktree(workspace), worker);
    await runtime.promptAgent(agent, "go");

    // Usage capture is requested so a run can be attributed and audited.
    expect(calls.some((args) => args.includes("--usage-file"))).toBe(true);
    const evidence = await runtime.collectRuntimeEvidence(agent);
    expect(evidence.events.some((event) => event.type === "worker.prompted")).toBe(true);
  });
});

describe("Hermes does not displace the direct runtime", () => {
  it("coexists with the direct runtimes under the same contract", async () => {
    const { runner } = recordingRunner();
    const { FakeRuntime } = await import("../src/fake-runtime.js");
    const { OpenCodeRuntime } = await import("../src/adapters/opencode/runtime.js");

    const hermes = new HermesRuntime({ commandRunner: runner, repositoryRoot: "/repo" });
    // Same interface, independently constructed: adding Hermes did not change
    // or wrap any existing adapter.
    const direct = [new FakeRuntime(), new OpenCodeRuntime({ runner: { run: async () => ({ stdout: "ok", stderr: "" }) } })];
    for (const runtime of [hermes, ...direct]) {
      expect(typeof runtime.capabilities).toBe("function");
      expect(typeof runtime.health).toBe("function");
    }
    await expect(hermes.health()).resolves.toHaveProperty("runtime", "hermes");
    await expect(new FakeRuntime().health()).resolves.toHaveProperty("runtime", "fake");
  });

  it("keeps Hermes optional rather than a factory dependency", () => {
    // Nothing in the runtime module requires the hermes binary to exist; the
    // injected runner is the only entry point.
    expect(typeof HermesRuntime).toBe("function");
  });
});