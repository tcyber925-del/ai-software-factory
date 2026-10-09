import type { IntakePlan, IntakePlanRefusal, IntakePlanUnit, IntakePlanUnitExtras } from "../../kernel/intake-plan.js";
import { buildIntakePlan } from "../../kernel/intake-plan.js";
import type { LinearIntakePolicy, LinearIssue } from "./intake.js";
import { linearIntakeAdapter } from "./intake.js";

/**
 * Linear intake, composed into a plan.
 *
 * This is a named seam, not a second implementation. The loop that runs records
 * through the boundary and collects the two outcomes lives in
 * `src/kernel/intake-plan.ts`, because it is the part of planning that is not
 * Linear-specific: the GitHub adapter needs the same plan, and a second copy of this
 * function is how two providers would come to disagree about what a refusal looks like.
 *
 * What this module keeps is the Linear half — the policy it plans under, and the
 * `extras` key it is addressed by — so an existing caller reads exactly as it did when
 * the plan was Linear's alone.
 */

/**
 * Scheduling facts a caller declares for one issue.
 *
 * Declared, not inferred: `risk` in particular is a control the security gate enforces,
 * so deriving it from the goal string would be a guess dressed as a gate.
 */
export type LinearPlanUnitExtras = IntakePlanUnitExtras;

/** One planned unit, in the wire form a plan file holds. */
export type LinearIntakePlanUnit = IntakePlanUnit;

/**
 * A refused provider record.
 *
 * `outcome` is `"refused"` and never anything else. The scheduler's vocabulary is
 * `scheduled`/`blocked` against a `workUnitId`; reusing either word here is how
 * `work run` came to print "intake refused" while reading scheduler decisions. The
 * source reference is the subject here instead, because a refused issue never became a
 * Work Unit to name.
 */
export type { IntakePlanRefusal };

/** What intake decided, in a form a human can read before anything runs. */
export type LinearIntakePlan = IntakePlan;

export interface BuildLinearIntakePlanOptions {
  /** The issues to consider, in the order the caller wants them planned. */
  issues: LinearIssue[];
  /**
   * The same policy a single `runIntake` call takes: the status allowlist, the
   * issues `blockedBy` resolves against, and the target repository.
   *
   * Nested rather than spread so the two kinds of input stay distinguishable —
   * these govern *eligibility*, while `extras` govern *scheduling*, and a field
   * that moves between them would silently change what a plan means.
   */
  policy: LinearIntakePolicy;
  /**
   * Per-issue scheduling facts, keyed by issue id. Copied verbatim; nothing is
   * read from the issue itself.
   */
  extras?: Record<string, LinearPlanUnitExtras>;
}

/**
 * Runs every issue through the boundary and collects the two outcomes.
 *
 * Deterministic: the same issues and policy produce an identical plan, in input
 * order, with no clock and no randomness. A plan is a document a human approves
 * before work runs, so it has to be reproducible — re-running intake must not
 * rewrite what someone agreed to.
 *
 * Three properties are structural rather than documented, and all three are the
 * kernel builder's rather than this function's.
 *
 * - **It cannot dispatch.** The builder returns a document. There is no runtime, no
 *   worktree and no call into `runPipeline` anywhere on this path, so composing
 *   intake cannot start work.
 * - **Refused issues never appear as units.** A refusal is a refusal of a *provider
 *   record*, and a refused record has no Work Unit to plan. The plan therefore has
 *   two collections and no third state.
 * - **No scheduling structure is inferred.** `blockedBy` gated eligibility, but an
 *   accepted issue's blockers are finished by definition, so turning that relation
 *   into a plan `dependsOn` would ask the scheduler for work already done.
 */
export function buildLinearIntakePlan(options: BuildLinearIntakePlanOptions): LinearIntakePlan {
  const { issues, policy, extras = {} } = options;

  return buildIntakePlan({
    adapter: linearIntakeAdapter,
    records: issues,
    policy,
    extras,
  });
}