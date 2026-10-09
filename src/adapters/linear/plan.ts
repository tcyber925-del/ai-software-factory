import type { ExecutionRiskInput } from "../../security/risk.js";
import type { IntakeRefusal, IntakeResult, IntakeSource } from "../../kernel/intake.js";
import { describeIntakeOutcome, runIntake } from "../../kernel/intake.js";
import { workUnitToWireForm } from "../../kernel/work-unit.js";
import type { LinearIntakePolicy, LinearIssue } from "./intake.js";
import { linearIntakeAdapter } from "./intake.js";

/**
 * Linear intake, composed into a plan.
 *
 * `runIntake` answers one question about one issue: is this eligible, and if so
 * what Work Unit is it? That is the right granularity for a provider boundary
 * and the wrong one for a person deciding what to dispatch, because deciding
 * across twelve issues means calling it twelve times and holding the answers in
 * your head.
 *
 * `buildLinearIntakePlan` makes the same decisions and hands back the result as
 * something reviewable: the units that would be dispatched, in the plan shape
 * `factory work run --work-units` already reads, and the refusals beside them,
 * named by issue and reason.
 *
 * Three properties are structural rather than documented.
 *
 * **It cannot dispatch.** This module returns a document. There is no runtime,
 * no worktree and no call into `runPipeline` anywhere on this path, so composing
 * intake cannot start work — which is the answer to the question that deferred
 * FCT-018: intake writes a plan, and a human runs it.
 *
 * **Refused issues never appear as units.** A refusal is a refusal of a
 * *provider record*, and a refused record has no Work Unit to plan. The plan
 * therefore has two collections and no third state, and `refusals` entries carry
 * a source reference rather than a `workUnitId` — a record that never became a
 * Work Unit cannot be reported against one.
 *
 * **No scheduling structure is inferred.** `blockedBy` gated eligibility, but an
 * accepted issue's blockers are finished by definition, so turning that relation
 * into a plan `dependsOn` would ask the scheduler for work already done. The
 * `dependsOn`, `paths`, `contracts`, `runtimes`, `protectedResources` and `risk`
 * on a unit entry are therefore whatever the caller declared, carried verbatim —
 * never derived from issue text, labels or status.
 */

/**
 * Scheduling facts a caller declares for one issue.
 *
 * Mirrors the optional fields of `ScheduledWorkUnit` in `src/kernel/scheduler.ts`
 * and the plan file `readWorkUnitFile` parses in `src/cli/args.ts`. Declared, not
 * inferred: `risk` in particular is a control the security gate enforces, so
 * deriving it from the goal string would be a guess dressed as a gate.
 */
export interface LinearPlanUnitExtras {
  dependsOn?: string[];
  paths?: string[];
  contracts?: string[];
  runtimes?: string[];
  protectedResources?: string[];
  risk?: ExecutionRiskInput;
}

/** One planned unit, in the wire form a plan file holds. */
export interface LinearIntakePlanUnit {
  /** `work-unit.schema.json` wire form: snake_case, validated by the CLI on read. */
  workUnit: Record<string, unknown>;
  dependsOn?: string[];
  paths?: string[];
  contracts?: string[];
  runtimes?: string[];
  protectedResources?: string[];
  risk?: ExecutionRiskInput;
}

/**
 * A refused provider record.
 *
 * `outcome` is `"refused"` and never anything else. The scheduler's vocabulary
 * is `scheduled`/`blocked` against a `workUnitId`; reusing either word here is
 * how `work run` came to print "intake refused" while reading scheduler
 * decisions. The source reference is the subject here instead, because a refused
 * issue never became a Work Unit to name.
 */
export interface IntakePlanRefusal {
  outcome: "refused";
  /** Provider and record. The only identity a refusal has. */
  source: IntakeSource;
  refusal: IntakeRefusal;
  /** Rendered by the boundary's own `describeIntakeOutcome`, so the prefix holds. */
  message: string;
}

/**
 * What intake decided, in a form a human can read before anything runs.
 *
 * `units` is a plan file. `refusals` is the part that says why anything is
 * missing from it — the operator does not have to re-run intake to find out what
 * was excluded.
 */
export interface LinearIntakePlan {
  units: LinearIntakePlanUnit[];
  refusals: IntakePlanRefusal[];
}

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
 */
export function buildLinearIntakePlan(options: BuildLinearIntakePlanOptions): LinearIntakePlan {
  const { issues, policy, extras = {} } = options;

  const units: LinearIntakePlanUnit[] = [];
  const refusals: IntakePlanRefusal[] = [];

  for (const issue of issues) {
    const result: IntakeResult = runIntake(linearIntakeAdapter, issue, policy);

    if (result.outcome === "refused") {
      refusals.push({
        outcome: "refused",
        source: result.source,
        refusal: result.refusal,
        message: describeIntakeOutcome(result),
      });
      continue;
    }

    const declared = extras[issue.id];
    const unit: LinearIntakePlanUnit = { workUnit: workUnitToWireForm(result.workUnit) };
    if (declared?.dependsOn !== undefined) unit.dependsOn = [...declared.dependsOn];
    if (declared?.paths !== undefined) unit.paths = [...declared.paths];
    if (declared?.contracts !== undefined) unit.contracts = [...declared.contracts];
    if (declared?.runtimes !== undefined) unit.runtimes = [...declared.runtimes];
    if (declared?.protectedResources !== undefined) unit.protectedResources = [...declared.protectedResources];
    if (declared?.risk !== undefined) unit.risk = { ...declared.risk };
    units.push(unit);
  }

  return { units, refusals };
}