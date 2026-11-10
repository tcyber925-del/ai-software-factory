import { resolve } from "node:path";
import type { IsolationAttestation, IsolationLevel } from "../protocol.js";

/**
 * Isolation attestation verification.
 *
 * Admission must not consume a level. A runtime can report `git_worktree` while
 * its agent runs in the repository root, or return evidence minted for another
 * Work Unit. This module checks the evidence's shape, its binding to the
 * selected runtime/workspace/worktree, its freshness, and finally whether the
 * level it proves meets policy.
 *
 * It cannot prove adversarial containment. A runtime that lies consistently
 * will pass; conformance tests exercise the actual execution directory, and
 * post-hoc containment detection remains a separate control. A worktree is not
 * a sandbox, and nothing here claims otherwise.
 */

export const DEFAULT_ATTESTATION_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_ATTESTATION_FUTURE_SKEW_MS = 30_000;

const ISOLATION_STRENGTH: Record<IsolationLevel, number> = {
  none: 0,
  git_worktree: 1,
  sandbox: 2,
};

/** Orders isolation levels by strength. A higher number is stronger. */
export function isolationStrength(level: IsolationLevel): number {
  return ISOLATION_STRENGTH[level];
}

export type AttestationOutcome =
  | "verified"
  | "missing"
  | "malformed"
  | "stale"
  | "mismatched"
  | "insufficient";

export type AttestationProblem =
  | "attestation_missing"
  | "attestation_malformed"
  | "runtime_mismatch"
  | "work_unit_mismatch"
  | "workspace_mismatch"
  | "repository_mismatch"
  | "worktree_mismatch"
  | "agent_cwd_mismatch"
  | "attestation_stale"
  | "isolation_insufficient";

export interface AttestationExpectation {
  /** The runtime selected for this dispatch. Evidence from another runtime is refused. */
  runtime: string;
  workUnitId: string;
  workspaceId: string;
  /** The worktree the kernel created, when it created one. */
  worktreePath?: string;
  repositoryRoot: string;
  /** The kernel's clock at admission, in ISO-8601 form. */
  now: string;
  requiredLevel: IsolationLevel;
  maxAgeMs?: number;
  futureSkewMs?: number;
  /**
   * Set when the runtime was asked for evidence and the request failed. The
   * refusal then names the failure rather than pretending no request was made.
   */
  observationError?: string;
}

export interface AttestationEvidenceSummary {
  runtime: string;
  workUnitId: string;
  workspaceId: string;
  repositoryRoot: string;
  agentCwd: string;
  worktreePath?: string;
  observedAt: string;
}

export interface AttestationDecision {
  ok: boolean;
  outcome: AttestationOutcome;
  requiredLevel: IsolationLevel;
  runtime: string;
  providedLevel?: IsolationLevel;
  problems: AttestationProblem[];
  reason: string;
  evidence?: AttestationEvidenceSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function parseLevel(value: unknown): IsolationLevel | undefined {
  return value === "none" || value === "git_worktree" || value === "sandbox" ? value : undefined;
}

/**
 * Returns a decision rather than throwing. A refusal is a value that can be
 * recorded durably, and an exception at this point would become a runtime
 * failure instead of a security decision.
 */
export function verifyIsolationAttestation(
  attestation: unknown,
  expected: AttestationExpectation,
): AttestationDecision {
  if (attestation === undefined || attestation === null) {
    const detail =
      expected.observationError === undefined ? "" : `: ${expected.observationError}`;
    return {
      ok: false,
      outcome: "missing",
      requiredLevel: expected.requiredLevel,
      runtime: expected.runtime,
      problems: ["attestation_missing"],
      reason: `runtime '${expected.runtime}' produced no isolation attestation${detail}; refusing to start an agent without evidence`,
    };
  }

  if (!isRecord(attestation)) {
    return {
      ok: false,
      outcome: "malformed",
      requiredLevel: expected.requiredLevel,
      runtime: expected.runtime,
      problems: ["attestation_malformed"],
      reason: `runtime '${expected.runtime}' produced a malformed isolation attestation; a caller-supplied isolation label is not evidence`,
    };
  }

  const runtime = nonEmptyString(attestation, "runtime");
  const workUnitId = nonEmptyString(attestation, "workUnitId");
  const workspaceId = nonEmptyString(attestation, "workspaceId");
  const repositoryRoot = nonEmptyString(attestation, "repositoryRoot");
  const agentCwd = nonEmptyString(attestation, "agentCwd");
  const observedAt = nonEmptyString(attestation, "observedAt");
  const level = parseLevel(attestation["level"]);

  const worktreePathValue = attestation["worktreePath"];
  const worktreePath =
    worktreePathValue === undefined ? undefined : nonEmptyString(attestation, "worktreePath");

  const malformed: string[] = [];
  if (runtime === undefined) malformed.push("runtime");
  if (workUnitId === undefined) malformed.push("workUnitId");
  if (workspaceId === undefined) malformed.push("workspaceId");
  if (repositoryRoot === undefined) malformed.push("repositoryRoot");
  if (agentCwd === undefined) malformed.push("agentCwd");
  if (observedAt === undefined) malformed.push("observedAt");
  if (level === undefined) malformed.push("level");
  if (worktreePathValue !== undefined && worktreePath === undefined) malformed.push("worktreePath");

  if (
    malformed.length > 0 ||
    runtime === undefined ||
    workUnitId === undefined ||
    workspaceId === undefined ||
    repositoryRoot === undefined ||
    agentCwd === undefined ||
    observedAt === undefined ||
    level === undefined
  ) {
    return {
      ok: false,
      outcome: "malformed",
      requiredLevel: expected.requiredLevel,
      runtime: expected.runtime,
      problems: ["attestation_malformed"],
      reason: `runtime '${expected.runtime}' produced a malformed isolation attestation (invalid: ${malformed.join(
        ", ",
      )}); a caller-supplied isolation label is not evidence`,
    };
  }

  const problems: AttestationProblem[] = [];
  const reasons: string[] = [];

  if (runtime !== expected.runtime) {
    problems.push("runtime_mismatch");
    reasons.push(`evidence came from '${runtime}', not the selected runtime '${expected.runtime}'`);
  }
  if (workUnitId !== expected.workUnitId) {
    problems.push("work_unit_mismatch");
    reasons.push(`evidence is bound to Work Unit '${workUnitId}', not '${expected.workUnitId}'`);
  }
  if (workspaceId !== expected.workspaceId) {
    problems.push("workspace_mismatch");
    reasons.push(`evidence is bound to workspace '${workspaceId}', not '${expected.workspaceId}'`);
  }
  if (!samePath(repositoryRoot, expected.repositoryRoot)) {
    problems.push("repository_mismatch");
    reasons.push(`evidence names repository root '${repositoryRoot}', not '${expected.repositoryRoot}'`);
  }

  // A worktree claim is only credible when it names the exact worktree the
  // kernel created and the exact directory the agent will run in. Claiming
  // "worktree" while executing in the repository root is the defect this
  // contract exists to catch.
  if (level !== "none") {
    if (
      worktreePath === undefined ||
      expected.worktreePath === undefined ||
      !samePath(worktreePath, expected.worktreePath)
    ) {
      problems.push("worktree_mismatch");
      reasons.push(
        worktreePath === undefined
          ? "evidence claims worktree isolation without a worktree path"
          : `evidence names worktree '${worktreePath}', not '${expected.worktreePath ?? "none"}'`,
      );
    } else if (!samePath(agentCwd, worktreePath)) {
      problems.push("agent_cwd_mismatch");
      reasons.push(`agent cwd '${agentCwd}' is not the attested worktree '${worktreePath}'`);
    }
  }

  const nowMs = Date.parse(expected.now);
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedMs)) {
    problems.push("attestation_malformed");
    reasons.push(`evidence timestamp '${observedAt}' or admission clock '${expected.now}' is not a valid instant`);
  } else {
    const maxAgeMs = expected.maxAgeMs ?? DEFAULT_ATTESTATION_MAX_AGE_MS;
    const futureSkewMs = expected.futureSkewMs ?? DEFAULT_ATTESTATION_FUTURE_SKEW_MS;
    if (observedMs - nowMs > futureSkewMs) {
      problems.push("attestation_stale");
      reasons.push(`evidence is dated ${observedAt}, after the admission clock ${expected.now}`);
    } else if (nowMs - observedMs > maxAgeMs) {
      problems.push("attestation_stale");
      reasons.push(
        `evidence is stale: observed ${observedAt}, admitted ${expected.now}, maximum age ${maxAgeMs}ms`,
      );
    }
  }

  if (isolationStrength(level) < isolationStrength(expected.requiredLevel)) {
    problems.push("isolation_insufficient");
    reasons.push(
      `runtime '${expected.runtime}' attested ${level} but ${expected.requiredLevel} is required; ` +
        "a git worktree isolates files, not privileges",
    );
  }

  if (problems.length > 0) {
    return {
      ok: false,
      outcome: outcomeFor(problems),
      requiredLevel: expected.requiredLevel,
      runtime: expected.runtime,
      providedLevel: level,
      problems,
      reason: reasons.join("; "),
      evidence: evidenceOf(runtime, workUnitId, workspaceId, repositoryRoot, agentCwd, observedAt, worktreePath),
    };
  }

  return {
    ok: true,
    outcome: "verified",
    requiredLevel: expected.requiredLevel,
    runtime: expected.runtime,
    providedLevel: level,
    problems: [],
    reason: `runtime '${expected.runtime}' attested ${level} for workspace '${workspaceId}' at ${observedAt}`,
    evidence: evidenceOf(runtime, workUnitId, workspaceId, repositoryRoot, agentCwd, observedAt, worktreePath),
  };
}

function outcomeFor(problems: readonly AttestationProblem[]): AttestationOutcome {
  if (problems.includes("attestation_missing")) return "missing";
  if (problems.includes("attestation_malformed")) return "malformed";
  if (
    problems.some((problem) =>
      problem === "runtime_mismatch" ||
      problem === "work_unit_mismatch" ||
      problem === "workspace_mismatch" ||
      problem === "repository_mismatch" ||
      problem === "worktree_mismatch" ||
      problem === "agent_cwd_mismatch",
    )
  ) {
    return "mismatched";
  }
  if (problems.includes("attestation_stale")) return "stale";
  return "insufficient";
}

function evidenceSummary(input: {
  runtime: string;
  workUnitId: string;
  workspaceId: string;
  repositoryRoot: string;
  agentCwd: string;
  worktreePath?: string;
  observedAt: string;
}): AttestationEvidenceSummary {
  const summary: AttestationEvidenceSummary = {
    runtime: input.runtime,
    workUnitId: input.workUnitId,
    workspaceId: input.workspaceId,
    repositoryRoot: input.repositoryRoot,
    agentCwd: input.agentCwd,
    observedAt: input.observedAt,
  };
  if (input.worktreePath !== undefined) summary.worktreePath = input.worktreePath;
  return summary;
}

function evidenceOf(
  runtime: string,
  workUnitId: string,
  workspaceId: string,
  repositoryRoot: string,
  agentCwd: string,
  observedAt: string,
  worktreePath: string | undefined,
): AttestationEvidenceSummary {
  return evidenceSummary({
    runtime,
    workUnitId,
    workspaceId,
    repositoryRoot,
    agentCwd,
    observedAt,
    ...(worktreePath === undefined ? {} : { worktreePath }),
  });
}
