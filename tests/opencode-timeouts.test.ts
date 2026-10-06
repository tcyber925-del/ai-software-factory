import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMMAND_TIMEOUT_MS, defaultCommandRunner } from "../src/adapters/opencode/process.js";
import { OpenCodeRuntime } from "../src/adapters/opencode/runtime.js";
import type { CommandRunner } from "../src/adapters/opencode/process.js";
import { executeWorkUnit } from "../src/kernel/execution.js";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { InMemoryEventLog } from "../src/state/event-log.js";
import type { WorkUnit, Worker } from "../src/protocol.js";

/**
 * A dispatch must always terminate with a recorded reason.
 *
 * Found by dogfooding: `factory work run` hung for 25 minutes on the OpenCode
 * runtime and produced no error, leaving the event log frozen at `worker.started`.
 * An unbounded subprocess makes a stuck runtime indistinguishable from slow work,
 * and a log that never resolves is worse than a crash — the evidence lies.
 *
 * These tests cover the bound itself, not the happy path.
 */

const workUnit: WorkUnit = { id: "wu-1", goal: "Implement a bounded change", repository: "example/repo", capabilities: ["coding"], acceptanceCriteria: ["tests pass"] };
const worker: Worker = { id: "worker-opencode", capabilities: ["coding"], runtime: "opencode" };

const schema: JsonSchema = {
  type: "object",
  required: ["id", "goal", "repository", "capabilities", "acceptance_criteria"],
  properties: {
    id: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    repository: { type: "string", minLength: 1 },
    capabilities: { type: "array", minItems: 1, items: { type: "string" } },
    acceptance_criteria: { type: "array", minItems: 1, items: { type: "string" } },
  },
};

/** A runner that records the options it was handed, so propagation is observable. */
function recordingRunner(behaviour: (command: string, args: string[]) => void = () => {}): {
  runner: CommandRunner;
  seen: Array<{ command: string; args: string[]; timeoutMs?: number }>;
} {
  const seen: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
  return {
    seen,
    runner: {
      async run(command, args, _cwd, options) {
        seen.push({ command, args, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
        behaviour(command, args);
        return { stdout: "", stderr: "" };
      },
    },
  };
}

describe("the default runner bounds every subprocess", () => {
  const run = promisify(execFile);

  it("returns normally for a command that exits", async () => {
    const result = await defaultCommandRunner.run("node", ["-e", "process.stdout.write('done')"], process.cwd());
    expect(result.stdout).toBe("done");
  });

  it("times out a command that never exits, and says so", async () => {
    // The message must classify as `timeout` in both #mapFailure and
    // asRuntimeFailure, which is why the wording is part of the contract.
    await expect(
      defaultCommandRunner.run("node", ["-e", "setInterval(() => {}, 1000)"], process.cwd(), { timeoutMs: 150 }),
    ).rejects.toThrow(/timed out after 150ms/);
  }, 15_000);

  it("does not report an ordinary non-zero exit as a timeout", async () => {
    // A killed child and a failing child are different faults; conflating them
    // would report a permissions error as a timeout.
    await expect(
      defaultCommandRunner.run("node", ["-e", "process.exit(3)"], process.cwd(), { timeoutMs: 10_000 }),
    ).rejects.not.toThrow(/timed out/);
  });

  it("still surfaces the real error for a missing binary", async () => {
    await expect(
      defaultCommandRunner.run("definitely-not-a-real-binary-xyz", [], process.cwd(), { timeoutMs: 5_000 }),
    ).rejects.toThrow(/ENOENT|not found/);
  });

  it("has a finite default for calls that pass no timeout", () => {
    // Structural, not behavioural: an unbounded default is the defect.
    expect(Number.isFinite(DEFAULT_COMMAND_TIMEOUT_MS)).toBe(true);
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("propagates a timeout through node's own kill signal", async () => {
    // Proves the bound comes from Node's execFile timeout, not a raced Promise.race,
    // which would leave the child process running.
    const started = Date.now();
    await expect(
      defaultCommandRunner.run("node", ["-e", "setTimeout(() => {}, 60000)"], process.cwd(), { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(10_000);
    // The child must actually be dead, or repeated runs would accumulate processes.
    const { stdout } = await run("sh", ["-c", "pgrep -fc 'setTimeout..60000' || true"], { cwd: process.cwd() });
    expect(Number(stdout.trim())).toBeLessThan(5);
  }, 20_000);
});

describe("promptAgent is bounded", () => {
  it("passes its prompt timeout to the runner", async () => {
    const { runner, seen } = recordingRunner();
    const runtime = new OpenCodeRuntime({ runner, promptTimeoutMs: 1234 });
    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, { ...worker });
    await runtime.promptAgent(agent, "do the work");
    const prompt = seen.find((call) => call.command === "opencode");
    expect(prompt?.timeoutMs).toBe(1234);
  });

  it("classifies an expired prompt as `timeout`, not a generic exit", async () => {
    const runtime = new OpenCodeRuntime({
      runner: { async run(command) {
        if (command === "opencode") throw new Error("timed out after 50ms: opencode run");
        return { stdout: "", stderr: "" };
      } },
    });
    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, { ...worker });

    await expect(runtime.promptAgent(agent, "do the work")).rejects.toThrow(/OpenCode runtime \[timeout\]/);
    const inspected = await runtime.inspectAgent(agent);
    expect(inspected.failure).toBe("timeout");
  });

  it("records the prompt timeout in the collected evidence", async () => {
    const runtime = new OpenCodeRuntime({ runner: recordingRunner().runner, promptTimeoutMs: 4321 });
    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, { ...worker });
    await runtime.promptAgent(agent, "do the work");

    const evidence = await runtime.collectRuntimeEvidence(agent);
    const completed = evidence.events.find((event) => event.type === "prompt.completed");
    expect(completed?.payload).toMatchObject({ timeoutMs: 4321 });
  });
});

describe("waitAgent honours the timeout it is given", () => {
  it("returns immediately for an agent that already finished", async () => {
    const runtime = new OpenCodeRuntime({ runner: recordingRunner().runner });
    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, { ...worker });
    await runtime.promptAgent(agent, "done");
    expect(await runtime.waitAgent(agent, 60_000)).toBe("idle");
  });

  it("throws `timeout` for an agent still running when the budget expires", async () => {
    // The agent is left in `created`, which maps to `running`, so this is exactly
    // the state a wedged runtime is in.
    const runtime = new OpenCodeRuntime({ runner: recordingRunner().runner });
    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, { ...worker });

    await expect(runtime.waitAgent(agent, 0)).rejects.toThrow(/timed out after 0ms/);
  });

  it("marks the agent so evidence shows the timeout rather than slow progress", async () => {
    const runtime = new OpenCodeRuntime({ runner: recordingRunner().runner });
    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, { ...worker });
    await expect(runtime.waitAgent(agent, 0)).rejects.toThrow();

    // Without this the run would still look merely slow, which is the failure mode
    // that produced an unresolvable event log.
    expect(await runtime.inspectAgent(agent)).toEqual({ status: "running", failure: "timeout" });
    const evidence = await runtime.collectRuntimeEvidence(agent);
    expect(evidence.events.some((event) => event.type === "agent.wait_timed_out")).toBe(true);
  });
});

describe("a dispatch that outlives its runtime ends as a recorded failure", () => {
  it("records a timeout in the execution record and the durable log", async () => {
    const runtime = new OpenCodeRuntime({
      // promptAgent times out, exactly as it did when the factory hung for 25
      // minutes with no error written.
      runner: { async run() { throw new Error("timed out after 900000ms: opencode run"); } },
    });
    const log = new InMemoryEventLog();

    const record = await executeWorkUnit({
      workUnit,
      worker,
      prompt: workUnit.goal,
      schema,
      runtimes: [{ name: "opencode", runtime }],
      eventLog: log,
      runId: "run-timeout",
    });

    expect(record.status).toBe("failed");
    expect(record.failure).toBe("timeout");

    // The evidence the earlier hang never produced.
    const types = log.stored().map((event) => event.type);
    expect(types).toContain("runtime.failure");
    const failure = log.stored().find((event) => event.type === "runtime.failure");
    expect(failure?.payload).toMatchObject({ failure: "timeout" });
    expect(String(failure?.payload?.["message"])).toMatch(/timed out/);
  }, 15_000);

  it("still cleans up the workspace after a timeout", async () => {
    // A timed-out dispatch that leaves a registered worktree would accumulate
    // garbage in every adopting repository.
    const runtime = new OpenCodeRuntime({
      runner: { async run(command, args) {
        if (command === "opencode") throw new Error("timed out after 900000ms: opencode run");
        return { stdout: "", stderr: "" };
      } },
    });

    const record = await executeWorkUnit({
      workUnit,
      worker,
      prompt: workUnit.goal,
      schema,
      runtimes: [{ name: "opencode", runtime }],
      runId: "run-timeout-cleanup",
    });

    expect(record.failure).toBe("timeout");
    expect(record.events.some((event) => event.type === "workspace.cleaned")).toBe(true);
  }, 15_000);
});