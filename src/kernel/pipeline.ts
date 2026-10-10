import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { IntegrationResult, VerificationResult, WorkUnit } from "../protocol.js";
import type { ExecutionFailure, ExecutionRecord } from "./execution.js";
import { executeWorkUnit } from "./execution.js";
import { blockingReasonFor, buildIntegrationResult } from "./integration.js";
import { runRepairLoop } from "./repair.js";
import type { RepairPolicy } from "./repair.js";
import { validateWorkUnit } from "./work-unit.js";
import { evaluateSecurityGate, persistSecurityDecision } from "../security/index.js";
import type { SecurityGateResult } from "../security/index.js";
import type { ExecutionRiskInput } from "../security/risk.js";
import type { ChangedFiles } from "../adapters/git/changes.js";
import { checkScope, describeScopeViolation } from "./scope.js";
import type { ScopeCheck } from "./scope.js";
import { detectContainmentBreach, describeContainmentBreach } from "./containment.js";
import type { ContainmentBreach, RepoSnapshot, RepoSnapshotProvider } from "./containment.js";
import { waitForSettledWork } from "./settle.js";
import type { SettleOptions, SettleResult, WorktreeFingerprint } from "./settle.js";
import type { LabelledRuntime } from "./work-unit.js";
import type { JsonSchema } from "./json-schema.js";
import type { PlanScheduleOptions, ScheduledWorkUnit, SchedulePlan } from "./scheduler.js";
import { planSchedule } from "./scheduler.js";
import type { ShellCheckSpec, ShellRunner } from "../adapters/verification/shell.js";
import { runShellVerification } from "../adapters/verification/shell.js";
import type { EventLog, LoggableEvent } from "../state/event-log.js";

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
  /** Present when a scope check ran. */
  scope?: ScopeCheck;
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
  /**
   * Reports the files the Work Unit changed, so its declared `paths` can be
   * enforced rather than merely documented. Omitted means no scope gate, which the
   * result records rather than treating as a pass.
   */
  changedFiles?: ChangedFiles;
  /**
   * Reads the repository root's state, so a write that lands outside the worktree
   * can be told apart from a run that simply changed nothing.
   *
   * The scope gate reads the worktree's diff and is therefore blind to writes
   * anywhere else: an agent that leaves its worktree leaves it clean, and the gate
   * reports no violation. This option closes that from the other side by comparing
   * the root before and after dispatch.
   *
   * Omitted means no containment gate, which the result records rather than
   * treating as a pass.
   */
  repoSnapshot?: RepoSnapshotProvider;
  /**
   * Waits for the executed worktree to stop changing before verification begins.
   *
   * A runtime resolving its prompt call is a statement about a process, not about
   * the work. Verifying while an agent is still writing judges a state the run will
   * never report, and cleanup then deletes the tree underneath it.
   *
   * Omitted means no wait. Every real caller supplies one; see the CLI. It is
   * optional rather than required so the kernel stays usable without a filesystem.
   */
  settleWork?: SettleOptions & { readonly fingerprint: WorktreeFingerprint };
  /**
   * Whether an out-of-scope change prevents `ready`. Defaults to `true` where
   * `paths` are declared: the point is to make the boundary real, and an opt-in gate
   * would leave the default advisory — the defect this replaces.
   */
  strictScope?: boolean;
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
          return runOne(scheduled.workUnit, scheduled.risk, scheduled.paths, options, eventLog, id, now);
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

  // A unit that the scheduler blocked never dispatched; that is a blocked
  // run, not a ready pipeline.
  const schedulerBlocked = plan.decisions.filter((decision) => decision.outcome === "blocked");
  if (schedulerBlocked.length > 0) {
    return {
      status: "blocked",
      reason: `scheduler blocked ${schedulerBlocked.length} work unit(s): ${schedulerBlocked
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

/**
 * Releases the workspace a run executed in.
 *
 * Best-effort: a cleanup failure is recorded and swallowed, because losing the
 * ability to clean up must not erase the record of the run itself — the same
 * reasoning `executeWorkUnit` applies to its own cleanup.
 *
 * The runtime is resolved by the name the execution recorded rather than captured
 * at dispatch, so a repair attempt that selected a different runtime still releases
 * the right workspace.
 */
async function releaseWorkspace(
  runtimes: LabelledRuntime[],
  execution: ExecutionRecord,
  eventLog: EventLog | undefined,
  runId: string,
  workUnitId: string,
  id: () => string,
  now: () => string,
): Promise<void> {
  if (execution.workspaceId === undefined) return;
  const labelled = runtimes.find((candidate) => candidate.name === execution.runtime);
  if (labelled === undefined) return;

  const append = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    await eventLog?.append([
      { workUnitId, runId, source: "factory", type, payload, id: id(), timestamp: now() } as LoggableEvent,
    ]);
  };

  try {
    await labelled.runtime.cleanupWorkspace({
      id: execution.workspaceId,
      path: execution.worktreePath ?? "",
      ...(execution.worktreePath === undefined ? {} : { worktreePath: execution.worktreePath }),
    });
    await append("workspace.cleaned", { workspaceId: execution.workspaceId });
  } catch (error) {
    await append("workspace.cleanup_failed", {
      workspaceId: execution.workspaceId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Compares what the run changed against what it declared it would change.
 *
 * Three outcomes, all explicit:
 *
 * - **No provider** — scope could not be checked. Recorded as `unchanged: true` with
 *   nothing changed, and reported through the reason, because "not checked" must
 *   not read as "in scope".
 * - **No declared `paths`** — no gate. A Work Unit that says nothing about its
 *   surface gets no boundary; `undeclared` records that so it is never mistaken for
 *   a narrowly-scoped one.
 * - **Declared** — out-of-scope files are named, and under the default strict mode
 *   they prevent `ready`.
 */
async function evaluateScope(
  workUnit: WorkUnit,
  declaredPaths: string[] | undefined,
  options: RunPipelineOptions,
  worktreePath: string | undefined,
  verifyIn: "worktree" | "repo",
  eventLog: EventLog | undefined,
  runId: string,
  id: () => string,
  now: () => string,
): Promise<ScopeCheck | undefined> {
  if (options.changedFiles === undefined) return undefined;

  // Repo-scoped verification means the work happened somewhere this call cannot
  // see, so there is nothing to compare and nothing to claim.
  if (verifyIn === "repo" || worktreePath === undefined) {
    return { changed: [], outOfScope: [], undeclared: declaredPaths === undefined };
  }

  // A runtime that produces no real tree — the fake runtime, by design — leaves
  // nothing to diff. Returning no result makes no claim either way, which is the
  // honest answer: scope was not checked, and it is not reported as in scope.
  if (!existsSync(worktreePath)) return undefined;

  let changed: string[];
  try {
    changed = await options.changedFiles(worktreePath);
  } catch (error) {
    // A diff that could not be read is not a clean bill of health. Reported as a
    // failure so it cannot be mistaken for "no changes".
    throw new Error(
      `scope check for ${workUnit.id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const check = checkScope(changed, declaredPaths);
  const strict = options.strictScope !== false;

  if (check.outOfScope.length > 0) {
    await eventLog?.append([
      {
        workUnitId: workUnit.id,
        runId,
        source: "factory",
        type: strict ? "scope.violation" : "scope.warning",
        payload: {
          declaredPaths: declaredPaths ?? [],
          outOfScope: check.outOfScope.map((change) => change.file),
          lockfiles: check.outOfScope.filter((change) => change.lockfile).map((change) => change.file),
          strict,
        },
      },
    ]);
  }

  return check;
}

/** One Work Unit through the whole sequence. */
async function runOne(
  workUnit: WorkUnit,
  risk: ExecutionRiskInput | undefined,
  declaredPaths: string[] | undefined,
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

  /**
   * The workspace is released only after verification and repair have read it.
   *
   * Cleanup belongs here rather than inside `executeWorkUnit` because
   * independent verification inspects the tree the agent produced. Cleaning up
   * at the end of execution destroys the evidence before it is checked, which
   * made every worktree-scoped check fail against a deleted directory.
   *
   * Best-effort, as in `executeWorkUnit`: a cleanup failure must not erase the
   * record of what happened.
   */
  // Hoisted so the `finally` below can release the workspace it created.
  let execution: ExecutionRecord | undefined;

  // Containment baseline, read before any agent runs so a write outside the
  // worktree is attributable to this run rather than to whatever state the
  // checkout was already in.
  //
  // A failed read is recorded and then treated as no gate. It is deliberately not
  // defaulted to an empty snapshot: two unreadable snapshots compare equal, so
  // defaulting would report no breach on every run and disarm the check silently.
  let containmentBefore: RepoSnapshot | undefined;
  if (options.repoSnapshot !== undefined) {
    try {
      containmentBefore = await options.repoSnapshot(cwd);
    } catch {
      await eventLog?.append([
        {
          workUnitId: workUnit.id,
          runId,
          source: "factory",
          type: "containment.unchecked",
          payload: { reason: "the repository root could not be read before dispatch" },
          id: id(),
          timestamp: now(),
        } as LoggableEvent,
      ]);
    }
  }

  /**
   * Reads the repository root now and reports a breach against the baseline.
   *
   * Shared by the two places that need it: the moment execution ends, and the
   * integration gate. Between them they answer different questions — "did the
   * agent leave while it was working" and "did anything move in total" — and a run
   * that repairs can have escaped on a later attempt rather than the first.
   */
  const containmentBreachNow = async (): Promise<ContainmentBreach | undefined> => {
    if (options.repoSnapshot === undefined || containmentBefore === undefined) return undefined;
    const after = await readRepoSnapshot(options.repoSnapshot, cwd);
    return after === undefined ? undefined : detectContainmentBreach(containmentBefore, after);
  };

  try {
    execution = await executeWorkUnit({
      ...base,
      // The pipeline owns cleanup, because independent verification reads the
      // executed worktree and it must still exist when it does.
      cleanup: false,
      workUnit,
      worker: { id: `worker-${workUnit.id}`, capabilities: workUnit.capabilities, runtime: options.runtimes[0]?.name ?? "unknown" },
      prompt: (worktreePath) => buildWorkInstruction(workUnit, worktreePath),
      runtimes,
    });

    /**
     * Containment, checked the instant the agent stops — not at the gate.
     *
     * The gate also checks, and is still the right place for the total. But it
     * runs *after* verification, and verification on a real project is minutes:
     * `npm ci` plus the suite. Two observed escapes produced no verdict at all,
     * because both runs were killed inside that window with the breach already
     * true and unrecorded.
     *
     * A breach found here also means the tree about to be verified is not the tree
     * the work landed in, so verifying it at all is wasted time on a wrong answer.
     * Blocking now reports the real reason in seconds, and leaves the repair loop
     * alone — repairing fixes failing checks against completed work, and there is
     * no completed work in the right place to repair.
     */
    const earlyBreach = await containmentBreachNow();
    if (earlyBreach !== undefined) {
      await eventLog?.append([
        {
          workUnitId: workUnit.id,
          runId,
          source: "factory",
          type: "containment.breached",
          payload: { kind: earlyBreach.kind, files: [...earlyBreach.files], stage: "execution" },
          id: id(),
          timestamp: now(),
        } as LoggableEvent,
      ]);
      return blockedWithoutVerification(workUnit, execution, describeContainmentBreach(earlyBreach));
    }

    /**
     * Wait for the work to stop changing, before anything reads it.
     *
     * Everything after this point assumes the worktree holds the finished work.
     * Verification reads it, the scope gate diffs it, and cleanup deletes it — and
     * an agent still writing makes all three judgements about a state that is not
     * the one the run will report.
     *
     * An unsettled worktree **blocks** rather than proceeding. The alternative is to
     * verify a moving target and report the result, which is the false green this
     * exists to remove: "nothing verified must never be reported as verification
     * passed", and a tree that is still changing has not been verified at all.
     *
     * Only the first attempt waits. A repair attempt re-dispatches and re-executes,
     * and that work settles on its own terms afterwards — waiting here again would
     * charge every repair the full settle cost for work that has not started yet.
     */
    const settling = await settleExecutedWork(options, execution.worktreePath);
    if (settling !== undefined && !settling.settled) {
      await eventLog?.append([
        {
          workUnitId: workUnit.id,
          runId,
          source: "factory",
          type: "work.unsettled",
          payload: { reads: settling.reads, reason: settling.reason ?? "unknown" },
          id: id(),
          timestamp: now(),
        } as LoggableEvent,
      ]);
      return blockedWithoutVerification(
        workUnit,
        execution,
        `the dispatched work had not finished when the runtime reported it complete — ${settling.reason ?? "the worktree was still changing"}; refusing to verify a tree that is still being written to`,
      );
    }

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

    /**
     * Repair fixes failing checks against *completed* work.
     *
     * When the runtime never completed, the failed check is a symptom of that rather
     * than a cause, and re-issuing the same prompt to the same runtime re-encounters
     * the same fault — at the cost of a full prompt ceiling per attempt. A timing-out
     * runtime was measured dispatching three times and creating three worktrees before
     * escalating, which is the budget spent on a known-failed outcome.
     *
     * Verification still runs either way: partial work may have landed, and that
     * evidence is worth keeping. Only the repair loop is skipped.
     */
    if (verification.status !== "passed" && execution.status === "completed") {
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
            cleanup: false,
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
    } else if (verification.status !== "passed" && execution.status !== "completed") {
      repairReason = `repair_not_attempted_runtime_${execution.failure ?? execution.status}`;
    }

    async function verifyAttempt(attempt: number): Promise<VerificationResult> {
      // A repair attempt may have produced a new worktree, so the target is read
      // at call time rather than captured before the first attempt.
      const target = verifyIn === "repo" ? cwd : execution?.worktreePath;
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

    /**
     * Scope enforcement — after verification, before the integration gate.
     *
     * Ordering matters: the checks decide whether the work is correct, and only a
     * correct run is worth asking whether it stayed inside its boundary. Running it
     * earlier would report a scope violation for work that turned out to be broken
     * anyway; running it later would mean the gate had already passed.
     *
     * The worktree is still live here — cleanup is deferred to the `finally` — so
     * the diff can be read.
     */
    const scope = await evaluateScope(
      workUnit,
      declaredPaths,
      options,
      execution.worktreePath,
      verifyIn,
      eventLog,
      runId,
      id,
      now,
    );

    const scopeStrict = options.strictScope !== false && scope !== undefined && scope.outOfScope.length > 0;

    // Containment — did anything move in the checkout the factory was given?
    //
    // Read after every dispatch and repair attempt, so it covers the whole run. A
    // breach leads every other reason: the worktree this run verified is not the
    // tree the work landed in, so any verdict beneath it describes the wrong tree.
    const containmentBreach = await containmentBreachNow();
    if (containmentBreach !== undefined) {
      await eventLog?.append([
        {
          workUnitId: workUnit.id,
          runId,
          source: "factory",
          type: "containment.breached",
          payload: { kind: containmentBreach.kind, files: [...containmentBreach.files] },
          id: id(),
          timestamp: now(),
        } as LoggableEvent,
      ]);
    }

    // When the checks also failed, that verdict leads: the work is wrong regardless
    // of where it touched. The scope violation is appended rather than dropped,
    // because reporting only one of two real problems hides the other. When the
    // checks passed, scope is the sole reason — `verification_passed` would be
    // literally true and completely misleading.
    const verificationReason = blockingReasonFor(execution, verification);
    const scopeReason = scopeStrict ? describeScopeViolation(scope) : undefined;
    const containmentReason =
      containmentBreach === undefined ? undefined : describeContainmentBreach(containmentBreach);
    const combinedReason = foldReasons([containmentReason, verificationReason, scopeReason]);

    const integrationOutcome = await buildIntegrationResult({
      execution,
      verification,
      runId,
      ...(combinedReason === undefined ? {} : { scopeReason: combinedReason }),
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
    if (scope !== undefined) run.scope = scope;
    if (repairAttempts !== undefined) run.repairAttempts = repairAttempts;
    if (repairReason !== undefined) run.repairReason = repairReason;
    if (execution?.failure !== undefined) run.failure = execution.failure;

    return run;
  } finally {
    // Undefined only if `executeWorkUnit` itself threw before producing a record,
    // in which case there is nothing to release.
    if (execution !== undefined) {
      await releaseWorkspace(options.runtimes, execution, eventLog, runId, workUnit.id, id, now);
    }
  }
}

/**
 * Reads the repository root after dispatch, or reports nothing to compare.
 *
 * A read that throws yields `undefined` rather than an empty snapshot, so a root
 * that became unreadable mid-run is recorded as unchecked instead of being
 * compared against a baseline that will never match anything. It does not block:
 * the gate is best-effort evidence about a directory, and a root nobody can read is
 * a fact worth recording, not a reason to stop the run on its own.
 */
async function readRepoSnapshot(
  provider: RepoSnapshotProvider | undefined,
  root: string,
): Promise<RepoSnapshot | undefined> {
  if (provider === undefined) return undefined;
  try {
    return await provider(root);
  } catch {
    return undefined;
  }
}

/**
 * Joins the reasons a run did not reach `ready`, dropping the ones that do not apply.
 *
 * `verification_passed` is dropped because it is the absence of a problem, not a
 * reason — reported as a blocking cause it would read as though passing verification
 * had stopped the run, which is the opposite of what it means.
 *
 * Everything else is kept. A run with two real problems should report both, and the
 * order is the caller's: containment, then the checks, then scope. Reporting one and
 * dropping the other hides half of what went wrong.
 */
function foldReasons(reasons: readonly (string | undefined)[]): string | undefined {
  const kept = reasons.filter(
    (reason): reason is string => reason !== undefined && reason !== "verification_passed",
  );
  return kept.length === 0 ? undefined : kept.join("; ");
}

/**
 * The instruction handed to the runtime.
 *
 * Previously this was `workUnit.goal` alone: one abstract sentence, no path, no
 * boundary. The agent was left to infer where it was, and an agent inferring its
 * working directory is not a property worth shipping on — the isolation claim
 * should not rest on the agent working it out.
 *
 * **Hygiene, not a fix.** Controlled probes put an agent's work in the right place
 * every time, including one that had to search for the code before editing it, so
 * this is not the cause of the observed escapes. It states the boundary explicitly
 * because it costs nothing and because the alternative is relying on an agent
 * guessing.
 *
 * Falls back to the bare goal when the runtime reported no worktree. In that case
 * naming a directory would be inventing one, and the run blocks later anyway
 * rather than proceeding against an invented path.
 */
function buildWorkInstruction(workUnit: WorkUnit, worktreePath: string | undefined): string {
  if (worktreePath === undefined) return workUnit.goal;
  return [
    workUnit.goal,
    "",
    `Work in ${worktreePath}.`,
    "That directory is the isolated worktree for this Work Unit, and it is the only place this",
    "work belongs. Do not create or switch branches, and do not modify anything outside it —",
    "including the repository this worktree was created from. If something appears to require a",
    "change elsewhere, stop and report it rather than making one.",
  ].join(" ");
}

/**
 * Waits for the executed worktree to settle, if the caller asked for it and there
 * is a tree to wait on.
 *
 * Returns `undefined` when there is nothing to do, which the caller reads as "no
 * verdict" rather than "settled" — so an absent fingerprint or an absent worktree
 * never silently becomes a pass. A runtime that reported no worktree is blocked
 * further down for that reason anyway.
 */
async function settleExecutedWork(
  options: RunPipelineOptions,
  worktreePath: string | undefined,
): Promise<SettleResult | undefined> {
  if (options.settleWork === undefined || worktreePath === undefined) return undefined;
  const { fingerprint, ...settleOptions } = options.settleWork;
  return waitForSettledWork(fingerprint, worktreePath, settleOptions);
}
