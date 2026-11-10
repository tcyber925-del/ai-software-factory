import { randomUUID } from "node:crypto";
import type { ExecutionEvent, WorkUnit } from "../protocol.js";
import type { EventLog } from "../state/event-log.js";
import type {
  BranchWriteDecision,
  CredentialDecision,
  ExecutionRiskInput,
  IsolationAdmission,
  RiskAssessment,
} from "./risk.js";
import { assessExecutionRisk, detectDangerousOperations, evaluateBranchWrite, evaluateCredentialAccess } from "./risk.js";

/**
 * The factory's security decision record.
 *
 * Every security decision is recorded as a durable factory event, so "why did
 * this run?" and "why did that not run?" are both answerable after the fact.
 * A decision that is only logged in a terminal is not auditable.
 */

export type SecurityDecisionKind = "execution_admitted" | "execution_blocked" | "dispatch_screened" | "branch_write" | "credential_access" | "dangerous_operation";

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
  /** Set when this decision belongs to an attempt spawned by another run, e.g. repair. */
  parentRunId?: string;
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
    const entry = {
      workUnitId: options.workUnitId,
      runId: options.runId ?? outcome.record.kind,
      source: "factory" as const,
      type: decision.allowed ? "security.allowed" : "security.blocked",
      payload: { kind: decision.kind, allowed: decision.allowed, reason: decision.reason, ...decision.detail },
    };
    await options.eventLog.append([options.parentRunId === undefined ? entry : { ...entry, parentRunId: options.parentRunId }]);
  }
  return outcome;
}

/**
 * The pre-dispatch policy screen.
 *
 * It classifies risk and applies branch-write, credential and dangerous-operation
 * checks before a workspace exists. It deliberately does **not** admit execution:
 * isolation admission happens after the worktree is created and consumes a typed
 * attestation (`admitExecution`). There is no `providedIsolation` input because a
 * caller-supplied level is not evidence.
 *
 * Sandbox-required work is refused here rather than creating a workspace for work
 * no configured runtime can contain. That is a policy decision, not a claim that a
 * worktree is a sandbox.
 */
export interface SecurityGateInput {
  workUnitId: string;
  risk: ExecutionRiskInput;
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

  const assessment = assessExecutionRisk(workUnit, input.risk);
  const branch = evaluateBranchWrite(input.targetBranch, input.writeMode);
  const credentials =
    input.credentials === undefined ? undefined : evaluateCredentialAccess(input.credentials);

  const dangerousOperations = (input.commands ?? []).flatMap((command) => detectDangerousOperations(command));

  const decisions: SecurityDecisionRecord[] = [];
  const blockers: SecurityDecisionRecord[] = [];

  const isolationBlocked = assessment.minimumIsolation === "sandbox";
  const screenRecord: SecurityDecisionRecord = {
    kind: isolationBlocked ? "execution_blocked" : "dispatch_screened",
    workUnitId: input.workUnitId,
    allowed: !isolationBlocked,
    reason: isolationBlocked
      ? `${assessment.risk} work requires sandbox but no approved sandbox runtime is configured; ` +
        "a git worktree isolates files, not privileges"
      : `${assessment.risk} work requires ${assessment.minimumIsolation}; ` +
        "runtime isolation attestation must pass before any agent starts",
    detail: {
      risk: assessment.risk,
      reasons: assessment.reasons,
      requiredIsolation: assessment.minimumIsolation,
      providedIsolation: null,
      attestation: isolationBlocked ? "not_attempted" : "pending",
      runtime: null,
      stage: "pre_dispatch",
    },
  };
  decisions.push(screenRecord);
  if (!screenRecord.allowed) blockers.push(screenRecord);

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
    assessment,
    branch,
    dangerousOperations,
    decisions,
  };
  // Required because the project compiles with `exactOptionalPropertyTypes`:
  // an absent key is not the same as an explicit `undefined`.
  if (credentials !== undefined) result.credentials = credentials;
  return result;
}

/**
 * Builds the durable decision for the pre-agent admission point.
 *
 * The detail is the audit record the issue requires: runtime identity,
 * attestation outcome, required and provided levels, workspace identity, and the
 * reason. It contains paths and levels, never credentials or environment values.
 */
export function isolationSecurityDecision(
  workUnitId: string,
  admission: IsolationAdmission,
  runtime: string,
): SecurityDecisionRecord {
  const evidence = admission.attestation.evidence;
  return {
    kind: admission.admitted ? "execution_admitted" : "execution_blocked",
    workUnitId,
    allowed: admission.admitted,
    reason: admission.reason,
    detail: {
      runtime,
      attestation: admission.attestation.outcome,
      requiredIsolation: admission.assessment.minimumIsolation,
      providedIsolation: admission.attestation.providedLevel ?? null,
      workspaceId: evidence?.workspaceId ?? null,
      worktreePath: evidence?.worktreePath ?? null,
      agentCwd: evidence?.agentCwd ?? null,
      attestationProblems: admission.attestation.problems,
      stage: "pre_agent",
    },
  };
}