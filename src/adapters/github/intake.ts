import type {
  IntakeEligibility,
  IntakeRefusalClassification,
  ProviderIntakeAdapter,
} from "../../kernel/intake.js";
import type { WorkUnit } from "../../protocol.js";

/**
 * GitHub intake: compile an explicitly eligible GitHub Issue into a
 * provider-neutral Work Unit.
 *
 * GitHub Issues are task input, not the factory protocol. Nothing here leaks
 * into `WorkUnit` beyond the issue's own stated requirements and a cross-reference
 * id — the protocol in `src/protocol.ts` is unchanged by this adapter, and
 * `schemas/work-unit.schema.json` gains no property.
 *
 * ## The eligibility signal, and where it comes from
 *
 * GitHub's issue taxonomy offers `open`/`closed` and a close reason. It has no
 * "Ready" status, so eligibility cannot be read off the state field: an open
 * issue is an issue someone filed, not work anyone cleared. Treating "open" as
 * eligibility would turn every issue in a repository into a dispatch queue, which
 * is exactly what the shipped Linear policy refuses to do with its Backlog
 * status — and exactly what this repository's own rules forbid.
 *
 * So the signal is **a label a human applies, matched against an allowlist that
 * is empty by default** (`eligibleLabels`). That is the same mechanism and the
 * same shape of decision as the conventions this repository already recognizes:
 *
 * | Established convention | GitHub expression here |
 * | --- | --- |
 * | An explicit eligibility allowlist, empty until a human fills it | `eligibleLabels`, default `[]` |
 * | A hard exclusion configuration cannot override | `state: "closed"`, and `GITHUB_HARD_EXCLUDED_STATE_REASONS` / `GITHUB_HARD_EXCLUDED_LABELS` |
 * | A configured blocking signal honoured regardless of status | `blockingLabels` |
 * | An explicit factory-declared requirements block, never prose | `<!-- factory:start -->` with `- acceptance:` and `- capability:` |
 * | A required, never-inferred repository | `repository`, supplied by the caller |
 *
 * The label is a human act on the issue itself, so eligibility is decidable by
 * reading one field and reproducing the decision later. Nothing is inferred from
 * the body: a paragraph that says "this is eligible" changes no verdict, because
 * a body is prose and the factory does not read prose as a decision.
 *
 * ## Provenance stays at the edge
 *
 * `GitHubIssueTraceability` and the boundary's `IntakeSource` carry the owner,
 * repository and issue number. `WorkUnit` carries only what the protocol defines.
 * A GitHub coordinate is how you find the work; it is not what the work is.
 */

/** The GitHub issue fields this adapter consumes. Provider detail, kept at the edge. */
export interface GitHubIssue {
  /** GitHub's own issue number. Unique per repository, not globally. */
  id: number;
  /** The account or organisation that owns the repository. */
  owner: string;
  /** The repository name, without the owner. */
  repo: string;
  title: string;
  /** GitHub's issue body. The requirements block, when present, lives here. */
  body?: string;
  /** GitHub exposes only `open` and `closed`. */
  state: "open" | "closed";
  /** GitHub's close reason, when the issue was closed with one. */
  stateReason?: "completed" | "not_planned" | "duplicate" | "reopened" | null;
  labels?: string[];
  /** Deep link to the issue, when the caller recorded one. */
  url?: string;
}

/**
 * Close reasons that can never dispatch, regardless of configuration.
 *
 * These are terminal outcomes GitHub itself records: `completed` work is
 * finished, `duplicate` is superseded, `not_planned` was declined. Configuration
 * must not turn one into a dispatch queue, which is the same discipline as the
 * Linear adapter's non-overridable hard exclusions.
 */
export const GITHUB_HARD_EXCLUDED_STATE_REASONS = ["completed", "not_planned", "duplicate"] as const;

/**
 * Labels that mark an issue as not-new-work, whatever the allowlist says.
 *
 * A `duplicate` label is a maintainer's own statement that the work exists
 * elsewhere; dispatching it on the strength of an eligibility label being present
 * would compile the same work twice. Checked before the allowlist so the refusal
 * names the label that actually stopped the issue.
 */
export const GITHUB_HARD_EXCLUDED_LABELS = ["duplicate", "wontfix", "invalid"] as const;

export interface GitHubEligibilityConfig {
  /**
   * Labels explicitly cleared for dispatch. Empty by default: nothing is
   * eligible until a human allowlists a label.
   */
  eligibleLabels?: string[];
  /** Issues carrying one of these labels are refused even when allowlisted. */
  blockingLabels?: string[];
}

export type GitHubRefusalReason =
  | "closed_or_hard_excluded_state"
  | "blocked_by_label"
  | "eligibility_label_not_allowlisted"
  | "missing_goal"
  | "missing_acceptance_criteria"
  | "missing_capabilities"
  | "missing_repository";

export interface GitHubIntakeDecision {
  eligible: boolean;
  reason?: GitHubRefusalReason;
  detail?: string;
  /** Which check refused it, in the adapter's own stable order. */
  check?: string;
}

/** Machine-readable requirements an issue must state for compilation. */
export interface GitHubDeclaredRequirements {
  acceptanceCriteria: string[];
  capabilities: string[];
}

const REQUIREMENTS_BLOCK = /<!--\s*factory:start\s*-->([\s\S]*?)<!--\s*factory:end\s*-->/i;

/**
 * Parses the factory requirements block an eligible issue must carry.
 *
 * An explicit block is required rather than parsed out of prose, for the reason
 * the rest of this factory requires it everywhere: an inferred acceptance
 * criterion becomes an unverifiable claim attached to someone's name. Real issue
 * 60 in `fixtures/github/issues.json` uses an `## Acceptance criteria` heading and
 * is still refused, because a heading is prose.
 *
 * A block that is present but incomplete is returned with whichever lists it does
 * declare, so the refusal can name the field that is actually missing. Collapsing
 * "no block" and "block without a capability" into one undifferentiated
 * `undefined` would tell an author to write acceptance criteria they had already
 * written, and the `missing_capabilities` reason would be unreachable.
 */
export function parseGitHubRequirements(body: string | undefined): GitHubDeclaredRequirements | undefined {
  if (body === undefined) return undefined;
  const match = REQUIREMENTS_BLOCK.exec(body);
  if (match === null) return undefined;
  const block = match[1] ?? "";

  const acceptanceCriteria: string[] = [];
  const capabilities: string[] = [];

  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const field = /^-\s*([a-z_]+)\s*:\s*(.+)$/i.exec(line);
    if (field === null) continue;
    const key = (field[1] ?? "").toLowerCase();
    const value = (field[2] ?? "").trim();
    if (key === "acceptance") acceptanceCriteria.push(value);
    else if (key === "capability") capabilities.push(value);
  }

  return { acceptanceCriteria, capabilities };
}

/**
 * The policy an evaluation runs under. Deliberately holds no issue: the record
 * arrives separately, so the same policy is reusable across every issue a caller
 * sweeps.
 */
export interface GitHubIntakePolicy {
  config?: GitHubEligibilityConfig;
  /**
   * The repository the compiled work targets. Required, never inferred.
   *
   * A GitHub issue names the repository it was filed in, but that is where the
   * conversation happened, not necessarily where the code changes: a tracking
   * repository, a design-doc repository, or a monorepo subdirectory all describe
   * work whose target nobody has named yet. Inferring it would compile work
   * against a codebase the factory was never told about.
   */
  repository?: string;
  /** Overrides the base revision of the compiled Work Unit. */
  baseRevision?: string;
}

export interface GitHubEligibilityInput extends GitHubIntakePolicy {
  issue: GitHubIssue;
}

/**
 * Ordered checks, most fundamental first.
 *
 * The order is fixed so two runs over the same issue produce the same refusal.
 * That is what makes an intake decision auditable rather than a coin flip: a
 * refusal can be reproduced and explained. Blocking labels are checked before the
 * eligibility allowlist so the reported reason names the label that actually
 * stopped the issue rather than a not-allowlisted verdict an operator would
 * misread and misconfigure.
 */
export function evaluateGitHubEligibility(input: GitHubEligibilityInput): GitHubIntakeDecision {
  const { issue } = input;
  const labels = (issue.labels ?? []).map((label) => label.toLowerCase());

  // Hard exclusions first: a configuration mistake must never resurrect finished
  // or superseded work.
  if (issue.state !== "open") {
    const closedAs = issue.stateReason ?? undefined;
    return {
      eligible: false,
      reason: "closed_or_hard_excluded_state",
      detail:
        closedAs === undefined
          ? "issue is closed and is never dispatchable"
          : `issue is closed as '${closedAs}', which is never dispatchable`,
      check: "state",
    };
  }
  if (
    issue.stateReason !== undefined &&
    issue.stateReason !== null &&
    (GITHUB_HARD_EXCLUDED_STATE_REASONS as readonly string[]).includes(issue.stateReason)
  ) {
    return {
      eligible: false,
      reason: "closed_or_hard_excluded_state",
      detail: `close reason '${issue.stateReason}' is never dispatchable`,
      check: "state_reason",
    };
  }

  const blockingLabels = [...(input.config?.blockingLabels ?? []), ...GITHUB_HARD_EXCLUDED_LABELS].map((label) =>
    label.toLowerCase(),
  );
  const blocking = blockingLabels.find((label) => labels.includes(label));
  if (blocking !== undefined) {
    return {
      eligible: false,
      reason: "blocked_by_label",
      detail: `label '${blocking}' blocks dispatch`,
      check: "labels",
    };
  }

  // The eligibility signal: exact match against an allowlist that is empty by
  // default, so an arbitrary open issue is never eligible merely by being open.
  const eligibleLabels = input.config?.eligibleLabels ?? [];
  const cleared = eligibleLabels.find((label) => labels.includes(label.toLowerCase()));
  if (cleared === undefined) {
    return {
      eligible: false,
      reason: "eligibility_label_not_allowlisted",
      detail:
        eligibleLabels.length === 0
          ? "no eligibility label is configured, so nothing dispatches by default; an open issue is not a readiness signal"
          : "no eligibility label is present; an allowlisted label is required and 'open' is not one",
      check: "eligibility_allowlist",
    };
  }

  if (issue.title.trim().length === 0) {
    return { eligible: false, reason: "missing_goal", check: "requirements" };
  }

  const requirements = parseGitHubRequirements(issue.body);
  if (requirements === undefined) {
    return {
      eligible: false,
      reason: "missing_acceptance_criteria",
      detail:
        "issue carries no `<!-- factory:start -->` block declaring at least one `- acceptance:` and one `- capability:` line; the factory will not infer them from prose",
      check: "requirements",
    };
  }
  if (requirements.acceptanceCriteria.length === 0) {
    return { eligible: false, reason: "missing_acceptance_criteria", check: "requirements" };
  }
  if (requirements.capabilities.length === 0) {
    return { eligible: false, reason: "missing_capabilities", check: "requirements" };
  }

  const repository = input.repository;
  if (repository === undefined || repository.trim().length === 0) {
    return {
      eligible: false,
      reason: "missing_repository",
      detail:
        "no target repository was supplied; the repository an issue was filed in is not the repository the work targets, and the factory will not infer one",
      check: "requirements",
    };
  }

  return { eligible: true };
}

/**
 * The GitHub coordinates of a record, kept beside the Work Unit.
 *
 * Provenance, not work: this is how a compiled Work Unit is traced back to the
 * issue that produced it. It never becomes a Work Unit field.
 */
export interface GitHubIssueTraceability {
  system: "github";
  owner: string;
  repo: string;
  issueId: number;
  /** GitHub's own cross-reference form, e.g. `acme/widgets#900`. */
  reference: string;
  /** The target repository the caller named for the compiled work. */
  repository: string;
  state: "open" | "closed";
  url?: string;
}

export interface GitHubCompileOptions extends GitHubEligibilityInput {}

/** GitHub's own identifier for an issue: the cross-reference everyone already uses. */
export function githubIssueReference(issue: GitHubIssue): string {
  return `${issue.owner}/${issue.repo}#${issue.id}`;
}

/**
 * The deep link GitHub gives an issue.
 *
 * Derived from the issue's own coordinates rather than trusted from the payload,
 * so a record that carries a mismatched or hostile `url` cannot redirect a reader
 * to somewhere else. A caller that recorded a URL still gets it when it agrees.
 */
export function githubIssueUrl(issue: GitHubIssue): string {
  const derived = `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.id}`;
  const recorded = issue.url;
  if (recorded !== undefined && recorded.startsWith(derived)) return recorded;
  return derived;
}

/**
 * Compiles an eligible issue into a provider-neutral Work Unit.
 *
 * Deterministic: the same issue and policy always produce an identical result.
 * No clock, no randomness, no inferred fields. A refused issue yields no Work
 * Unit at all rather than a partially populated one.
 */
export function compileGitHubWorkUnit(
  options: GitHubCompileOptions,
): { traceability?: GitHubIssueTraceability; workUnit?: WorkUnit; decision: GitHubIntakeDecision } {
  const decision = evaluateGitHubEligibility(options);
  const { issue } = options;

  const traceability: GitHubIssueTraceability = {
    system: "github",
    owner: issue.owner,
    repo: issue.repo,
    issueId: issue.id,
    reference: githubIssueReference(issue),
    repository: options.repository ?? "",
    state: issue.state,
    url: githubIssueUrl(issue),
  };

  if (!decision.eligible) {
    return { traceability, decision };
  }

  const requirements = parseGitHubRequirements(issue.body);
  // `evaluateGitHubEligibility` already refused unless this is present; re-checked
  // so the compiler can never emit a Work Unit with invented criteria.
  if (requirements === undefined) {
    return { traceability, decision };
  }

  const workUnit: WorkUnit = {
    // An issue number is unique only within its repository, so the Work Unit id is
    // the cross-reference. Identity survives into commits and PR evidence without
    // a lookup table that could drift.
    id: githubIssueReference(issue),
    goal: issue.title,
    // Guaranteed non-empty by `evaluateGitHubEligibility`.
    repository: options.repository ?? "",
    capabilities: [...requirements.capabilities],
    acceptanceCriteria: [...requirements.acceptanceCriteria],
    // Default to `review`: accepting a GitHub issue never self-authorizes a merge.
    autonomy: "review",
  };
  if (options.baseRevision !== undefined) workUnit.baseRevision = options.baseRevision;

  return { traceability, workUnit, decision };
}

/**
 * How each GitHub refusal reason reads at the provider-neutral boundary.
 *
 * Exhaustive by construction, and `Record<GitHubRefusalReason, …>` so a new
 * reason fails the typecheck until it is classified here. A partial map degrades
 * to a silent default, which is how a provider rule becomes unreportable.
 */
const CLASSIFICATIONS: Record<GitHubRefusalReason, IntakeRefusalClassification> = {
  closed_or_hard_excluded_state: "not_dispatchable",
  blocked_by_label: "policy_blocked",
  eligibility_label_not_allowlisted: "not_allowlisted",
  missing_goal: "requirements_undeclared",
  missing_acceptance_criteria: "requirements_undeclared",
  missing_capabilities: "requirements_undeclared",
  missing_repository: "target_undeclared",
};

/** The GitHub adapter, expressed through the provider-neutral intake contract. */
export const githubIntakeAdapter: ProviderIntakeAdapter<GitHubIssue, GitHubIntakePolicy> = {
  provider: "github",

  sourceId: githubIssueReference,
  sourceUrl: githubIssueUrl,

  evaluate: (issue, policy): IntakeEligibility => {
    const decision = evaluateGitHubEligibility({ ...policy, issue });
    if (decision.eligible) return { eligible: true };
    if (decision.reason === undefined) {
      throw new Error(`github refused issue #${issue.id} without stating a reason`);
    }
    return {
      eligible: false,
      refusal: {
        classification: CLASSIFICATIONS[decision.reason],
        providerReason: decision.reason,
        ...(decision.detail === undefined ? {} : { detail: decision.detail }),
        ...(decision.check === undefined ? {} : { check: decision.check }),
      },
    };
  },

  compile: (issue, policy) => compileGitHubWorkUnit({ ...policy, issue }).workUnit,
};