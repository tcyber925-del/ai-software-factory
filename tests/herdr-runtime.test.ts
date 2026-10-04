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

function runnerFor(
  responses: Record<string, unknown>,
  errors: Record<string, Error> = {},
): HerdrCommandRunner {
  return {
    async run(args) {
      const key = args.join(" ");
      if (errors[key]) throw errors[key];
      return { stdout: JSON.stringify(responses[key] ?? {}), stderr: "" };
    },
  };
}

describe("HerdrRuntime", () => {
  it("runs the managed lifecycle without requiring Herdr", async () => {
    const runtime = new HerdrRuntime({
      repositoryRoot: "/repo",
      commandRunner: runnerFor({
        "workspace create --cwd /repo --label factory-wu-herdr-deadbeef --no-focus": {
          result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "p1" } },
        },
        "worktree create --workspace w1 --branch factory/wu-herdr --no-focus --base HEAD": {
          result: { worktree: { path: "/repo/.worktree" } },
        },
        "workspace get w1": { result: { root_pane: { pane_id: "p1" } } },
        "agent start herdr-agent-test --kind opencode --pane p1 --timeout 30000 -- opencode": {
          result: { agent: { name: "herdr-agent-test", status: "idle" } },
        },
        "agent prompt herdr-agent-test implement --wait --timeout 120000": {
          result: { agent: { name: "herdr-agent-test", status: "idle" } },
        },
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

  it("maps unavailable Herdr explicitly", async () => {
    const runtime = new HerdrRuntime({
      commandRunner: runnerFor({}, {
        "status server": new Error("ENOENT: herdr not found"),
      }),
    });

    expect((await runtime.health()).available).toBe(false);
  });

  it("does not turn runtime completion into verification success", async () => {
    const runtime = new HerdrRuntime({
      commandRunner: runnerFor({
        "workspace create --cwd /repo --label factory-wu-herdr-deadbeef --no-focus": {
          result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "p1" } },
        },
        "worktree create --workspace w1 --branch factory/wu-herdr --no-focus --base HEAD": {
          result: { worktree: { path: "/repo/.worktree" } },
        },
        "workspace get w1": { result: { root_pane: { pane_id: "p1" } } },
        "agent start herdr-agent-test --kind opencode --pane p1 --timeout 30000 -- opencode": {
          result: { agent: { name: "herdr-agent-test", status: "idle" } },
        },
        "agent prompt herdr-agent-test implement --wait --timeout 120000": {
          result: { agent: { name: "herdr-agent-test", status: "idle" } },
        },
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
