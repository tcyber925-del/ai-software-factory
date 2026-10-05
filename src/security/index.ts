import { randomUUID } from "node:crypto";
import type { ExecutionEvent, WorkUnit } from "../protocol.js";
import type { EventLog } from "../state/event-log.js";
import type {
  BranchWriteDecision,
  CredentialDecision,
  ExecutionRiskInput,
  IsolationLevel,
  RiskAssessment,
} from "./risk.js";
import { admitExecution, detectDangerousOperations, evaluateBranchWrite, evaluateCredentialAccess } from "./risk.js";

/**
 * The factory's security decision record.
 *
 * Every security decision is recorded as a durable factory event, so "why did
 * this run?" and "why did that not run?" are both answerable after the fact.
 * A decision that is only logged in a terminal is not auditable.
 */

export type SecurityDecisionKind = "execution_admitted" | "execution_blocked" | "branch_write" | "credential_access" | "dangerous_operation";

export interface SecurityDecisionRecord {
  kind: SecurityDecisionKind;
  workUnitId: string;
  allowed: boolean;
  reason: string;
  detail?: Record<string, unknown>;
}

export interface RecordSecurityDecisionOptions {
  workUnitId: string;
  eventLog?: EventLog;
  runId?: string;
  id?: () => string;
  now?: () => string;
}

export interface SecurityDecisionOutcome {
  record: SecurityDecisionRecord;
  events: ExecutionEvent[];
}

export function recordSecurityDecision(
  decision: SecurityDecisionRecord,
  options: RecordSecurityDecisionOptions,
): SecurityDecisionOutcome {
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const runId = options.runId ?? id();

  const payload = { kind: decision.kind, allowed: decision.allowed, reason: decision.reason, ...decision.detail };
  const event: ExecutionEvent = {
    id: id(),
    workUnitId: options.workUnitId,
    type: decision.allowed ? "security.allowed" : "security.blocked",
    timestamp: now(),
    payload,
  };

  return { record: decision, events: [event] };
}

/** Persists a security decision. Callers should await this: a lost decision is an unauditable one. */
export async function persistSecurityDecision(
  decision: SecurityDecisionRecord,
  options: RecordSecurityDecisionOptions,
): Promise<SecurityDecisionOutcome> {
  const outcome = recordSecurityDecision(decision, options);
  if (options.eventLog !== undefined) {
    await options.eventLog.append([
      {
        workUnitId: options.workUnitId,
        runId: options.runId ?? outcome.record.kind,
        source: "factory",
        type: decision.allowed ? "security.allowed" : "security.blocked",
        payload: { kind: decision.kind, allowed: decision.allowed, reason: decision.reason, ...decision.detail },
      },
    ]);
  }
  return outcome;
}

/**
 * One place where admission, branch-write, credential and dangerous-operation
 * checks are combined, so a caller cannot accidentally apply only some of them.
 */
export interface SecurityGateInput {
  workUnitId: string;
  risk: ExecutionRiskInput;
  providedIsolation: IsolationLevel;
  targetBranch: string;
  writeMode: "direct_push" | "pull_request";
  credentials?: { scope: "none" | "development" | "staging" | "production"; explicitlyRequired: boolean };
  commands?: string[];
}

export interface SecurityGateResult {
  admitted: boolean;
  blockers: SecurityDecisionRecord[];
  assessment: RiskAssessment;
  branch: BranchWriteDecision;
  credentials?: CredentialDecision;
  dangerousOperations: string[];
  decisions: SecurityDecisionRecord[];
}

export function evaluateSecurityGate(input: SecurityGateInput): SecurityGateResult {
  const workUnit: WorkUnit = {
    id: input.workUnitId,
    goal: "",
    repository: "",
    capabilities: ["coding"],
    acceptanceCriteria: [],
  };

  const admission = admitExecution(workUnit, input.risk, input.providedIsolation);
  const branch = evaluateBranchWrite(input.targetBranch, input.writeMode);
  const credentials =
    input.credentials === undefined ? undefined : evaluateCredentialAccess(input.credentials);

  const dangerousOperations = (input.commands ?? []).flatMap((command) => detectDangerousOperations(command));

  const decisions: SecurityDecisionRecord[] = [];
  const blockers: SecurityDecisionRecord[] = [];

  const admitRecord: SecurityDecisionRecord = {
    kind: admission.admitted ? "execution_admitted" : "execution_blocked",
    workUnitId: input.workUnitId,
    allowed: admission.admitted,
    reason: admission.reason,
    detail: {
      risk: admission.assessment.risk,
      reasons: admission.assessment.reasons,
      minimumIsolation: admission.assessment.minimumIsolation,
      providedIsolation: admission.assessment.providedIsolation,
    },
  };
  decisions.push(admitRecord);
  if (!admitRecord.allowed) blockers.push(admitRecord);

  const branchRecord: SecurityDecisionRecord = {
    kind: "branch_write",
    workUnitId: input.workUnitId,
    allowed: branch.allowed,
    reason: branch.reason,
    detail: { branch: input.targetBranch, mode: input.writeMode },
  };
  decisions.push(branchRecord);
  if (!branchRecord.allowed) blockers.push(branchRecord);

  if (credentials !== undefined) {
    const credentialRecord: SecurityDecisionRecord = {
      kind: "credential_access",
      workUnitId: input.workUnitId,
      allowed: credentials.granted,
      reason: credentials.reason,
      detail: { scope: input.credentials?.scope },
    };
    decisions.push(credentialRecord);
    if (!credentialRecord.allowed) blockers.push(credentialRecord);
  }

  if (dangerousOperations.length > 0) {
    // Reported, never silently ignored. A detected destructive command does not
    // by itself block trusted work, but it is recorded and must be surfaced.
    decisions.push({
      kind: "dangerous_operation",
      workUnitId: input.workUnitId,
      allowed: true,
      reason: `dangerous operations detected and recorded: ${dangerousOperations.join(", ")}`,
      detail: { operations: dangerousOperations },
    });
  }

  const result: SecurityGateResult = {
    admitted: blockers.length === 0,
    blockers,
    assessment: admission.assessment,
    branch,
    dangerousOperations,
    decisions,
  };
  // Required because the project compiles with `exactOptionalPropertyTypes`:
  // an absent key is not the same as an explicit `undefined`.
  if (credentials !== undefined) result.credentials = credentials;
  return result;
}