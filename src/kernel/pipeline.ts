import { randomUUID } from "node:crypto";
import type { IntegrationResult, VerificationResult, WorkUnit } from "../protocol.js";
import type { ExecutionFailure, ExecutionRecord } from "./execution.js";
import { executeWorkUnit } from "./execution.js";
import { buildIntegrationResult } from "./integration.js";
import { runRepairLoop } from "./repair.js";
import type { RepairPolicy } from "./repair.js";
import { validateWorkUnit } from "./work-unit.js";
import { evaluateSecurityGate, persistSecurityDecision } from "../security/index.js";
import type { SecurityGateResult } from "../security/index.js";
import type { ExecutionRiskInput } from "../security/risk.js";
import type { LabelledRuntime } from "./work-unit.js";
import type { JsonSchema } from "./json-schema.js";
import type { PlanScheduleOptions, ScheduledWorkUnit, SchedulePlan } from "./scheduler.js";
import { planSchedule } from "./scheduler.js";
import type { ShellCheckSpec, ShellRunner } from "../adapters/verification/shell.js";
import { runShellVerification } from "../adapters/verification/shell.js";
import type { EventLog } from "../state/event-log.js";

/**
 * The composed pipeline: the factory's units running in sequence.
 *
 * This is the surface no unit test could prove. Every stage below was already
 * implemented and individually verified; what had never been exercised is that
 * they compose. Per-unit green is not evidence that the sequence is correct.
 *
 * Sequence per Work Unit:
 *
 *   validate -> plan -> select runtime -> dispatch -> verify (independent)
 *            -> repair if verification failed, bounded -> integration record
 *
 * Two invariants are enforced here rather than assumed:
 *
 * 1. **A run cannot reach `ready` without independent verification.** The
 *    integration stage consumes only a `VerificationResult` produced by
 *    `runShellVerification`. Nothing here derives readiness from runtime status.
 * 2. **A blocked integration halts dependent work.** Batches run in order, and a
 *    blocked unit stops its batch and every batch after it, because later units
 *    may depend on it.
 */

export type UnitOutcome = "ready" | "blocked" | "failed" | "repair_exhausted";

export interface UnitRun {
  workUnitId: string;
  outcome: UnitOutcome;
  execution: ExecutionRecord;
  verification: VerificationResult;
  integration: IntegrationResult;
  /** Present when verification failed at least once and repair ran. */
  repairAttempts?: number;
  repairReason?: string;
  failure?: ExecutionFailure;
}

export interface PipelineResult {
  status: "ready" | "blocked";
  reason: string;
  plan: SchedulePlan;
  runs: UnitRun[];
  /** Work Units that were never dispatched because an earlier batch blocked. */
  notDispatched: string[];
  haltedAtBatch?: number;
}

export interface RunPipelineOptions {
  workUnits: ScheduledWorkUnit[];
  schema: JsonSchema;
  runtimes: LabelledRuntime[];
  checks: ShellCheckSpec[];
  cwd: string;
  eventLog?: EventLog;
  runner?: ShellRunner;
  repairPolicy?: RepairPolicy;
  /** Bounds concurrency inside one batch. Defaults to the batch size. */
  maxParallel?: number;
  /**
   * Where the checks run. `worktree` (default) verifies the tree the runtime
   * executed; `repo` verifies `cwd` instead and exists for the case where the
   * factory is verifying its own checkout.
   */
  verifyIn?: "worktree" | "repo";
  id?: () => string;
  now?: () => string;
}

/** Resolves the checks that apply to one Work Unit, or all of them. */
function checksFor(_workUnit: WorkUnit, checks: ShellCheckSpec[]): ShellCheckSpec[] {
  return checks;
}

export async function runPipeline(options: RunPipelineOptions): Promise<PipelineResult> {
  const { schema, runtimes, cwd, eventLog } = options;
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  const planning: PlanScheduleOptions = {
    units: options.workUnits,
    runtimes,
    ...(eventLog === undefined ? {} : { eventLog }),
    runId: "plan",
  };
  const plan = await planSchedule(planning);

  const runs: UnitRun[] = [];
  const notDispatched: string[] = [];
  let haltedAtBatch: number | undefined;

  for (const [batchIndex, batch] of plan.batches.entries()) {
    const limit = options.maxParallel ?? batch.length;
    const results: UnitRun[] = [];

    // Units inside a batch were proven conflict-free by the scheduler, so they may
    // run together; the limit bounds how many do at once.
    for (let offset = 0; offset < batch.length; offset += limit) {
      const slice = batch.slice(offset, offset + limit);
      const settled = await Promise.all(
        slice.map(async (workUnitId) => {
          const scheduled = options.workUnits.find((candidate) => candidate.workUnit.id === workUnitId);
          if (scheduled === undefined) throw new Error(`scheduler produced an unknown work unit: ${workUnitId}`);
          return runOne(scheduled.workUnit, scheduled.risk, options, eventLog, id, now);
        }),
      );
      results.push(...settled);
    }

    runs.push(...results);

    const blocked = results.find((run) => run.outcome !== "ready");
    if (blocked !== undefined) {
      haltedAtBatch = batchIndex;
      notDispatched.push(
        ...plan.batches.slice(batchIndex + 1).flat().filter((pendingId) => !runs.some((run) => run.workUnitId === pendingId)),
      );
      const reason =
        blocked.outcome === "repair_exhausted"
          ? `repair limit reached for ${blocked.workUnitId}`
          : `${blocked.workUnitId} did not reach the integration gate (${blocked.integration.reason})`;
      return { status: "blocked", reason, plan, runs, notDispatched, haltedAtBatch };
    }
  }

  // A unit that was blocked at intake never dispatched; that is a blocked run,
  // not a ready pipeline.
  const intakeBlocked = plan.decisions.filter((decision) => decision.outcome === "blocked");
  if (intakeBlocked.length > 0) {
    return {
      status: "blocked",
      reason: `intake refused ${intakeBlocked.length} work unit(s): ${intakeBlocked
        .map((decision) => `${decision.workUnitId} (${decision.reason ?? "unknown"})`)
        .join(", ")}`,
      plan,
      runs,
      notDispatched,
      ...(haltedAtBatch === undefined ? {} : { haltedAtBatch }),
    };
  }

  return { status: "ready", reason: "all work units passed independent verification and the integration gate", plan, runs, notDispatched };
}

/**
 * A run that never got as far as verification, because there was nothing real to
 * verify. Built as a full `UnitRun` so callers cannot mistake it for a pass by
 * inspecting only part of the record.
 */
function blockedWithoutVerification(
  workUnit: WorkUnit,
  execution: ExecutionRecord,
  reason: string,
): UnitRun {
  const never: VerificationResult = {
    workUnitId: workUnit.id,
    status: "blocked",
    checks: [],
  };
  return {
    workUnitId: workUnit.id,
    outcome: "blocked",
    execution,
    verification: never,
    integration: {
      workUnitId: workUnit.id,
      state: "blocked",
      reason,
      verification: never,
      events: execution.events,
    },
  };
}

/**
 * A refusal by the security gate, shaped like every other `UnitRun`.
 *
 * Returned as a full record rather than a bare reason so that a caller inspecting
 * only part of the result cannot read a refusal as a pass. The runtime was never
 * invoked, so there is no execution evidence to report.
 */
function blockedBySecurityGate(
  workUnit: WorkUnit,
  runId: string,
  admission: SecurityGateResult,
): UnitRun {
  const reason = `security gate refused: ${admission.blockers.map((blocker) => blocker.reason).join("; ")}`;
  const verification: VerificationResult = {
    workUnitId: workUnit.id,
    status: "blocked",
    checks: [],
  };
  return {
    workUnitId: workUnit.id,
    outcome: "blocked",
    execution: {
      workUnitId: workUnit.id,
      status: "blocked",
      events: [],
      failure: "blocked",
    },
    verification,
    integration: {
      workUnitId: workUnit.id,
      state: "blocked",
      reason,
      verification,
      events: [],
    },
  };
}

/** One Work Unit through the whole sequence. */
async function runOne(
  workUnit: WorkUnit,
  risk: ExecutionRiskInput | undefined,
  options: RunPipelineOptions,
  eventLog: EventLog | undefined,
  id: () => string,
  now: () => string,
): Promise<UnitRun> {
  const { schema, runtimes, cwd } = options;

  // Defence in depth: executeWorkUnit also validates, but refusing here means an
  // invalid Work Unit never reaches a runtime even if that guard is bypassed.
  const validation = validateWorkUnit(workUnit, schema);
  if (!validation.valid) {
    throw new Error(
      `work unit ${workUnit.id} failed validation and must not be dispatched: ${validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  }

  const runId = `run-${workUnit.id}-${randomUUID().slice(0, 8)}`;

  /**
   * Security gate — evaluated *before* anything is dispatched.
   *
   * Ordering is the whole point. A refusal after the runtime has been invoked and a
   * worktree created would be a refusal of the consequences, not of the work.
   *
   * `providedIsolation` is `git_worktree` because that is what the dispatch path
   * provides: `executeWorkUnit` creates a worktree before it starts an agent and
   * refuses to start one without. Passing `none` here would be the tempting mistake
   * — `adequate` would be false for *every* Work Unit, including trusted ones, and
   * the gate would refuse all work rather than the risky work.
   */
  const admission = evaluateSecurityGate({
    workUnitId: workUnit.id,
    risk: risk ?? {},
    providedIsolation: "git_worktree",
    targetBranch: workUnit.baseRevision ?? "HEAD",
    writeMode: "pull_request",
  });
  if (eventLog !== undefined) {
    // Each decision is persisted individually, because a gate returns several and
    // an audit that recorded only "the result" could not say which control fired.
    for (const decision of admission.decisions) {
      await persistSecurityDecision(decision, { eventLog, runId, workUnitId: workUnit.id, now });
    }
  }
  if (!admission.admitted) {
    return blockedBySecurityGate(workUnit, runId, admission);
  }

  const base = {
    schema,
    runtimes,
    ...(eventLog === undefined ? {} : { eventLog }),
    runId,
    id,
    now,
  };

  let execution = await executeWorkUnit({
    ...base,
    workUnit,
    worker: { id: `worker-${workUnit.id}`, capabilities: workUnit.capabilities, runtime: options.runtimes[0]?.name ?? "unknown" },
    prompt: workUnit.goal,
    runtimes,
  });

  /**
   * Verification runs against the tree that was actually executed.
   *
   * This is the second invariant composition puts at risk. Verifying the factory's
   * own checkout would let a runtime write anywhere and still pass — the checks
   * would never look at the work. So the executed worktree is the default target,
   * and `verifyIn: "repo"` must be asked for explicitly.
   *
   * A runtime that reports no worktree cannot have its work verified; that is a
   * blocked run, not a pass.
   */
  const verifyIn = options.verifyIn ?? "worktree";
  const executedPath = execution.worktreePath;
  const verificationCwd = verifyIn === "repo" ? cwd : executedPath;
  if (verifyIn === "worktree" && executedPath === undefined) {
    return blockedWithoutVerification(
      workUnit,
      execution,
      `runtime '${execution.runtime ?? "unknown"}' reported no worktree, so there is nothing to verify; refusing to fall back to the factory checkout`,
    );
  }

  let verification = await verifyAttempt(1);
  let repairAttempts: number | undefined;
  let repairReason: string | undefined;

  if (verification.status !== "passed") {
    const repair = await runRepairLoop({
      workUnit,
      initialVerification: verification,
      ...(options.repairPolicy === undefined ? {} : { policy: options.repairPolicy }),
      runId,
      ...(eventLog === undefined ? {} : { eventLog, parentRunId: runId }),
      id,
      now,
      execute: async (prompt, attempt) => {
        execution = await executeWorkUnit({
          ...base,
          workUnit,
          worker: { id: `worker-${workUnit.id}`, capabilities: workUnit.capabilities, runtime: options.runtimes[0]?.name ?? "unknown" },
          prompt,
          runtimes,
        });
        return execution;
      },
      verify: async (attempt) => verifyAttempt(attempt),
    });
    verification = repair.finalVerification;
    repairAttempts = repair.attempts.length;
    repairReason = repair.reason;
  }

  async function verifyAttempt(attempt: number): Promise<VerificationResult> {
    // A repair attempt may have produced a new worktree, so the target is read
    // at call time rather than captured before the first attempt.
    const target = verifyIn === "repo" ? cwd : execution.worktreePath;
    if (target === undefined) {
      throw new Error(
        `work unit ${workUnit.id} has no worktree to verify; the runtime reported none after execution`,
      );
    }
    const output = await runShellVerification({
      workUnitId: workUnit.id,
      checks: checksFor(workUnit, options.checks),
      cwd: target,
      attempt,
      runId,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(eventLog === undefined ? {} : { eventLog }),
      id,
      now,
    });
    return output.result;
  }

  const integrationOutcome = await buildIntegrationResult({
    execution,
    verification,
    runId,
    ...(eventLog === undefined ? {} : { eventLog }),
    id,
    now,
  });

  // Outcome is derived from the integration record — never from runtime status.
  const outcome: UnitOutcome =
    integrationOutcome.result.state === "ready"
      ? "ready"
      : execution.status === "blocked"
        ? "blocked"
        : execution.status === "failed"
          ? "failed"
          : repairAttempts !== undefined && repairReason?.startsWith("repair_limit_reached") === true
            ? "repair_exhausted"
            : "blocked";

  const run: UnitRun = {
    workUnitId: workUnit.id,
    outcome,
    execution,
    verification,
    integration: integrationOutcome.result,
  };
  if (repairAttempts !== undefined) run.repairAttempts = repairAttempts;
  if (repairReason !== undefined) run.repairReason = repairReason;
  if (execution.failure !== undefined) run.failure = execution.failure;
  return run;
}
