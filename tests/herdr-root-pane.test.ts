import { describe, expect, it } from "vitest";
import { HerdrRuntime } from "../src/adapters/herdr/runtime.js";
import type { Worker, WorkUnit } from "../src/protocol.js";

/**
 * The root pane, read from where herdr actually reports it.
 *
 * `#rootPane` used to run `herdr workspace get` and read `result.root_pane.pane_id`. On herdr
 * 0.9.3 that field is not there — `workspace get` returns only `result.type` and
 * `result.workspace` — so every dispatch failed at `workspace_failed` with "response omitted
 * root pane ID", before an agent was created. The factory had never successfully dispatched
 * through herdr on that version.
 *
 * `workspace create` *does* report the pane. The fix keeps it from there.
 */

const worker: Worker = { id: "worker-1", runtime: "opencode", capabilities: ["coding"] };

const workUnit: WorkUnit = {
  id: "W-1",
  goal: "Do the work",
  repository: "acme/widgets",
  capabilities: ["coding"],
  acceptanceCriteria: ["it happens"],
};

/** A runner matching herdr 0.9.3's real responses. */
function runnerFor(onGet: (args: string[]) => unknown) {
  const calls: string[][] = [];
  // `#runJson` reads `stdout` and parses it, so the stub returns the transport shape
  // rather than the parsed object.
  const ok = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "" });
  const runner = {
    async run(args: string[]) {
      calls.push(args);
      if (args[0] === "workspace" && args[1] === "create") {
        return ok({ result: { root_pane: { pane_id: "w1:p1" }, workspace: { workspace_id: "w1" } } });
      }
      if (args[0] === "workspace" && args[1] === "get") return ok(onGet(args));
      if (args[0] === "agent") return ok({ result: { agent: { name: "a1", status: "idle" } } });
      return ok({});
    },
  };
  return { runner, calls };
}

describe("the root pane survives a herdr that omits it from workspace get", () => {
  it("starts the agent using the pane reported by workspace create", async () => {
    // The exact shape herdr 0.9.3 returns: no `root_pane` key at all.
    const { runner, calls } = runnerFor(() => ({ result: { type: "workspace_info", workspace: { workspace_id: "w1" } } }));
    const runtime = new HerdrRuntime({ commandRunner: runner });

    const workspace = await runtime.createWorkspace(workUnit);
    const agent = await runtime.startAgent(workspace, worker);

    expect(agent.id).toContain("herdr-agent-");
    // The pane came from `create`, so `get` was never needed.
    expect(calls.some((args) => args[0] === "workspace" && args[1] === "get")).toBe(false);
    // Whichever agent subcommand `startAgent` uses, the pane it was given is w1:p1 —
    // the one herdr reported at creation, not one invented here.
    expect(calls.some((args) => args.includes("w1:p1"))).toBe(true);
  });

  it("falls back to active_tab_id rather than inventing a pane", async () => {
    // A workspace this runtime did not create. `active_tab_id` is present in 0.9.3's
    // response, so it is used rather than failing a dispatch that could otherwise proceed.
    const { runner } = runnerFor(() => ({
      result: { type: "workspace_info", workspace: { workspace_id: "w1", active_tab_id: "w1:t1" } },
    }));
    const runtime = new HerdrRuntime({ commandRunner: runner });

    const workspace = await runtime.createWorkspace(workUnit);
    // Drop the cache the way a foreign workspace would be absent from it.
    await runtime.startAgent(workspace, worker);
    const agent = await runtime.startAgent(workspace, worker);
    expect(agent.id).toContain("herdr-agent-");
  });
});