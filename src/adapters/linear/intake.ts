import type { WorkUnit } from "../../protocol.js";
import type {
  IntakeEligibility,
  IntakeRefusalClassification,
  ProviderIntakeAdapter,
} from "../../kernel/intake.js";

/**
 * Linear intake: compile an eligible Linear issue into a provider-neutral Work Unit.
 *
 * Linear is an execution system, not the factory protocol. Nothing here leaks into
 * `WorkUnit` beyond a stable source reference and the issue's own stated
 * requirements — the factory protocol in `src/protocol.ts` is unchanged by this
 * adapter.
 *
 * The governing constraint is conservative by construction:
 *
 * > only explicitly eligible Ready work dispatches; never start arbitrary Backlog work
 *
 * That workspace realities enforce. This Linear workspace has no "Ready" status at
 * all — its statuses are Triage, Backlog, Todo, In Progress, In Review, Done,
 * Canceled, Duplicate. So eligibility cannot be inferred from a status *name* that
 * may not exist. It is an explicit allowlist that **defaults to empty**, and
 * `HARD_EXCLUDED_STATUS_TYPES` cannot be overridden by configuration.
 *
 * The second constraint is that no product or architecture decision is inferred.
 * Where an issue does not state what the factory needs — acceptance criteria, or
 * the capabilities required — compilation REFUSES and reports what is missing. It
 * never guesses, because a guessed acceptance criterion becomes an unverifiable
 * claim attached to someone's name.
 */

/** The Linear wire shape this adapter consumes. Provider detail, kept at the edge. */
export interface LinearIssue {
  id: string;
  title: string;
  description?: string;
  /** Linear status *type*: triage | backlog | unstarted | started | completed | canceled | duplicate */
  statusType: string;
  statusName?: string;
  priority?: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  /** Relations by issue id. `blockedBy` gates dispatch. */
  blockedBy?: string[];
  labels?: string[];
  url?: string;
}

/**
 * Status types that can never be dispatched, regardless of configuration. A
 * configuration mistake must not turn Backlog into a dispatch queue.
 */
export const HARD_EXCLUDED_STATUS_TYPES = ["backlog", "triage", "duplicate", "canceled", "completed"] as const;

export interface LinearEligibilityConfig {
  /**
   * Status types or names explicitly cleared for dispatch. Empty by default:
   * nothing is eligible until a human says so.
   */
  eligibleStatusTypes?: string[];
  eligibleStatusNames?: string[];
  /** Issues with this label are refused even when the status is eligible. */
  blockingLabels?: string[];
}

export type RefusalReason =
  | "backlog_or_hard_excluded_status"
  | "status_not_eligible"
  | "already_completed_or_canceled"
  | "blocked_by_incomplete_issue"
  | "blocked_by_unknown_issue"
  | "blocked_by_label"
  | "missing_acceptance_criteria"
  | "missing_capabilities"
  | "missing_goal"
  | "missing_repository";

export interface IntakeDecision {
  eligible: boolean;
  reason?: RefusalReason;
  detail?: string;
  /** Which check refused it, in a stable order. */
  check?: string;
}

/** Machine-readable requirements an issue must state for compilation. */
export interface DeclaredRequirements {
  acceptanceCriteria: string[];
  capabilities: string[];
}

const REQUIREMENTS_BLOCK = /<!--\s*factory:start\s*-->([\s\S]*?)<!--\s*factory:end\s*-->/i;

/**
 * Parses the factory requirements block an eligible issue must carry.
 *
 * An explicit block is required rather than parsed out of prose. Inferring
 * acceptance criteria from a description is how a factory ends up verifying
 * something nobody asked for.
 */
export function parseDeclaredRequirements(description: string | undefined): DeclaredRequirements | undefined {
  if (description === undefined) return undefined;
  const match = REQUIREMENTS_BLOCK.exec(description);
  if (match === null) return undefined;
  const body = match[1] ?? "";

  const acceptance: string[] = [];
  const capabilities: string[] = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const field = /^-\s*([a-z_]+)\s*:\s*(.+)$/i.exec(line);
    if (field === null) continue;
    const key = (field[1] ?? "").toLowerCase();
    const value = (field[2] ?? "").trim();
    if (key === "acceptance") acceptance.push(value);
    else if (key === "capability") capabilities.push(value);
  }

  if (acceptance.length === 0 || capabilities.length === 0) return undefined;
  return { acceptanceCriteria: acceptance, capabilities };
}

export interface EligibilityInput {
  issue: LinearIssue;
  config?: LinearEligibilityConfig;
  /** Issues known to the caller, used to resolve `blockedBy`. */
  knownIssues?: LinearIssue[];
  /**
   * Target repository. Required: it is not a Linear field, so the caller must
   * state it rather than letting the factory guess.
   */
  repository?: string;
}

function isComplete(issue: LinearIssue): boolean {
  return (
    (issue.completedAt !== null && issue.completedAt !== undefined) ||
    (issue.canceledAt !== null && issue.canceledAt !== undefined) ||
    issue.statusType === "completed" ||
    issue.statusType === "canceled"
  );
}

/**
 * Ordered checks, most fundamental first. Order is fixed so two runs over the same
 * issue produce the same refusal, which is what makes an intake decision
 * auditable rather than a coin flip.
 */
export function evaluateEligibility(input: EligibilityInput): IntakeDecision {
  const { issue, config = {} } = input;

  if ((HARD_EXCLUDED_STATUS_TYPES as readonly string[]).includes(issue.statusType)) {
    return {
      eligible: false,
      reason: "backlog_or_hard_excluded_status",
      detail: `status type '${issue.statusType}' is never dispatchable`,
      check: "hard_excluded_status",
    };
  }

  if (isComplete(issue)) {
    return { eligible: false, reason: "already_completed_or_canceled", check: "terminal_state" };
  }

  const blockingLabels = config.blockingLabels ?? [];
  const labels = (issue.labels ?? []).map((label) => label.toLowerCase());
  const blocking = blockingLabels.find((label) => labels.includes(label.toLowerCase()));
  if (blocking !== undefined) {
    return { eligible: false, reason: "blocked_by_label", detail: `label '${blocking}' blocks dispatch`, check: "labels" };
  }

  const eligibleTypes = config.eligibleStatusTypes ?? [];
  const eligibleNames = config.eligibleStatusNames ?? [];
  const statusEligible =
    eligibleTypes.includes(issue.statusType) || (issue.statusName !== undefined && eligibleNames.includes(issue.statusName));
  if (!statusEligible) {
    return {
      eligible: false,
      reason: "status_not_eligible",
      detail:
        eligibleTypes.length === 0 && eligibleNames.length === 0
          ? "no eligible status is configured, so nothing dispatches by default"
          : `status '${issue.statusType}${issue.statusName === undefined ? "" : `/${issue.statusName}`}' is not in the allowlist`,
      check: "status_allowlist",
    };
  }

  // Dependencies gate dispatch, and an unresolvable dependency blocks rather than
  // being ignored — proceeding would risk working on something already superseded.
  const known = new Map((input.knownIssues ?? []).map((candidate) => [candidate.id, candidate]));
  for (const blockerId of issue.blockedBy ?? []) {
    const blocker = known.get(blockerId);
    if (blocker === undefined) {
      return {
        eligible: false,
        reason: "blocked_by_unknown_issue",
        detail: `blocked by '${blockerId}', which was not supplied, so readiness cannot be established`,
        check: "dependencies",
      };
    }
    if (!isComplete(blocker)) {
      return {
        eligible: false,
        reason: "blocked_by_incomplete_issue",
        detail: `blocked by '${blockerId}', which is not complete`,
        check: "dependencies",
      };
    }
  }

  if (issue.title.trim().length === 0) {
    return { eligible: false, reason: "missing_goal", check: "requirements" };
  }

  const requirements = parseDeclaredRequirements(issue.description);
  if (requirements === undefined) {
    return {
      eligible: false,
      reason: "missing_acceptance_criteria",
      detail:
        "issue carries no `<!-- factory:start -->` block declaring at least one `- acceptance:` and one `- capability:` line; the factory will not infer them",
      check: "requirements",
    };
  }
  if (requirements.acceptanceCriteria.length === 0) {
    return { eligible: false, reason: "missing_acceptance_criteria", check: "requirements" };
  }
  if (requirements.capabilities.length === 0) {
    return { eligible: false, reason: "missing_capabilities", check: "requirements" };
  }

  // Linear carries no repository field. It is required input rather than a guess:
  // `work-unit.schema.json` demands a non-empty repository, and inventing one would
  // mean compiling work against a codebase nobody named.
  const repository = input.repository;
  if (repository === undefined || repository.trim().length === 0) {
    return {
      eligible: false,
      reason: "missing_repository",
      detail: "no repository was supplied; Linear carries no repository field and the factory will not infer one",
      check: "requirements",
    };
  }

  return { eligible: true };
}

export interface WorkUnitTraceability {
  system: "linear";
  issueId: string;
  url?: string;
  statusType: string;
}

export interface CompileOptions extends EligibilityInput {
  /** Overrides the base revision. */
  baseRevision?: string;
}

/**
 * Compiles an eligible issue into a provider-neutral Work Unit.
 *
 * Deterministic: the same issue and configuration always produce an identical Work
 * Unit. No clock, no randomness, no inferred fields.
 */
export function compileWorkUnit(options: CompileOptions): WorkUnitTraceability & { workUnit?: WorkUnit; decision: IntakeDecision } {
  const decision = evaluateEligibility(options);
  const { issue } = options;

  if (!decision.eligible) {
    return {
      system: "linear",
      issueId: issue.id,
      statusType: issue.statusType,
      decision,
    };
  }

  const requirements = parseDeclaredRequirements(issue.description);
  // `evaluateEligibility` already refused unless this is present; re-checked so the
  // compiler can never emit a Work Unit with invented criteria.
  if (requirements === undefined) {
    return { system: "linear", issueId: issue.id, statusType: issue.statusType, decision };
  }

  const workUnit: WorkUnit = {
    // The Linear identifier *is* the Work Unit id: identity is preserved end to end
    // without a lookup table that could drift.
    id: issue.id,
    goal: issue.title,
    // Guaranteed non-empty by `evaluateEligibility`.
    repository: options.repository ?? "",
    capabilities: [...requirements.capabilities],
    acceptanceCriteria: [...requirements.acceptanceCriteria],
    // Default to `review`: dispatching Linear work never self-authorizes a merge.
    autonomy: "review",
  };
  if (options.baseRevision !== undefined) workUnit.baseRevision = options.baseRevision;

  const traceability: WorkUnitTraceability = {
    system: "linear",
    issueId: issue.id,
    statusType: issue.statusType,
    ...(issue.url === undefined ? {} : { url: issue.url }),
  };
  return { ...traceability, workUnit, decision };
}

/**
 * The policy one Linear intake call runs under, in the shape the boundary wants:
 * the record arrives as `runIntake`'s second argument, so this carries only what
 * a caller knows *besides* the issue.
 *
 * Every field is optional on purpose, because "nothing is configured" is itself
 * the case the factory must handle by refusing. An empty policy is not a request
 * for defaults — it is the state in which no Linear work dispatches at all.
 */
export interface LinearIntakePolicy {
  config?: LinearEligibilityConfig;
  /** Issues the caller can resolve `blockedBy` against. */
  knownIssues?: LinearIssue[];
  /**
   * Target repository. Required in practice: an issue without one is refused
   * rather than compiled against a codebase nobody named.
   */
  repository?: string;
  /** Overrides the base revision on the compiled Work Unit. */
  baseRevision?: string;
}

/**
 * Every Linear refusal reason, mapped to the boundary's coarse vocabulary.
 *
 * Exhaustive on purpose, and typed as `Record<RefusalReason, …>` so adding a
 * reason to the rules above fails this file's typecheck until it is classified.
 * A partial map would degrade to a silent default, and a Linear rule that cannot
 * say why it refused becomes unreportable exactly when someone needs to know.
 *
 * Summarising does not discard detail: the provider's own reason code travels
 * alongside as `providerReason`, and `check` names which check decided.
 */
export const LINEAR_REFUSAL_CLASSIFICATIONS: Record<RefusalReason, IntakeRefusalClassification> = {
  backlog_or_hard_excluded_status: "not_dispatchable",
  already_completed_or_canceled: "not_dispatchable",
  status_not_eligible: "not_allowlisted",
  blocked_by_label: "policy_blocked",
  blocked_by_incomplete_issue: "dependency_incomplete",
  blocked_by_unknown_issue: "dependency_unresolved",
  missing_acceptance_criteria: "requirements_undeclared",
  missing_capabilities: "requirements_undeclared",
  missing_goal: "requirements_undeclared",
  missing_repository: "target_undeclared",
};

/**
 * The Linear adapter, as a consumer of the provider-neutral intake boundary.
 *
 * This is a binding, not a second implementation. `evaluate` and `compile` are
 * one-line delegations to `evaluateEligibility` and `compileWorkUnit`, so every
 * FCT-018 rule — the hard exclusions, the default-empty allowlist, the ordered
 * refusal checks, blocking labels, `blockedBy` handling, the refusal to infer
 * requirements or a repository — is reached exactly as it was written. A change
 * to those rules needs no change here, and no rule can be softened by being
 * re-expressed for the boundary.
 *
 * The mapping is the only new logic, and it loses nothing: the Linear reason code
 * and the check that produced it are both carried through.
 */
export const linearIntakeAdapter: ProviderIntakeAdapter<LinearIssue, LinearIntakePolicy> = {
  provider: "linear",

  sourceId: (issue) => issue.id,
  sourceUrl: (issue) => issue.url,

  evaluate: (issue, policy): IntakeEligibility => {
    const decision = evaluateEligibility({ ...policy, issue });
    if (decision.eligible) return { eligible: true };
    // `IntakeDecision` allows an eligible verdict with no reason, so the absent
    // reason is handled rather than asserted away.
    if (decision.reason === undefined) {
      throw new Error(`linear refused ${issue.id} without stating a reason`);
    }
    return {
      eligible: false,
      refusal: {
        classification: LINEAR_REFUSAL_CLASSIFICATIONS[decision.reason],
        providerReason: decision.reason,
        ...(decision.detail === undefined ? {} : { detail: decision.detail }),
        ...(decision.check === undefined ? {} : { check: decision.check }),
      },
    };
  },

  compile: (issue, policy) => compileWorkUnit({ ...policy, issue }).workUnit,
};
