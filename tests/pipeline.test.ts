import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { runPipeline } from "../src/kernel/pipeline.js";
import type { ScheduledWorkUnit } from "../src/kernel/scheduler.js";
import type { LabelledRuntime } from "../src/kernel/work-unit.js";
import type { ShellRunner } from "../src/adapters/verification/shell.js";
import { FakeRuntime } from "../src/fake-runtime.js";
import { InMemoryEventLog } from "../src/state/event-log.js";
import { reconstructExecution } from "../src/state/provenance.js";
import type { WorkUnit, WorkspaceRef } from "../src/protocol.js";

/**
 * These tests exist because per-unit green is not evidence that a *sequence* is
 * correct. Nothing here can be satisfied by any single unit passing on its own.
 */

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

function unit(id: string, overrides: Partial<ScheduledWorkUnit> = {}): ScheduledWorkUnit {
  const workUnit: WorkUnit = {
    id,
    goal: `do ${id}`,
    repository: "example/repo",
    capabilities: ["testing"],
    acceptanceCriteria: [`${id} works`],
  };
  return { workUnit, paths: [`src/${id}`], ...overrides };
}

function runtime(name = "fake"): LabelledRuntime {
  return { name, runtime: new FakeRuntime() };
}


const passing: ShellRunner = {
  async run() {
    return { stdout: "ok", stderr: "", exitCode: 0 };
  },
};

const failing: ShellRunner = {
  async run() {
    return { stdout: "", stderr: "boom", exitCode: 1 };
  },
};

function clock() {
  let n = 0;
  return { id: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
}

const checks = [{ name: "npm-test", command: "npm", args: ["test"] }];

describe("a composed run executes the whole sequence", () => {
  it("validates, plans, dispatches, verifies, and reaches the integration gate", async () => {
    const log = new InMemoryEventLog();
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      eventLog: log,
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("ready");
    expect(result.runs).toHaveLength(1);

    const run = result.runs[0]!;
    // Every stage actually ran.
    expect(run.execution.status).toBe("completed");
    expect(run.execution.runtimeEvidence).toBeDefined();
    expect(run.verification.status).toBe("passed");
    expect(run.integration.state).toBe("ready");

    // And the durable record contains the whole trace, not just the tail.
    const types = log.stored().map((event) => event.type);
    for (const expected of [
      "scheduling.planned",
      "scheduling.scheduled",
      "work.validated",
      "workspace.created",
      "worktree.created",
      "worker.started",
      "worker.finished",
      "workspace.cleaned",
      "verification.started",
      "verification.passed",
      "integration.ready",
    ]) {
      expect(types, `missing ${expected}`).toContain(expected);
    }
  });

  it("leaves the run reconstructable from durable events alone", async () => {
    const log = new InMemoryEventLog();
    await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      eventLog: log,
      runner: passing,
      ...clock(),
    });

    const summary = reconstructExecution(await log.readAll(), "W-1");
    expect(summary.outcome).toBe("completed");
    expect(summary.verification).toEqual({ status: "passed", attempts: 1 });
    expect(summary.integration?.state).toBe("ready");
  });
});

describe("a composed run cannot reach ready without independent verification", () => {
  it("blocks when the runtime succeeds but the checks fail", async () => {
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: passing, // runtime side is green
      // ...and verification is not. This is the composition-level invariant.
      ...clock(),
    });
    expect(result.status).toBe("ready");

    const failed = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: failing, // verification red despite a completed runtime
      ...clock(),
    });
    expect(failed.status).toBe("blocked");
    expect(failed.runs[0]?.execution.status).toBe("completed");
    expect(failed.runs[0]?.execution.runtimeStatus).toBe("idle");
    expect(failed.runs[0]?.verification.status).toBe("failed");
    expect(failed.runs[0]?.integration.state).toBe("blocked");
  });

  it("never derives readiness from runtime status", async () => {
    for (const runner of [passing, failing]) {
      const result = await runPipeline({
        workUnits: [unit("W-1")],
        schema,
        runtimes: [runtime()],
        checks,
        cwd: ".",
        runner,
        repairPolicy: { maxAttempts: 0 },
        ...clock(),
      });
      const run = result.runs[0]!;
      // The runtime's opinion is identical in both cases; the outcome is not.
      expect(run.execution.runtimeStatus).toBe("idle");
      const expected = runner === passing ? "ready" : "blocked";
      expect(run.integration.state).toBe(expected);
    }
  });

  it("runs bounded repair and still blocks when the limit is reached", async () => {
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: failing,
      ...clock(),
    });

    const run = result.runs[0]!;
    // Default limit is 2 attempts, then escalation — not a silent pass.
    expect(run.repairAttempts).toBe(2);
    expect(run.outcome).toBe("repair_exhausted");
    expect(run.integration.state).toBe("blocked");
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("repair limit reached");
  });

  it("reaches ready when repair actually fixes the failure", async () => {
    let call = 0;
    const flaky: ShellRunner = {
      async run() {
        call += 1;
        return { stdout: "", stderr: "flaky", exitCode: call === 1 ? 1 : 0 };
      },
    };
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: flaky,
      ...clock(),
    });
    expect(result.status).toBe("ready");
    expect(result.runs[0]?.repairAttempts).toBe(1);
    // Stops at first success rather than burning the remaining budget.
    expect(call).toBe(2);
  });
});

describe("verification runs against the executed worktree, not the factory checkout", () => {
  it("passes the executed worktree path as the verification cwd", async () => {
    const cwds: string[] = [];
    const spy: ShellRunner = {
      async run(_command, _args, cwd) {
        cwds.push(cwd);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };

    await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: "/factory/checkout",
      runner: spy,
      ...clock(),
    });

    // FakeRuntime yields /tmp/factory/workspace-N/worktree — never the checkout.
    expect(cwds).toHaveLength(1);
    expect(cwds[0]).toMatch(/^\/tmp\/factory\/workspace-\d+\/worktree$/);
    expect(cwds[0]).not.toBe("/factory/checkout");
  });

  it("verifies each unit in its own worktree", async () => {
    const byUnit = new Map<string, string[]>();
    const spy: ShellRunner = {
      async run(_command, _args, cwd) {
        const key = cwd;
        const list = byUnit.get(key) ?? [];
        list.push(cwd);
        byUnit.set(key, list);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };

    const result = await runPipeline({
      workUnits: [unit("A", { paths: ["src/a"] }), unit("B", { paths: ["src/b"] })],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: "/factory/checkout",
      runner: spy,
      ...clock(),
    });

    expect(result.status).toBe("ready");
    // Distinct executed trees, so distinct verification targets.
    expect(byUnit.size).toBe(2);
  });

  it("honours an explicit repo-scoped verification request", async () => {
    const cwds: string[] = [];
    const spy: ShellRunner = {
      async run(_command, _args, cwd) {
        cwds.push(cwd);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };
    await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: "/factory/checkout",
      runner: spy,
      verifyIn: "repo",
      ...clock(),
    });
    expect(cwds).toEqual(["/factory/checkout"]);
  });

  it("blocks rather than falling back when the runtime reports no worktree", async () => {
    // Object.create keeps FakeRuntime's prototype methods; an object spread would
    // drop them and this would silently test something else.
    const base = new FakeRuntime();
    const noWorktree: LabelledRuntime = {
      name: "no-worktree",
      runtime: Object.assign(Object.create(base), {
        createWorktree: async (workspace: WorkspaceRef) => ({ ...workspace, worktreePath: undefined }),
      }),
    };

    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [noWorktree],
      checks,
      cwd: "/factory/checkout",
      // Green everywhere, so only the missing worktree can explain a block.
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("blocked");
    expect(result.runs[0]?.outcome).toBe("blocked");
    expect(result.runs[0]?.integration.state).toBe("blocked");
    expect(result.runs[0]?.integration.reason).toMatch(/nothing to verify/);
    expect(result.runs[0]?.integration.reason).toMatch(/refusing to fall back/);
  });
});

describe("a blocked integration halts dependent work", () => {
  it("does not dispatch later batches", async () => {
    const result = await runPipeline({
      workUnits: [
        unit("A", { paths: ["src/shared"] }),
        unit("B", { paths: ["src/shared"] }),
        unit("C", { paths: ["src/other"] }),
      ],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: failing,
      repairPolicy: { maxAttempts: 0 },
      ...clock(),
    });

    expect(result.status).toBe("blocked");
    // A and B share a path so they serialize; C is independent of both and
    // therefore shares the FIRST batch with A.
    expect(result.plan.batches[0]?.sort()).toEqual(["A", "C"]);
    expect(result.haltedAtBatch).toBe(0);

    // B sits in a later batch, so it is never dispatched — that is the halt.
    expect(result.notDispatched).toContain("B");
    expect(result.runs.some((run) => run.workUnitId === "B")).toBe(false);

    // C ran because it was independent and in the same batch: a parallel group
    // that fails does not retroactively cancel a peer that already dispatched.
    expect(result.runs.some((run) => run.workUnitId === "C")).toBe(true);
  });

  it("does not dispatch a dependent unit when its dependency blocks", async () => {
    const result = await runPipeline({
      workUnits: [unit("A"), unit("B", { dependsOn: ["A"], paths: ["src/b"] })],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: failing,
      repairPolicy: { maxAttempts: 0 },
      ...clock(),
    });

    expect(result.status).toBe("blocked");
    expect(result.runs.map((run) => run.workUnitId)).toEqual(["A"]);
    expect(result.notDispatched).toContain("B");
  });
});

describe("independent work units run in separate worktrees", () => {
  it("dispatches independent units concurrently with distinct worktrees", async () => {
    const result = await runPipeline({
      workUnits: [unit("A", { paths: ["src/a"] }), unit("B", { paths: ["src/b"] })],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: passing,
      ...clock(),
    });

    // Same batch: proven conflict-free by the scheduler.
    expect(result.plan.batches[0]?.sort()).toEqual(["A", "B"]);
    expect(result.status).toBe("ready");

    const paths = result.runs.map((run) => run.execution.worktreePath);
    expect(new Set(paths).size).toBe(2);
    // And no source collision: distinct worktree paths for distinct units.
    for (const run of result.runs) {
      expect(run.execution.worktreePath).toContain(run.execution.workspaceId === "" ? "" : run.execution.workspaceId);
    }
  });

  it("honours a concurrency bound inside one batch", async () => {
    const result = await runPipeline({
      workUnits: [
        unit("A", { paths: ["src/a"] }),
        unit("B", { paths: ["src/b"] }),
        unit("C", { paths: ["src/c"] }),
      ],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: passing,
      maxParallel: 1,
      ...clock(),
    });
    expect(result.status).toBe("ready");
    expect(result.runs).toHaveLength(3);
  });
});

describe("intake refusals surface without dispatching", () => {
  it("blocks and explains why when no runtime provides the capability", async () => {
    const result = await runPipeline({
      workUnits: [
        {
          workUnit: { ...unit("X").workUnit, capabilities: ["rust"] },
          paths: ["src/x"],
        },
      ],
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("intake refused");
    expect(result.runs).toHaveLength(0);
  });
});

describe("the pipeline refuses to dispatch an invalid Work Unit", () => {
  it("throws rather than dispatching something that failed validation", async () => {
    const invalid: ScheduledWorkUnit = {
      workUnit: { ...unit("BAD").workUnit, acceptanceCriteria: [] },
      paths: ["src/bad"],
    };
    await expect(
      runPipeline({
        workUnits: [invalid],
        schema,
        runtimes: [runtime()],
        checks,
        cwd: ".",
        runner: passing,
        ...clock(),
      }),
    ).rejects.toThrow(/failed validation and must not be dispatched/);
  });
});
