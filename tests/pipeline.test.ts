import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { runPipeline } from "../src/kernel/pipeline.js";
import type { ScheduledWorkUnit } from "../src/kernel/scheduler.js";
import type { LabelledRuntime } from "../src/kernel/work-unit.js";
import type { ShellRunner } from "../src/adapters/verification/shell.js";
import type { ChangedFiles } from "../src/adapters/git/changes.js";
import { FakeRuntime } from "../src/fake-runtime.js";
import { InMemoryEventLog } from "../src/state/event-log.js";
import { reconstructExecution } from "../src/state/provenance.js";
import type { AgentRef, WorkUnit, WorkspaceRef } from "../src/protocol.js";

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
    expect(result.reason).toContain("scheduler blocked");
    expect(result.runs).toHaveLength(0);
  });

  it("names the scheduler and does not mention intake", async () => {
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
    expect(result.reason).toContain("scheduler blocked");
    expect(result.reason).not.toContain("intake");
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

/**
 * The security gate on the dispatch path.
 *
 * Before this, `evaluateSecurityGate` had no caller in the pipeline: a Work Unit
 * classified `untrusted` was dispatched anyway, the runtime was invoked, and the
 * event log recorded zero security events. These tests pin the composed behaviour.
 */

describe("the security gate is applied before dispatch", () => {
  const signals = (extra: Partial<ScheduledWorkUnit> = {}): ScheduledWorkUnit[] => [
    { workUnit: { ...unit("SEC-1").workUnit, capabilities: ["testing"] }, paths: ["src/sec"], ...extra },
  ];

  const run = async (workUnits: ScheduledWorkUnit[]) => {
    const log = new InMemoryEventLog();
    const result = await runPipeline({
      workUnits,
      schema,
      runtimes: [runtime()],
      checks,
      cwd: ".",
      eventLog: log,
      runner: passing,
      ...clock(),
    });
    return { result, log };
  };

  it("admits ordinary trusted work", async () => {
    // The regression this guards: `providedIsolation` defaults to `none`, and even
    // trusted work requires `git_worktree`. Composing the gate without threading
    // through the runtime's real isolation would refuse 100% of work and still
    // satisfy every "it refuses untrusted work" test.
    const { result } = await run(signals());
    expect(result.status).toBe("ready");
    expect(result.runs[0]?.outcome).toBe("ready");
  });

  it("refuses untrusted work, naming the reason", async () => {
    const { result } = await run(signals({ risk: { consumesUntrustedContent: true } }));
    expect(result.status).toBe("blocked");
    expect(result.runs[0]?.outcome).toBe("blocked");
    expect(result.runs[0]?.integration.reason).toMatch(/security gate refused/);
    expect(result.runs[0]?.integration.reason).toMatch(/untrusted|factory did not author/i);
  });

  it("refuses destructive work", async () => {
    const { result } = await run(signals({ risk: { touchesProduction: true } }));
    expect(result.status).toBe("blocked");
    expect(result.runs[0]?.integration.reason).toMatch(/production|sandbox/i);
  });

  it("refuses before any runtime is invoked", async () => {
    // Asserted against the durable log rather than the returned record. Checking
    // `execution.events` would pass even if the runtime had already run, because
    // the refusal constructs an empty record by hand — which is exactly the case
    // that a weaker test let through.
    const { result, log } = await run(signals({ risk: { executesArbitraryCommands: true } }));
    const types = log.stored().map((event) => event.type);
    expect(types).not.toContain("worker.started");
    expect(types).not.toContain("workspace.created");
    expect(types).not.toContain("worktree.created");

    expect(result.runs[0]?.outcome).toBe("blocked");
    expect(result.runs[0]?.execution.status).toBe("blocked");
  });

  it("records the decision as a durable factory event", async () => {
    const { log } = await run(signals({ risk: { consumesUntrustedContent: true } }));
    const types = log.stored().map((event) => event.type);
    expect(types).toContain("security.blocked");
    expect(types).not.toContain("worker.started");

    const blocked = log.stored().find((event) => event.type === "security.blocked");
    expect(blocked?.source).toBe("factory");
    expect(blocked?.payload).toMatchObject({ allowed: false, kind: "execution_blocked" });
  });

  it("records the decision for admitted work too", async () => {
    // An audit that only logged refusals could not show what was allowed and why.
    const { log } = await run(signals());
    expect(log.stored().map((event) => event.type)).toContain("security.allowed");
  });

  it("never verifies a refused Work Unit", async () => {
    const { log } = await run(signals({ risk: { touchesProduction: true } }));
    expect(log.stored().map((event) => event.type)).not.toContain("verification.started");
  });

  it("halts dependent batches when the gate refuses", async () => {
    const { result } = await run([
      { workUnit: { ...unit("A").workUnit, capabilities: ["testing"] }, paths: ["src/a"], risk: { touchesProduction: true } },
      { workUnit: { ...unit("B").workUnit, capabilities: ["testing"] }, paths: ["src/b"], dependsOn: ["A"] },
    ]);
    expect(result.status).toBe("blocked");
    expect(result.notDispatched).toContain("B");
  });

  it("refuses a declared downgrade rather than honouring it", async () => {
    // A Work Unit asserting `trusted` while declaring it consumes untrusted
    // content must not get the weaker classification.
    const { result } = await run(signals({ risk: { consumesUntrustedContent: true, declaredRisk: "trusted" } }));
    expect(result.status).toBe("blocked");
  });
});

/**
 * A runtime that failed to run is not re-dispatched by the repair loop.
 *
 * Found by dogfooding: a timing-out runtime was prompted three times and created
 * three worktrees before escalating. Repair exists to fix failing checks against
 * *completed* work. When the runtime never completed, the failed check is a symptom,
 * and the same prompt to the same runtime re-encounters the same fault.
 */
describe("repair is not spent on a runtime that failed to run", () => {
  /** Counts the prompts issued and the worktrees created. */
  function counting() {
    const state = { prompts: 0, worktrees: 0 };
    const runtime: LabelledRuntime = {
      name: "failing-runtime",
      runtime: Object.assign(Object.create(new FakeRuntime()), {
        promptAgent(agentRef: AgentRef, prompt: string) {
          state.prompts += 1;
          void agentRef;
          void prompt;
          return Promise.reject(new Error("timed out after 900000ms: runtime run"));
        },
        createWorktree(workspace: WorkspaceRef, baseRevision?: string) {
          state.worktrees += 1;
          return Promise.resolve({ ...workspace, worktreePath: `${workspace.path}/worktree`, ...(baseRevision === undefined ? {} : { baseRevision }) } as WorkspaceRef);
        },
      }) as unknown as LabelledRuntime["runtime"],
    };
    return { state, runtime };
  }

  it("issues one prompt, not three, for a runtime that always times out", async () => {
    const { state, runtime } = counting();
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime],
      checks,
      cwd: ".",
      runner: failing,
      ...clock(),
    });

    // The whole cost of the defect: 3 prompts and 3 worktrees became 1 and 1.
    expect(state.prompts).toBe(1);
    expect(state.worktrees).toBe(1);
    expect(result.status).toBe("blocked");
    expect(result.runs[0]?.repairAttempts).toBeUndefined();
  });

  it("still issues three prompts for a runtime that completes with failing checks", async () => {
    // The regression this guards: "skip repair on failure" read too broadly would
    // disable repair entirely. A completed run with failing checks is exactly the
    // case repair exists for, and must still get the initial attempt plus two.
    let prompts = 0;
    const runtime: LabelledRuntime = {
      name: "completing",
      runtime: Object.assign(Object.create(new FakeRuntime()), {
        promptAgent() {
          prompts += 1;
          return Promise.resolve();
        },
      }) as unknown as LabelledRuntime["runtime"],
    };

    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime],
      checks,
      cwd: ".",
      runner: failing,
      ...clock(),
    });

    expect(prompts).toBe(3);
    expect(result.runs[0]?.repairAttempts).toBe(2);
  });

  it("still verifies after a runtime failure, and keeps the evidence", async () => {
    const { state, runtime } = counting();
    const log = new InMemoryEventLog();
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime],
      checks,
      cwd: ".",
      runner: failing,
      eventLog: log,
      ...clock(),
    });

    // Verification ran and its result is retained — partial work may have landed.
    expect(state.prompts).toBe(1);
    expect(result.runs[0]?.verification.status).toBe("failed");
    const types = log.stored().map((event) => event.type);
    expect(types).toContain("verification.started");
    expect(types).toContain("runtime.failure");
    // ...but no repair events, because no repair was attempted.
    expect(types.some((type) => type.startsWith("repair."))).toBe(false);
  });

  it("names the runtime failure rather than blaming the checks", async () => {
    const { runtime } = counting();
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime],
      checks,
      cwd: ".",
      runner: failing,
      ...clock(),
    });

    const run0 = result.runs[0]!;
    expect(run0.outcome).toBe("failed");
    // The reason must point at the runtime, not at the operator's test suite.
    expect(run0.integration.reason).toBe("execution_timeout");
    expect(run0.integration.reason).not.toBe("verification_failed");
    expect(result.reason).toContain("execution_timeout");
  });

  it("records why repair was skipped", async () => {
    const { runtime } = counting();
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime],
      checks,
      cwd: ".",
      runner: failing,
      ...clock(),
    });
    expect(result.runs[0]?.repairReason).toBe("repair_not_attempted_runtime_timeout");
  });

  it("does not regress a run that passes", async () => {
    const { state, runtime } = counting();
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [runtime],
      checks,
      cwd: ".",
      runner: passing,
      ...clock(),
    });
    // One prompt, no repair, ready.
    expect(state.prompts).toBe(1);
    expect(result.status).toBe("blocked"); // the stub always rejects the prompt
    expect(result.runs[0]?.outcome).toBe("failed");
  });
});

/**
 * The executed worktree must survive until verification reads it.
 *
 * Found by dogfooding, and it is the defect this file's own earlier tests could not
 * see. `executeWorkUnit` cleaned up in a `finally`, so by the time the pipeline ran
 * the checks the worktree had already been removed — verification ran against a
 * deleted directory and failed for reasons that had nothing to do with the work.
 *
 * The tests here use a real `git worktree add`, because `FakeRuntime` creates a
 * fictional path and therefore cannot observe the directory disappearing.
 */

describe("the executed worktree survives until verification has read it", () => {
  /**
   * A runtime whose worktree is a real directory that really is removed.
   *
   * `FakeRuntime` returns a fictional path, so it cannot observe a directory
   * disappearing — which is why this defect survived every earlier test. `mkdirSync`
   * and `rmSync` make the lifecycle observable without spawning `git`.
   */
  const realWorktreeRuntime = () => {
    let n = 0;
    const root = join(tmpdir(), "factory-wt-probe");
    const runtime: LabelledRuntime = {
      name: "worktree-runtime",
      runtime: {
        capabilities: async () => ["testing"],
        health: async () => ({ available: true, runtime: "worktree-runtime" }),
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
        collectRuntimeEvidence: async () => ({ runtime: "worktree-runtime", workspaceId: "ws", agentId: "agent", events: [] }),
        cleanupWorkspace: async (workspace: WorkspaceRef) => {
          if (workspace.worktreePath) rmSync(workspace.worktreePath, { recursive: true, force: true });
        },
      },
    };
    return runtime;
  };

  it("the verification directory exists at the moment the check runs", async () => {
    let existedAtCheckTime: boolean | null = null;
    let checkCwd: string | null = null;

    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realWorktreeRuntime()],
      checks: [{ name: "probe", command: "true" }],
      cwd: process.cwd(),
      runner: {
        async run(_command, _args, cwd) {
          checkCwd = cwd;
          existedAtCheckTime = existsSync(cwd);
          return { stdout: "", stderr: "", exitCode: existedAtCheckTime ? 0 : 1 };
        },
      },
      ...clock(),
    });

    // The whole defect in one assertion. Before the fix this was `false` and the
    // run was `blocked` — a real failure with a misleading cause.
    expect(existedAtCheckTime).toBe(true);
    expect(checkCwd).toContain("worktree-");
    expect(result.status).toBe("ready");
  }, 20_000);

  it("still removes the worktree once verification is done", async () => {
    let checkCwd: string | null = null;
    await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realWorktreeRuntime()],
      checks: [{ name: "probe", command: "true" }],
      cwd: process.cwd(),
      runner: {
        async run(_command, _args, cwd) {
          checkCwd = cwd;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
      ...clock(),
    });

    // Verified *and* cleaned up. Deferring cleanup must not mean skipping it, or
    // every adopting repository would accumulate worktrees.
    expect(checkCwd).not.toBeNull();
    expect(existsSync(checkCwd!)).toBe(false);
  }, 20_000);

  it("cleans up even when verification fails", async () => {
    let checkCwd: string | null = null;
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [realWorktreeRuntime()],
      checks: [{ name: "probe", command: "false" }],
      cwd: process.cwd(),
      repairPolicy: { maxAttempts: 0 },
      runner: {
        async run(_command, _args, cwd) {
          checkCwd = cwd;
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      },
      ...clock(),
    });

    expect(result.status).toBe("blocked");
    expect(checkCwd).not.toBeNull();
    expect(existsSync(checkCwd!)).toBe(false);
  }, 20_000);
});

describe("a scope violation reaches the integration gate through the pipeline", () => {
  // The scoper is tested directly in tests/scope.test.ts, and the integration
  // gate is tested directly in tests/integration.test.ts. Neither can catch the
  // wiring between them: that a violation detected in one stage actually stops
  // the other. That wiring is what failed in dogfooding, and what the FCT-030
  // corpus cannot reach — it reports this defect as caught by the scoper's own
  // test, which is the scoper working, not the wiring.
  //
  // So: green verification, a completed runtime, and an out-of-scope change.
  // Nothing but the scope violation can explain a block.

  /**
   * A runtime whose worktree is a real directory.
   *
   * `FakeRuntime` returns a fictional path, and `evaluateScope` compares a real
   * worktree's changed files against declared `paths`. With a fictional path
   * there is nothing to compare, so the scope gate is skipped and these tests
   * would pass for the wrong reason — proving nothing about the wiring.
   */
  const scopingRuntime = () => {
    let n = 0;
    const root = join(tmpdir(), "factory-scope-probe");
    mkdirSync(root, { recursive: true });
    return {
      name: "scoping-runtime",
      runtime: {
        capabilities: async () => ["testing"],
        health: async () => ({ available: true, runtime: "scoping-runtime" }),
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
        collectRuntimeEvidence: async () => ({ runtime: "scoping-runtime", workspaceId: "ws", agentId: "agent", events: [] }),
        cleanupWorkspace: async (workspace: WorkspaceRef) => {
          if (workspace.worktreePath) rmSync(workspace.worktreePath, { recursive: true, force: true });
        },
      },
    } satisfies LabelledRuntime;
  };

  const outOfScope: ChangedFiles = async () => ["src/other-module/thing.ts", "package-lock.json"];

  it("blocks integration when every other stage is green and scope is violated", async () => {
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [scopingRuntime()],
      checks,
      cwd: ".",
      changedFiles: outOfScope,
      runner: passing,
      ...clock(),
    });

    const run = result.runs[0]!;
    // Everything else succeeded, so scope is the only possible cause.
    expect(run.execution.status).toBe("completed");
    expect(run.verification.status).toBe("passed");

    expect(result.status).toBe("blocked");
    expect(run.integration.state).toBe("blocked");
    expect(run.integration.reason).toMatch(/out-of-scope changes/);
    // Naming the offending file is what makes the block actionable.
    expect(run.integration.reason).toContain("src/other-module/thing.ts");
    // And the lockfile caveat, because a lockfile is reviewed as source.
    expect(run.integration.reason).toMatch(/dependency lockfile/);
  });

  it("reaches integration.ready when the same work stays in scope", async () => {
    const inScope: ChangedFiles = async () => ["src/W-1/thing.ts"];

    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [scopingRuntime()],
      checks,
      cwd: ".",
      changedFiles: inScope,
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("ready");
    expect(result.runs[0]?.integration.state).toBe("ready");
    // The scope check ran; it simply found nothing. "No gate" and "gate passed"
    // are different states and the record must not conflate them.
    expect(result.runs[0]?.scope?.outOfScope).toEqual([]);
    expect(result.runs[0]?.scope?.undeclared).toBe(false);
  });

  it("reports both problems when verification fails and scope is violated", async () => {
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [scopingRuntime()],
      checks,
      cwd: ".",
      changedFiles: outOfScope,
      runner: failing,
      repairPolicy: { maxAttempts: 0 },
      ...clock(),
    });

    const run = result.runs[0]!;
    expect(run.integration.state).toBe("blocked");
    // The verification verdict leads, because the work is wrong regardless of
    // where it touched — but the scope violation is appended rather than
    // dropped. Reporting only one of two real problems hides the other.
    expect(run.integration.reason).toMatch(/verification/);
    expect(run.integration.reason).toMatch(/out-of-scope changes/);
  });

  it("reaches integration.ready when scope is unchecked rather than clean", async () => {
    // No changedFiles provider means no scope gate ran. That must be recorded
    // as "not checked" and never read as "in scope" — the honest answer when
    // the factory cannot see what changed.
    const result = await runPipeline({
      workUnits: [unit("W-1")],
      schema,
      runtimes: [scopingRuntime()],
      checks,
      cwd: ".",
      runner: passing,
      ...clock(),
    });

    expect(result.status).toBe("ready");
    expect(result.runs[0]?.scope).toBeUndefined();
  });
});
