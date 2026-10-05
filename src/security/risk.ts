import type { WorkUnit } from "../protocol.js";

/**
 * Execution risk classification and minimum isolation policy.
 *
 * This module decides what isolation a Work Unit is *allowed* to run in. It
 * cannot grant isolation it does not have, and it never claims a Git worktree is
 * a sandbox — a worktree separates files, not privileges or processes. Per
 * `docs/security.md`, untrusted or destructive execution needs a stronger
 * boundary, and this policy refuses to let it run in a plain worktree instead of
 * silently proceeding.
 *
 * Decisions are values, not side effects, so every decision is inspectable and
 * testable, and can be recorded durably alongside execution events.
 */

/**
 * `trusted` — first-party code in the user's own repositories.
 * `untrusted` — third-party or generated content the factory did not author.
 * `destructive` — operations that can destroy work or reach production.
 */
export type RiskClass = "trusted" | "untrusted" | "destructive";

export type IsolationLevel = "none" | "git_worktree" | "sandbox";

export interface ExecutionRiskInput {
  /** Does the Work Unit consume content the factory did not author? */
  consumesUntrustedContent?: boolean;
  /** Does it run commands the factory cannot enumerate in advance? */
  executesArbitraryCommands?: boolean;
  /** Does it touch production, credentials, or deployment? */
  touchesProduction?: boolean;
  /** Explicit override recorded in the Work Unit's autonomy policy. */
  declaredRisk?: RiskClass;
}

export interface RiskAssessment {
  risk: RiskClass;
  reasons: string[];
  /** The weakest isolation this Work Unit may run in. */
  minimumIsolation: IsolationLevel;
  /** Isolation actually offered by the execution path. */
  providedIsolation: IsolationLevel;
  adequate: boolean;
}

const ISOLATION_STRENGTH: Record<IsolationLevel, number> = {
  none: 0,
  git_worktree: 1,
  sandbox: 2,
};

/** A plain worktree isolates files. Only a sandbox isolates privileges. */
export function isolationStrength(level: IsolationLevel): number {
  return ISOLATION_STRENGTH[level];
}

/**
 * Classifies risk from the highest-severity signal present. Order is fixed so the
 * same inputs always yield the same class — an assessment that varied run to run
 * could not be audited.
 */
export function assessExecutionRisk(workUnit: WorkUnit, input: ExecutionRiskInput = {}): RiskAssessment {
  const reasons: string[] = [];

  if (input.touchesProduction === true) reasons.push("touches production, credentials, or deployment");
  if (input.executesArbitraryCommands === true) reasons.push("executes commands that cannot be enumerated in advance");
  if (input.consumesUntrustedContent === true) reasons.push("consumes content the factory did not author");

  let risk: RiskClass;
  if (input.touchesProduction === true) {
    risk = "destructive";
  } else if (input.executesArbitraryCommands === true || input.consumesUntrustedContent === true) {
    risk = "untrusted";
  } else {
    risk = "trusted";
  }

  // A Work Unit may raise its own declared risk, never lower it: an author
  // asserting "trusted" must not be able to downgrade genuinely untrusted work.
  if (input.declaredRisk !== undefined && severity(input.declaredRisk) > severity(risk)) {
    reasons.push(`declared ${input.declaredRisk}; not downgraded to ${risk}`);
    risk = input.declaredRisk;
  } else if (input.declaredRisk !== undefined && input.declaredRisk !== risk) {
    // The refusal is recorded too. A downgrade that is silently dropped leaves
    // no audit trace that the Work Unit ever asked for weaker isolation.
    reasons.push(`declared ${input.declaredRisk} but the assessment is ${risk}; downgrade refused`);
  }

  if (risk === "destructive") reasons.push("classified destructive");
  else if (risk === "untrusted") reasons.push("classified untrusted");

  return {
    risk,
    reasons,
    minimumIsolation: minimumIsolationFor(risk),
    providedIsolation: "none",
    adequate: false,
  };
}

/**
 * Higher-risk work requires a sandbox. This is the control that stops a
 * higher-risk Work Unit from quietly running in an ordinary worktree.
 */
export function minimumIsolationFor(risk: RiskClass): IsolationLevel {
  switch (risk) {
    case "destructive":
    case "untrusted":
      return "sandbox";
    case "trusted":
      return "git_worktree";
  }
}

function severity(risk: RiskClass): number {
  switch (risk) {
    case "trusted":
      return 0;
    case "untrusted":
      return 1;
    case "destructive":
      return 2;
  }
}

/**
 * Final admission decision. An inadequate isolation level BLOCKS the Work Unit —
 * it does not warn, and it does not silently downgrade the risk class.
 */
export function admitExecution(
  workUnit: WorkUnit,
  input: ExecutionRiskInput,
  providedIsolation: IsolationLevel,
): { admitted: boolean; assessment: RiskAssessment; reason: string } {
  const assessment = assessExecutionRisk(workUnit, input);
  const adequate = isolationStrength(providedIsolation) >= isolationStrength(assessment.minimumIsolation);
  const decided: RiskAssessment = { ...assessment, providedIsolation, adequate };

  if (adequate) {
    return {
      admitted: true,
      assessment: decided,
      reason: `${decided.risk} work admitted in ${providedIsolation}`,
    };
  }

  return {
    admitted: false,
    assessment: decided,
    reason:
      `${decided.risk} work requires ${decided.minimumIsolation} but only ${providedIsolation} is available; ` +
      `a git worktree isolates files, not privileges`,
  };
}

/**
 * Protected branches cannot be written to directly, by anyone, including the
 * factory. This is enforced as data so it can be recorded as evidence rather
 * than trusted to a code path that someone might bypass.
 */
export const PROTECTED_BRANCHES = ["main", "master", "release"] as const;

export interface BranchWriteDecision {
  allowed: boolean;
  reason: string;
}

export function evaluateBranchWrite(branch: string, via: "direct_push" | "pull_request"): BranchWriteDecision {
  if (isProtectedBranch(branch)) {
    if (via === "direct_push") {
      return {
        allowed: false,
        reason: `'${branch}' is protected; a direct push cannot modify it`,
      };
    }
    return {
      allowed: true,
      reason: `'${branch}' is protected and reachable only through a pull request and the merge gate`,
    };
  }
  return { allowed: true, reason: `'${branch}' is not protected` };
}

export function isProtectedBranch(branch: string): boolean {
  const normalized = branch.trim().toLowerCase();
  return PROTECTED_BRANCHES.some((protectedBranch) => normalized === protectedBranch);
}

/**
 * Credential policy: production credentials are never available by default.
 * A Work Unit must be told explicitly that it needs them, and even then only a
 * named non-production scope is considered — there is no mechanism here that
 * hands over production secrets, by design.
 */
export interface CredentialDecision {
  granted: boolean;
  reason: string;
}

export function evaluateCredentialAccess(request: {
  scope: "none" | "development" | "staging" | "production";
  explicitlyRequired: boolean;
}): CredentialDecision {
  if (request.scope === "none") {
    return { granted: false, reason: "no credential scope requested" };
  }
  if (request.scope === "production") {
    return {
      granted: false,
      reason: "production credentials are never granted by the factory; provide them out of band if a human decides they are needed",
    };
  }
  if (!request.explicitlyRequired) {
    return {
      granted: false,
      reason: `${request.scope} credentials require an explicit requirement on the Work Unit`,
    };
  }
  return { granted: true, reason: `${request.scope} credentials explicitly required and below production` };
}

/**
 * Destructive-operation detection. A best-effort screen over command text:
 * it can be evaded by an obfuscated command, and is documented as such rather
 * than presented as a security boundary.
 */
export interface DangerFinding {
  operation: string;
  pattern: RegExp;
  rationale: string;
}

const DANGEROUS_OPERATIONS: DangerFinding[] = [
  { operation: "recursive_delete", pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, rationale: "recursive force delete can destroy work" },
  { operation: "force_push", pattern: /\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|-f\b)/, rationale: "force push rewrites published history" },
  { operation: "hard_reset", pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/, rationale: "discards uncommitted work" },
  { operation: "history_rewrite", pattern: /\bgit\s+(filter-branch|filter-repo|rebase\s+--root)/, rationale: "rewrites repository history" },
  { operation: "privileged_container", pattern: /\b(docker\s+run[^\n]*--privileged|podman\s+run[^\n]*--privileged)/, rationale: "privileged containers void container isolation" },
  { operation: "permission_chmod_777", pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/, rationale: "world-writable permissions" },
  { operation: "credential_dump", pattern: /\b(cat|printenv|env)\b[^\n]*(\/\.aws\/credentials|\/\.ssh\/id_|\.env\b)/, rationale: "reads credential material" },
];

export function detectDangerousOperations(command: string): string[] {
  return DANGEROUS_OPERATIONS.filter((finding) => finding.pattern.test(command)).map((finding) => finding.operation);
}

export function dangerousOperationRationale(operation: string): string | undefined {
  return DANGEROUS_OPERATIONS.find((finding) => finding.operation === operation)?.rationale;
}

/**
 * Explicitly documented boundary. This is a screen that raises a finding, not a
 * guarantee: a determined command can evade a regex. Untrusted execution still
 * requires sandbox isolation; this never substitutes for it.
 */
export const DANGEROUS_OPERATION_SCREEN_IS_BEST_EFFORT = true;