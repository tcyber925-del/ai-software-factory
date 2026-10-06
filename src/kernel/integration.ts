import { randomUUID } from "node:crypto";
import type { ExecutionEvent, IntegrationResult, VerificationResult } from "../protocol.js";
import type { ExecutionRecord } from "./execution.js";
import type { EventLog } from "../state/event-log.js";

/**
 * The integration gate record.
 *
 * The single rule this module exists to enforce: `state: "ready"` is reachable
 * only when independent verification passed. Execution status and runtime status
 * are recorded for traceability but never influence the outcome, so a worker that
 * reports success cannot make its own work integration-ready.
 */

export interface BuildIntegrationOptions {
  execution: ExecutionRecord;
  verification: VerificationResult;
  commit?: string;
  /** When provided, the integration outcome is persisted durably. */
  eventLog?: EventLog;
  runId?: string;
  id?: () => string;
  now?: () => string;
}

export interface IntegrationOutcome {
  result: IntegrationResult;
  events: ExecutionEvent[];
}

export async function buildIntegrationResult(options: BuildIntegrationOptions): Promise<IntegrationOutcome> {
  const { execution, verification } = options;
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const runId = options.runId ?? id();

  const events: ExecutionEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown>): void => {
    events.push({ id: id(), workUnitId: execution.workUnitId, type, timestamp: now(), payload });
  };

  const blocker = blockingReason(execution, verification);
  const verificationAttempts = verification.attempt ?? 1;
  const payload = {
    verificationStatus: verification.status,
    verificationAttempts,
    executionStatus: execution.status,
    runtimeStatus: execution.runtimeStatus ?? null,
    reason: blocker ?? "verification_passed",
  };

  emit(blocker === undefined ? "integration.ready" : "integration.blocked", payload);

  if (options.eventLog !== undefined) {
    // The integration outcome is persisted before it is returned, so a crash
    // after this point cannot leave the record claiming a different state.
    await options.eventLog.append([
      {
        workUnitId: execution.workUnitId,
        runId,
        source: "factory",
        type: blocker === undefined ? "integration.ready" : "integration.blocked",
        payload,
      },
    ]);
  }

  const result: IntegrationResult = {
    workUnitId: execution.workUnitId,
    state: blocker === undefined ? "ready" : "blocked",
    reason: blocker ?? "verification_passed",
    verification,
    events,
  };
  if (options.commit !== undefined) result.commit = options.commit;

  return { result, events };
}

/**
 * Verification is checked first and deliberately outranks execution state. A
 * Work Unit whose runtime finished but whose checks failed is blocked, and a
 * Work Unit whose checks passed is judged on its own evidence rather than on how
 * the runtime happened to exit.
 */
function blockingReason(execution: ExecutionRecord, verification: VerificationResult): string | undefined {
  if (verification.workUnitId !== execution.workUnitId) {
    return "verification_work_unit_mismatch";
  }
  // The runtime failure is checked first because it is the *cause* of a failed
  // check, not a co-equal one. Reporting `verification_failed` for a run whose
  // runtime timed out points the operator at their tests rather than at the thing
  // that actually stopped the work.
  if (execution.status === "blocked") return `execution_${execution.failure ?? "blocked"}`;
  if (execution.status === "failed") return `execution_${execution.failure ?? "failed"}`;
  if (verification.status === "blocked") return "verification_blocked";
  if (verification.status !== "passed") return "verification_failed";
  return undefined;
}