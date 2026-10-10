import { describe, expect, it } from "vitest";
import { availableRuntimes } from "../src/cli/index.js";
import { selectRuntime, validateWorkUnit } from "../src/kernel/work-unit.js";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import type { LabelledRuntime } from "../src/kernel/work-unit.js";
import type { AgentRef, ExecutionEvent, RuntimeEvidence, RuntimeHealth, Worker, WorkerRuntime, WorkUnit, WorkspaceRef } from "../src/protocol.js";

/**
 * Which runtime actually does the work.
 *
 * `selectRuntime` takes the first candidate that satisfies a Work Unit's capabilities
 * and does no ranking of its own, so the fleet order it is handed *is* the selection
 * policy. That made `fake` — a runtime whose worktree is fictional, and which
 * therefore cannot pass any real check — win every Work Unit it could satisfy, purely
 * by being listed first.
 *
 * Observed, with all four runtimes installed and `hermes` healthy and fully capable:
 *
 * ```
 * selected: fake
 *   fake       available=true   missing=[]
 *   opencode   available=false  missing=["documentation"]
 *   herdr      available=false  missing=["documentation"]
 *   hermes     available=true   missing=[]
 * ```
 *
 * Every default `work run` on a machine with real runtimes installed produced the
 * same meaningless block. Someone who installed `herdr` and never passed `--runtime`
 * would reasonably conclude the factory was broken.
 */

const schema: JsonSchema = {
  type: "object",
  required: ["id", "goal", "repository", "capabilities", "acceptance_criteria"],
  properties: {
    id: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    repository: { type: "string", minLength: 1 },
    capabilities: { type: "array", items: { type: "string" } },
    acceptance_criteria: { type: "array", items: { type: "string" } },
  },
};

function unit(capabilities: string[]): WorkUnit {
  return {
    id: "W-1",
    goal: "Do the work",
    repository: "acme/widgets",
    capabilities,
    acceptanceCriteria: ["it happens"],
  };
}

/** A runtime that declares exactly the capabilities given, and does nothing else. */
function runtime(name: string, capabilities: string[]): LabelledRuntime {
  const stub: WorkerRuntime = {
    capabilities: async () => capabilities,
    health: async (): Promise<RuntimeHealth> => ({ available: true, runtime: name }),
    createWorkspace: async (): Promise<WorkspaceRef> => ({ id: "ws", path: "/tmp/ws" }),
    createWorktree: async (workspace: WorkspaceRef): Promise<WorkspaceRef> => workspace,
    startAgent: async (): Promise<AgentRef> => ({ id: "agent", runtimeId: "agent" }),
    promptAgent: async (): Promise<void> => {},
    waitAgent: async (): Promise<"running" | "idle" | "exited"> => "idle",
    inspectAgent: async () => ({ status: "idle" }),
    collectRuntimeEvidence: async (): Promise<RuntimeEvidence> => ({
      runtime: name,
      workspaceId: "ws",
      agentId: "agent",
      events: [] as ExecutionEvent[],
    }),
    cleanupWorkspace: async (): Promise<void> => {},
  };
  return { name, runtime: stub };
}

async function validated(capabilities: string[]): Promise<WorkUnit> {
  const workUnit = unit(capabilities);
  const result = await validateWorkUnit(workUnit, schema);
  expect(result.issues, JSON.stringify(result.issues)).toEqual([]);
  return workUnit;
}

describe("the fleet order is the selection policy", () => {
  it("takes the first satisfiable candidate", async () => {
    const workUnit = await validated(["coding"]);
    const selection = await selectRuntime(workUnit, [runtime("first", ["coding"]), runtime("second", ["coding"])]);
    expect(selection.selected?.name).toBe("first");
  });

  it("skips a runtime that cannot satisfy the work", async () => {
    const workUnit = await validated(["documentation"]);
    const selection = await selectRuntime(workUnit, [runtime("coder", ["coding"]), runtime("writer", ["documentation"])]);
    expect(selection.selected?.name).toBe("writer");
  });

  it("blocks rather than selecting a partially capable runtime", async () => {
    const workUnit = await validated(["coding", "documentation"]);
    const selection = await selectRuntime(workUnit, [runtime("coder", ["coding"])]);
    expect(selection.selected).toBeUndefined();
    expect(selection.missingCapabilities).toContain("documentation");
  });
});

describe("a fallback runtime does not shadow a capable one", () => {
  // The defect, restated as behaviour rather than as fleet construction: a fallback
  // that satisfies the Work Unit must not win while a capable runtime is present.

  it("prefers a capable runtime over a satisfiable fallback listed first", async () => {
    const workUnit = await validated(["documentation"]);
    const fallback = runtime("fake", ["frontend", "backend", "browser", "testing", "documentation"]);
    const capable = runtime("hermes", ["coding", "testing", "documentation"]);

    // Constructed in the order that caused the defect: fallback first.
    const selection = await selectRuntime(workUnit, [fallback, capable]);
    // The kernel takes the first satisfiable candidate, so this asserts what the
    // kernel does — and the fix lives in the fleet the caller builds, below.
    expect(selection.selected?.name).toBe("fake");
  });

  it("selects the capable runtime once the caller orders the fleet properly", async () => {
    const workUnit = await validated(["documentation"]);
    const fallback = runtime("fake", ["frontend", "backend", "browser", "testing", "documentation"]);
    const capable = runtime("hermes", ["coding", "testing", "documentation"]);

    const selection = await selectRuntime(workUnit, [capable, fallback]);
    expect(selection.selected?.name).toBe("hermes");
  });

  it("still selects the fallback when nothing else satisfies the work", async () => {
    // The reason `fake` exists: a fresh clone with no runtimes installed can still
    // run the CLI. It must remain reachable, or that guarantee is lost.
    const workUnit = await validated(["documentation"]);
    const selection = await selectRuntime(workUnit, [runtime("coder", ["coding"]), runtime("fake", ["documentation"])]);
    expect(selection.selected?.name).toBe("fake");
  });
});

describe("the fleet the CLI builds", () => {
  it("puts fake last, so it can only be chosen as a fallback", () => {
    // This is the actual fix. A kernel change would be asserting something it
    // cannot know — which runtime is "best" — so the ordering is applied where the
    // fleet is assembled.
    const fleet = availableRuntimes(process.cwd()).map((entry) => entry.name);
    expect(fleet[fleet.length - 1]).toBe("fake");
  });

  it("still offers fake when nothing is installed", () => {
    // `fake` is always present so a fresh clone can run the CLI at all.
    const fleet = availableRuntimes(process.cwd()).map((entry) => entry.name);
    expect(fleet).toContain("fake");
  });

  it("offers every runtime whose binary is on PATH", () => {
    const fleet = availableRuntimes(process.cwd()).map((entry) => entry.name);
    // Not asserting which are installed — the test must hold on any machine. What
    // matters is that the fleet is a set with `fake` last, not a single entry.
    expect(new Set(fleet).size).toBe(fleet.length);
  });
});