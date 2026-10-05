import { describe, expect, it } from "vitest";
import { HerdrRuntime } from "../src/adapters/herdr/runtime.js";
import type { HerdrCommandRunner } from "../src/adapters/herdr/process.js";
import type { WorkUnit, Worker } from "../src/protocol.js";

const workUnit: WorkUnit = {
  id: "wu-herdr",
  goal: "Run a bounded implementation",
  repository: "example/repo",
  capabilities: ["coding"],
  acceptanceCriteria: ["verification passes"],
};

const worker: Worker = {
  id: "worker-opencode",
  capabilities: ["coding"],
  runtime: "opencode",
};

function herdrResponse(args: string[]): unknown {
  if (args[0] === "workspace" && args[1] === "create") return { result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "p1" } } };
  if (args[0] === "worktree") return { result: { worktree: { path: "/repo/.worktree" } } };
  if (args[0] === "workspace" && args[1] === "get") return { result: { root_pane: { pane_id: "p1" } } };
  if (args[0] === "agent") return { result: { agent: { name: args[2], status: "idle" } } };
  return {};
}

function runnerFor(responses: (args: string[]) => unknown, errors: Record<string, Error> = {}): HerdrCommandRunner {
  return {
    async run(args) {
      const error = errors[args.join(" ")];
      if (error) throw error;
      return { stdout: JSON.stringify(responses(args)), stderr: "" };
    },
  };
}

describe("HerdrRuntime", () => {
  it("runs the managed lifecycle without requiring Herdr", async () => {
    const runtime = new HerdrRuntime({
      repositoryRoot: "/repo",
      commandRunner: runnerFor((args) => {
        if (args[0] === "workspace" && args[1] === "create") {
          return { result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "p1" } } };
        }
        if (args[0] === "worktree") return { result: { worktree: { path: "/repo/.worktree" } } };
        if (args[0] === "workspace" && args[1] === "get") return { result: { root_pane: { pane_id: "p1" } } };
        if (args[0] === "agent" && args[1] === "start") return { result: { agent: { name: args[2], status: "idle" } } };
        if (args[0] === "agent" && args[1] === "prompt") return { result: { agent: { name: args[2], status: "idle" } } };
        if (args[0] === "agent" && args[1] === "wait") return { result: { agent: { name: args[2], status: "idle" } } };
        if (args[0] === "agent" && args[1] === "get") return { result: { agent: { name: args[2], status: "idle" } } };
        return {};
      }),
    });

    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, worker);
    await runtime.promptAgent(agent, "implement");

    expect(await runtime.waitAgent(agent, 1000)).toBe("idle");
    expect((await runtime.inspectAgent(agent)).status).toBe("idle");
    expect((await runtime.collectRuntimeEvidence(agent)).runtime).toBe("herdr");
  });

  it("reports a blocked agent as exited through the protocol tri-state", async () => {
    const runtime = new HerdrRuntime({
      repositoryRoot: "/repo",
      commandRunner: {
        async run(args) {
          if (args[0] === "agent" && args[1] === "wait") throw new Error("agent is blocked by policy");
          return { stdout: JSON.stringify(herdrResponse(args)), stderr: "" };
        },
      },
    });

    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, worker);
    await runtime.promptAgent(agent, "implement");

    expect(await runtime.waitAgent(agent, 1000)).toBe("exited");
    expect((await runtime.inspectAgent(agent)).failure).toBe("blocked");
  });

  it("maps unavailable Herdr explicitly", async () => {
    const runtime = new HerdrRuntime({
      commandRunner: runnerFor(() => ({}), {
        "status server": new Error("ENOENT: herdr not found"),
      }),
    });

    expect((await runtime.health()).available).toBe(false);
  });

  it("does not turn runtime completion into verification success", async () => {
    const runtime = new HerdrRuntime({
      commandRunner: runnerFor((args) => {
        if (args[0] === "workspace" && args[1] === "create") return { result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "p1" } } };
        if (args[0] === "worktree") return { result: { worktree: { path: "/repo/.worktree" } } };
        if (args[0] === "workspace" && args[1] === "get") return { result: { root_pane: { pane_id: "p1" } } };
        if (args[0] === "agent" && args[1] === "start") return { result: { agent: { name: args[2], status: "idle" } } };
        if (args[0] === "agent" && args[1] === "prompt") return { result: { agent: { name: args[2], status: "idle" } } };
        if (args[0] === "agent" && args[1] === "get") return { result: { agent: { name: args[2], status: "idle" } } };
        return {};
      }),
    });
    const workspace = await runtime.createWorkspace(workUnit);
    const worktree = await runtime.createWorktree(workspace, "HEAD");
    const agent = await runtime.startAgent(worktree, worker);
    await runtime.promptAgent(agent, "implement");
    const status = await runtime.inspectAgent(agent);
    expect(status.status).toBe("idle");
    expect("verification" in status).toBe(false);
  });
});
