import { randomUUID } from "node:crypto";
import type { ExecutionEvent, VerificationCheck, VerificationResult, WorkUnit } from "../protocol.js";
import type { ExecutionRecord } from "./execution.js";
import type { EventLog } from "../state/event-log.js";

/**
 * Bounded repair and reconciliation.
 *
 * The loop exists to let a deterministic failure be retried a bounded number of
 * times. It is deliberately incapable of the three things it must not do:
 *
 * 1. **Self-authorization is impossible.** A repair attempt is never judged by
 *    the worker that performed it. `verify` is a separate, independently supplied
 *    function and the only input to the success decision. A worker reporting
 *    success with failing checks stays failing.
 * 2. **Scope cannot expand.** The repair context restates the original Work
 *    Unit's goal, acceptance criteria and scope. Repair narrows toward a failing
 *    check; it never re-specifies the work.
 * 3. **Retries are finite.** `maxAttempts` is enforced by the loop, not by the
 *    caller, so no worker can request another attempt.
 */

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

export interface RepairPolicy {
  /** Maximum automatic repair attempts. Defaults to 2. */
  maxAttempts?: number;
}

export interface RepairContext {
  workUnitId: string;
  attempt: number;
  maxAttempts: number;
  goal: string;
  acceptanceCriteria: string[];
  scope?: string[];
  failedChecks: VerificationCheck[];
}

export type RepairAttemptOutcome = "repaired" | "still_failing";

export interface RepairAttempt {
  attempt: number;
  prompt: string;
  execution: ExecutionRecord;
  verification: VerificationResult;
  outcome: RepairAttemptOutcome;
}

export type RepairLoopStatus = "verified" | "escalated";

export interface RepairLoopResult {
  workUnitId: string;
  status: RepairLoopStatus;
  attempts: RepairAttempt[];
  finalVerification: VerificationResult;
  /** Why the loop stopped, for the escalation record. */
  reason: string;
  events: ExecutionEvent[];
}

export interface RunRepairLoopOptions {
  workUnit: WorkUnit;
  /** Verification that triggered the loop. Must not have passed. */
  initialVerification: VerificationResult;
  /** Performs one bounded repair. Supplied by the caller so no runtime is embedded here. */
  execute: (prompt: string, attempt: number) => Promise<ExecutionRecord>;
  /** Independent verification. Only input to the success decision. */
  verify: (attempt: number) => Promise<VerificationResult>;
  policy?: RepairPolicy;
  eventLog?: EventLog;
  runId?: string;
  parentRunId?: string;
  id?: () => string;
  now?: () => string;
}

/**
 * Builds the bounded repair context. It carries the original intent forward
 * verbatim and adds only what failed, so a repair attempt cannot be a vehicle for
 * scope or requirement changes.
 */
export function buildRepairContext(
  workUnit: WorkUnit,
  verification: VerificationResult,
  attempt: number,
  maxAttempts: number,
): RepairContext {
  const context: RepairContext = {
    workUnitId: workUnit.id,
    attempt,
    maxAttempts,
    goal: workUnit.goal,
    acceptanceCriteria: [...workUnit.acceptanceCriteria],
    failedChecks: verification.checks.filter((check) => check.status !== "passed"),
  };
  if (workUnit.scope !== undefined) context.scope = [...workUnit.scope];
  return context;
}

export function renderRepairPrompt(context: RepairContext): string {
  const lines = [
    `Verification failed for ${context.workUnitId}. Repair attempt ${context.attempt} of at most ${context.maxAttempts}.`,
    "",
    `Original goal: ${context.goal}`,
    `Acceptance criteria: ${context.acceptanceCriteria.join("; ")}`,
  ];
  if (context.scope !== undefined && context.scope.length > 0) {
    lines.push(`Stay within this scope: ${context.scope.join(", ")}`);
  }
  lines.push(
    "",
    "Failing checks:",
    ...context.failedChecks.map((check) => `- ${check.name}: ${check.evidence ?? "no evidence recorded"}`),
    "",
    "Repair the cause of these failures without changing requirements, architecture, or scope.",
    "Do not modify tests to make them pass, and do not weaken verification.",
  );
  return lines.join("\n");
}

export async function runRepairLoop(options: RunRepairLoopOptions): Promise<RepairLoopResult> {
  const { workUnit, execute, verify } = options;
  const maxAttempts = options.policy?.maxAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  const runId = options.runId ?? randomUUID();
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.eventLog;

  const events: ExecutionEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown>): void => {
    events.push({ id: id(), workUnitId: workUnit.id, type, timestamp: now(), payload });
  };
  const persist = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    emit(type, payload);
    if (log === undefined) return;
    const entry = {
      workUnitId: workUnit.id,
      runId,
      source: "factory" as const,
      type,
      payload,
    };
    await log.append([options.parentRunId === undefined ? entry : { ...entry, parentRunId: options.parentRunId }]);
  };

  // Nothing to repair if the initial verification already passed.
  if (options.initialVerification.status === "passed") {
    return {
      workUnitId: workUnit.id,
      status: "verified",
      attempts: [],
      finalVerification: options.initialVerification,
      reason: "verification_already_passed",
      events,
    };
  }

  const attempts: RepairAttempt[] = [];
  let last: VerificationResult = options.initialVerification;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const context = buildRepairContext(workUnit, last, attempt, maxAttempts);
    const prompt = renderRepairPrompt(context);
    await persist("repair.started", {
      attempt,
      maxAttempts,
      failedChecks: context.failedChecks.map((check) => check.name),
      goal: context.goal,
    });

    const execution = await execute(prompt, attempt);
    // Verification is re-run independently. The execution result is recorded for
    // traceability but is deliberately not consulted for the outcome.
    const verification = await verify(attempt);

    if (verification.status === "passed") {
      attempts.push({ attempt, prompt, execution, verification, outcome: "repaired" });
      await persist("repair.succeeded", { attempt, runtimeStatus: execution.runtimeStatus ?? null });
      return {
        workUnitId: workUnit.id,
        status: "verified",
        attempts,
        finalVerification: verification,
        reason: "verification_passed_after_repair",
        events,
      };
    }

    attempts.push({ attempt, prompt, execution, verification, outcome: "still_failing" });
    last = verification;
    await persist("repair.failed", {
      attempt,
      failedChecks: verification.checks.filter((check) => check.status !== "passed").map((check) => check.name),
    });
  }

  await persist("repair.escalated", {
    attempts: attempts.length,
    maxAttempts,
    failedChecks: last.checks.filter((check) => check.status !== "passed").map((check) => check.name),
  });

  return {
    workUnitId: workUnit.id,
    status: "escalated",
    attempts,
    finalVerification: last,
    reason: `repair_limit_reached_after_${attempts.length}_attempts`,
    events,
  };
}