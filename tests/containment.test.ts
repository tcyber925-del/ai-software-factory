import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { runPipeline } from "../src/kernel/pipeline.js";
import type { LabelledRuntime } from "../src/kernel/work-unit.js";
import type { ShellRunner } from "../src/adapters/verification/shell.js";
import { FakeRuntime } from "../src/fake-runtime.js";
import { InMemoryEventLog } from "../src/state/event-log.js";
import {
  detectContainmentBreach,
  describeContainmentBreach,
  isFactoryOwned,
} from "../src/kernel/containment.js";
import type { RepoSnapshot } from "../src/kernel/containment.js";
import type { ChangedFiles } from "../src/adapters/git/changes.js";
import type { WorkUnit, WorkspaceRef } from "../src/protocol.js";

/**
 * A dispatched agent that leaves its worktree leaves it clean, so the scope gate
 * reads an empty diff and reports no violation. That is how a run reached `ready`
 * while an agent edited the main checkout — two of the files it touched were
 * outside its declared `paths`, and nothing noticed.
 *
 * These tests cover the check that closes it, and — as much as the behaviour —
 * the ways it must *not* fire, because a containment gate that trips on ordinary
 * state is a gate an operator learns to ignore.
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

/** A plan entry — `{ workUnit, … }` — because that is what the pipeline reads. */
function unit(id: string): { workUnit: WorkUnit; paths: string[] } {
  return {
    workUnit: {
      id,
      goal: "Prove containment",
      repository: "acme/widgets",
      capabilities: ["testing"],
      acceptanceCriteria: ["the run does not report ready after a breach"],
    },
    paths: ["docs/cli.md", "tests/documentation.test.ts"],
  };
}

/**
 * A runtime whose worktree is a real directory.
 *
 * `FakeRuntime` returns a fictional path, so verification has nothing to run
 * against, fails, and the run blocks for reasons that have nothing to do with
 * containment — which would make every test here pass for the wrong reason.
 */
function realTreeRuntime(): LabelledRuntime {
  let n = 0;
  const root = join(tmpdir(), "factory-containment-probe");
  mkdirSync(root, { recursive: true });
  return {
    name: "containment-runtime",
    runtime: {
      capabilities: async () => ["testing"],
      health: async () => ({ available: true, runtime: "containment-runtime" }),
      createWorkspace: async () => ({ id: `ws-${++n}`, path: root }),
      createWorktree: async (workspace: WorkspaceRef) => {
        const worktreePath = join(workspace.path, `worktree-${++n}`);
        mkdirSync(worktreePath, { recursive: true });
        return { ...workspace, worktreePath };
      },
      startAgent: async () => ({ id: "agent", runtimeId: "agent" }),
      promptAgent: async () => {},
      waitAgent: async () => "idle",
      inspectAgent: async () => ({ status: "idle" }),
      collectRuntimeEvidence: async () => ({
        runtime: "containment-runtime",
        workspaceId: "ws",
        agentId: "agent",
        events: [],
      }),
      cleanupWorkspace: async (workspace: WorkspaceRef) => {
        if (workspace.worktreePath) rmSync(workspace.worktreePath, { recursive: true, force: true });
      },
    },
  };
}

const passing: ShellRunner = {
  async run() {
    return { stdout: "ok", stderr: "", exitCode: 0 };
  },
};

const checks = [{ name: "probe", command: "true" }];

function clock() {
  let n = 0;
  return { id: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
}

const clean: RepoSnapshot = { head: "aaaaaaa", dirty: [] };

/** Returns `before` on the first call and `after` on every later one. */
function snapshots(before: RepoSnapshot, after: RepoSnapshot) {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1 ? before : after;
  };
}

describe("a containment breach is detected from two root snapshots", () => {
  it("reports files that appeared in the root checkout", () => {
    const breach = detectContainmentBreach(clean, {
      head: "aaaaaaa",
      dirty: ["docs/adoption.md", "docs/cli.md"],
    });
    expect(breach?.kind).toBe("files_appeared");
    expect(breach?.files).toEqual(["docs/adoption.md", "docs/cli.md"]);
  });

  it("reports a checkout that moved even when no file changed", () => {
    // The observed breach did exactly this: the agent created a branch and
    // `git status` never mentioned it. Comparing only files misses it entirely.
    const breach = detectContainmentBreach(clean, { head: "bbbbbbb", dirty: [] });
    expect(breach?.kind).toBe("head_moved");
    expect(breach?.headBefore).toBe("aaaaaaa");
    expect(breach?.headAfter).toBe("bbbbbbb");
  });

  it("keeps the files when a checkout both moved and was written to", () => {
    const breach = detectContainmentBreach(clean, { head: "bbbbbbb", dirty: ["src/x.ts"] });
    expect(breach?.kind).toBe("head_moved");
    expect(breach?.files).toEqual(["src/x.ts"]);
    expect(describeContainmentBreach(breach!)).toContain("src/x.ts");
  });

  it("finds nothing when the root is untouched", () => {
    expect(detectContainmentBreach(clean, clean)).toBeUndefined();
  });

  it("does not report files that were already dirty before the run", () => {
    // An operator working in the checkout is the normal case, not a breach.
    const before: RepoSnapshot = { head: "aaaaaaa", dirty: ["notes.md"] };
    expect(detectContainmentBreach(before, before)).toBeUndefined();
  });

  it("does not report files that disappeared", () => {
    expect(detectContainmentBreach({ head: "aaaaaaa", dirty: ["tmp.ts"] }, clean)).toBeUndefined();
  });

  it("does not report the factory's own workspaces", () => {
    // A run creates `.factory/workspaces/<id>/` in the very directory being
    // watched. Without this exemption the gate fires on every single run, and a
    // gate that always fires is one nobody reads.
    expect(isFactoryOwned(".factory/workspaces/opencode-ws-1/worktree")).toBe(true);
    const breach = detectContainmentBreach(clean, {
      head: "aaaaaaa",
      dirty: [".factory/workspaces/opencode-ws-1/worktree"],
    });
    expect(breach).toBeUndefined();
  });

  it("does not extend the exemption to lookalike paths", () => {
    expect(isFactoryOwned(".factory/workspacesX/thing.ts")).toBe(false);
    expect(isFactoryOwned("docs/.factory/workspaces/thing.ts")).toBe(false);
  });

  it("names the files in the reason, so the report is actionable", () => {
    const breach = detectContainmentBreach(clean, { head: "aaaaaaa", dirty: ["docs/cli.md"] })!;
    expect(describeContainmentBreach(breach)).toContain("docs/cli.md");
    expect(describeContainmentBreach(breach)).toMatch(/outside its worktree/);
  });
});

describe("a breach stops the run reaching ready", () => {
  // Every case below is green everywhere else: verification passes, the runtime
  // completes, and the worktree holds nothing out of scope. Nothing but the
  // breach can explain the block, which is what makes these tests about
  // containment rather than about coincidence.

  const inScope: ChangedFiles = async () => [];

  it("blocks when the agent wrote outside its worktree", async () => {
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realTreeRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      repoSnapshot: snapshots(clean, { head: "aaaaaaa", dirty: ["docs/adoption.md"] }),
      runner: passing,
      ...clock(),
    });

    const run = result.runs[0]!;
    expect(run.verification.status).toBe("passed");
    expect(result.status).toBe("blocked");
    expect(run.integration.state).toBe("blocked");
    expect(run.integration.reason).toMatch(/containment breach/);
    expect(run.integration.reason).toContain("docs/adoption.md");
  });

  it("blocks when only the checkout moved", async () => {
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realTreeRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      repoSnapshot: snapshots(clean, { head: "bbbbbbb", dirty: [] }),
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("blocked");
    expect(result.runs[0]?.integration.reason).toMatch(/containment breach/);
    expect(result.runs[0]?.integration.reason).toMatch(/moved from aaaaaaa to bbbbbbb/);
  });

  it("records the breach as a durable event", async () => {
    const log = new InMemoryEventLog();
    await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realTreeRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      repoSnapshot: snapshots(clean, { head: "aaaaaaa", dirty: ["docs/cli.md"] }),
      runner: passing,
      eventLog: log,
      ...clock(),
    });

    const events = await log.readAll();
    const breach = events.find((event) => event.type === "containment.breached");
    expect(breach).toBeDefined();
    expect(breach?.payload["files"]).toEqual(["docs/cli.md"]);
  });

  it("reaches ready when the root is untouched", async () => {
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realTreeRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      repoSnapshot: snapshots(clean, clean),
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("ready");
    expect(result.runs[0]?.integration.state).toBe("ready");
  });

  it("still reaches ready when the root already had uncommitted work", async () => {
    // A dirty checkout is what a person is normally looking at. Reporting that as
    // a breach would make the gate unusable on the repos it matters most.
    const dirty: RepoSnapshot = { head: "aaaaaaa", dirty: ["src/in-progress.ts"] };
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realTreeRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      repoSnapshot: snapshots(dirty, dirty),
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("ready");
  });

  it("does not fire on the factory's own workspace directories", async () => {
    const after: RepoSnapshot = {
      head: "aaaaaaa",
      dirty: [".factory/workspaces/opencode-ws-1/worktree"],
    };
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realTreeRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      repoSnapshot: snapshots(clean, after),
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("ready");
  });

  it("records a breach even when the checks also failed, and leads with it", async () => {
    // Containment first: the worktree this run verified is not the tree the work
    // landed in, so the verification verdict describes the wrong tree.
    const failing: ShellRunner = {
      async run() {
        return { stdout: "", stderr: "boom", exitCode: 1 };
      },
    };
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realTreeRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      repoSnapshot: snapshots(clean, { head: "aaaaaaa", dirty: ["src/x.ts"] }),
      runner: failing,
      repairPolicy: { maxAttempts: 0 },
      ...clock(),
    });

    const reason = result.runs[0]?.integration.reason ?? "";
    expect(reason).toMatch(/containment breach/);
    expect(reason).toMatch(/verification/);
    expect(reason.indexOf("containment breach")).toBeLessThan(reason.indexOf("verification"));
  });

  it("reports no breach when no provider is supplied", async () => {
    // Omitted means no gate. That is a visible absence, never a silent pass —
    // which is why the default `ChangedFiles` provider is also opt-in.
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realTreeRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("ready");
  });
});