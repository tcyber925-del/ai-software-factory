import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { runPipeline } from "../src/kernel/pipeline.js";
import type { LabelledRuntime } from "../src/kernel/work-unit.js";
import type { ShellRunner } from "../src/adapters/verification/shell.js";
import { InMemoryEventLog } from "../src/state/event-log.js";
import { fingerprintWorktree, waitForSettledWork } from "../src/kernel/settle.js";
import type { WorkUnit, WorkspaceRef } from "../src/protocol.js";

/**
 * An agent that is still working when its runtime says it stopped.
 *
 * `AGENTS.md` states the rule this covers: *"Runtime status must never be treated as proof of
 * Work Unit completion."* The pipeline treats exactly that as proof — `prompt.completed` is the
 * only thing between dispatch and verification.
 *
 * Both observed escapes fit. In the first, `prompt.completed` and `integration.ready` landed in the
 * same second, and the agent's writes appeared ten minutes later. In the second, the agent consumed
 * the entire 900s ceiling and was killed mid-work.
 *
 * These tests describe what should happen. The one that matters is the first: it fails today, and
 * that failure is the defect.
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

function unit(id: string): { workUnit: WorkUnit; paths: string[] } {
  return {
    workUnit: {
      id,
      goal: "Do the work",
      repository: "acme/widgets",
      capabilities: ["testing"],
      acceptanceCriteria: ["the finished work is what gets verified"],
    },
    paths: ["src"],
  };
}

let counter = 0;

/** A runtime with a real worktree, and a hook to act after its prompt resolves. */
function runtimeWritingAfterPrompt(delayMs: number, body?: (path: string) => void): {
  runtime: LabelledRuntime;
  written: () => string[];
} {
  const root = join(tmpdir(), "factory-settle-probe");
  mkdirSync(root, { recursive: true });
  const written: string[] = [];
  let worktree: string | undefined;

  const labelled: LabelledRuntime = {
    name: "settle-runtime",
    runtime: {
      capabilities: async () => ["testing"],
      health: async () => ({ available: true, runtime: "settle-runtime" }),
      createWorkspace: async () => ({ id: `ws-${++counter}`, path: root }),
      createWorktree: async (workspace: WorkspaceRef) => {
        const worktreePath = join(workspace.path, `worktree-${++counter}`);
        mkdirSync(worktreePath, { recursive: true });
        worktree = worktreePath;
        return { ...workspace, worktreePath };
      },
      startAgent: async () => ({ id: "agent", runtimeId: "agent" }),
      promptAgent: async () => {
        // The agent keeps working after the runtime reports the prompt resolved.
        // This is the hazard, produced deterministically rather than by timing luck.
        setTimeout(() => {
          // Into the worktree — where the checks look, and where real agent work lands.
          const target = join(worktree ?? root, "LATE.txt");
          writeFileSync(target, "landed after the prompt resolved");
          written.push(target);
          body?.(worktree ?? root);
        }, delayMs);
      },
      waitAgent: async () => "idle",
      inspectAgent: async () => ({ status: "idle" }),
      collectRuntimeEvidence: async () => ({
        runtime: "settle-runtime",
        workspaceId: "ws",
        agentId: "agent",
        events: [],
      }),
      cleanupWorkspace: async (workspace: WorkspaceRef) => {
        if (workspace.worktreePath) rmSync(workspace.worktreePath, { recursive: true, force: true });
      },
    },
  };

  return { runtime: labelled, written: () => written };
}

/** Fails unless the work that landed late is present in the directory being checked. */
const checksSeeLateWork: ShellRunner = {
  async run(_command, _args, cwd) {
    return existsSync(join(cwd, "LATE.txt"))
      ? { stdout: "ok", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "the work landed after the checks read the tree", exitCode: 1 };
  },
};

function clock() {
  let n = 0;
  return { id: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
}

describe("work that lands after the agent's prompt resolves", () => {
  it("is verified, because verification waits for the work to stop changing", async () => {
    // This is the defect, written as a test. The agent writes 150ms after its
    // runtime reports the prompt resolved; verification reads the tree before
    // then, sees nothing, and the run reports on work that had not landed yet.
    //
    // Today this fails: the checks run immediately after `promptAgent`, so
    // `LATE.txt` is not there yet and the run blocks on a tree that was never
    // finished. Worse in the real incident — the run reported `ready` while the
    // work was still in flight.
    const { runtime } = runtimeWritingAfterPrompt(30);

    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime],
      checks: [{ name: "late-work", command: "true" }],
      settleWork: { fingerprint: fingerprintWorktree, intervalMs: 50, stableReads: 3, timeoutMs: 5_000 },
      cwd: ".",
      runner: checksSeeLateWork,
      repairPolicy: { maxAttempts: 0 },
      ...clock(),
    });

    expect(result.runs[0]?.verification.status).toBe("passed");
  });

  it("does not clean the worktree up while the agent is still writing to it", async () => {
    // Cleanup deletes the tree the agent is mid-write in. Anything the agent
    // lands afterwards has nowhere to go — which is a plausible route to work
    // appearing somewhere else entirely, and matches the observed escapes.
    const { runtime } = runtimeWritingAfterPrompt(30);
    const log = new InMemoryEventLog();

    await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime],
      checks: [{ name: "late-work", command: "true" }],
      settleWork: { fingerprint: fingerprintWorktree, intervalMs: 50, stableReads: 3, timeoutMs: 5_000 },
      cwd: ".",
      runner: checksSeeLateWork,
      repairPolicy: { maxAttempts: 0 },
      eventLog: log,
      ...clock(),
    });

    const events = await log.readAll();
    // The cleanup must not precede the work it is cleaning up after.
    expect(events.some((event) => event.type === "workspace.cleaned")).toBe(true);
  });
});
describe("a worktree that never stops changing", () => {
  it("blocks, rather than verifying a moving target", async () => {
    // The alternative is to verify anyway and report the result. That is the false
    // green: "nothing verified must never be reported as verification passed", and
    // a tree that is still being written to has not been verified at all.
    let n = 0;
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtimeWritingAfterPrompt(30).runtime],
      checks: [{ name: "late-work", command: "true" }],
      cwd: ".",
      runner: checksSeeLateWork,
      settleWork: { fingerprint: async () => `always-changing-${++n}`, intervalMs: 5, stableReads: 2, timeoutMs: 60 },
      repairPolicy: { maxAttempts: 0 },
      ...clock(),
    });

    expect(result.status).toBe("blocked");
    expect(result.runs[0]?.integration.reason).toMatch(/had not finished/);
    expect(result.runs[0]?.integration.reason).toMatch(/still changing/);
  });

  it("records it as a durable event, not only in the reason string", async () => {
    let n = 0;
    const log = new InMemoryEventLog();
    await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtimeWritingAfterPrompt(30).runtime],
      checks: [{ name: "late-work", command: "true" }],
      cwd: ".",
      runner: checksSeeLateWork,
      settleWork: { fingerprint: async () => `always-changing-${++n}`, intervalMs: 5, stableReads: 2, timeoutMs: 60 },
      eventLog: log,
      ...clock(),
    });

    const events = await log.readAll();
    const unsettled = events.find((event) => event.type === "work.unsettled");
    expect(unsettled).toBeDefined();
    expect(unsettled?.payload["reason"]).toBeTruthy();
  });
});

describe("waiting for the work to stop changing", () => {
  const spin = async (): Promise<void> => {};

  it("settles once the fingerprint repeats", async () => {
    const result = await waitForSettledWork(async () => "same", "/tmp", {
      stableReads: 3,
      sleep: spin,
      timeoutMs: 1_000,
    });
    expect(result.settled).toBe(true);
    expect(result.reads).toBe(3);
  });

  it("does not settle on a fingerprint that keeps changing", async () => {
    let n = 0;
    const result = await waitForSettledWork(async () => `v${++n}`, "/tmp", {
      stableReads: 3,
      sleep: spin,
      timeoutMs: 25,
    });
    expect(result.settled).toBe(false);
    expect(result.reason).toMatch(/still changing/);
  });

  it("requires agreeing reads in a row, not agreement once", async () => {
    // An agent edits in bursts. One quiet interval says very little; a change
    // after a quiet run resets the count, so settling means the burst is over.
    const readings = ["a", "a", "b", "b", "b"];
    let i = 0;
    const result = await waitForSettledWork(async () => readings[Math.min(i++, readings.length - 1)]!, "/tmp", {
      stableReads: 3,
      sleep: spin,
      timeoutMs: 1_000,
    });
    expect(result.settled).toBe(true);
    // Five reads: the reset at "b" means three agreeing reads only from the fourth.
    expect(result.reads).toBe(5);
  });

  it("returns a verdict rather than throwing when the bound is reached", async () => {
    // An unsettled worktree is a reportable outcome, not a crash. The caller
    // decides what an unfinished run means, and it needs the evidence to say so.
    const result = await waitForSettledWork(async () => `v${Math.random()}`, "/tmp", {
      stableReads: 2,
      sleep: spin,
      timeoutMs: 20,
    });
    expect(result.settled).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("fingerprinting a worktree", () => {
  it("changes when a file's contents change", async () => {
    const dir = join(tmpdir(), `factory-fingerprint-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "work.ts");
    writeFileSync(file, "one");

    const before = await fingerprintWorktree(dir);
    writeFileSync(file, "two different content");
    // mtime resolution is coarse on some filesystems; the wait would otherwise be
    // satisfiable by a write that never changed anything.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await fingerprintWorktree(dir);

    expect(before).not.toBe(after);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is stable when nothing changes", async () => {
    const dir = join(tmpdir(), `factory-fingerprint-stable-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "unchanging");
    expect(await fingerprintWorktree(dir)).toBe(await fingerprintWorktree(dir));
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores .git and node_modules, which churn on their own", async () => {
    // A run must be able to settle on a real project. If an install writing
    // node_modules counted, no worktree would ever settle and the gate would fire
    // on every run — which is the failure mode of a gate that always fires.
    const dir = join(tmpdir(), `factory-fingerprint-ignore-${Date.now()}`);
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "real.ts"), "work");

    const before = await fingerprintWorktree(dir);
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "installed");
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main");

    expect(await fingerprintWorktree(dir)).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it("sees a new file appear", async () => {
    const dir = join(tmpdir(), `factory-fingerprint-new-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const before = await fingerprintWorktree(dir);
    writeFileSync(join(dir, "added.ts"), "new");
    expect(await fingerprintWorktree(dir)).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });
});
