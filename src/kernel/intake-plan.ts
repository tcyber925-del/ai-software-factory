import type { ExecutionRiskInput } from "../security/risk.js";
import type { IntakeRefusal, IntakeSource, ProviderIntakeAdapter } from "./intake.js";
import { describeIntakeOutcome, runIntake } from "./intake.js";
import { workUnitToWireForm } from "./work-unit.js";

/**
 * Intake, composed into a plan, for any provider.
 *
 * `runIntake` answers one question about one record: is this eligible, and if so what
 * Work Unit is it? That is the right granularity for a provider boundary and the wrong
 * one for a person deciding what to dispatch, because deciding across a dozen records
 * means calling it a dozen times and holding the answers in your head.
 *
 * This module makes the same decisions once for a set of records and hands back
 * something reviewable: the units that would be dispatched, in the plan shape
 * `factory work run --work-units` already reads, and the refusals beside them, each
 * naming its source record.
 *
 * It lives in the kernel rather than in a provider adapter because it is the one part
 * of planning that is *not* provider-specific. Linear had a plan before this module
 * existed; the next adapter needs a plan too, and a second copy of this loop is how the
 * two would come to disagree about what a refusal looks like — one of them rendering it
 * through `describeIntakeOutcome`, the other paraphrasing it and losing the prefix that
 * distinguishes intake from scheduling.
 *
 * Four properties are structural rather than documented.
 *
 * **It cannot dispatch.** This module returns a document. There is no runtime, no
 * worktree and no call into the pipeline anywhere on this path, so composing intake
 * cannot start work — which is the answer to the question FCT-018 deferred: intake
 * writes a plan, and a human runs it.
 *
 * **Refused records never appear as units.** A refusal is a refusal of a *provider
 * record*, and a refused record has no Work Unit to plan. The plan therefore has two
 * collections and no third state, and a refusal carries a source reference rather than a
 * `workUnitId` — a record that never became a Work Unit cannot be reported against one.
 *
 * **No scheduling structure is inferred.** Eligibility gating is not scheduling: a
 * relation that *blocked* a record is finished by definition once the record is
 * accepted, so turning it into a plan `dependsOn` would ask the scheduler for work
 * already done. `dependsOn`, `paths`, `contracts`, `runtimes`, `protectedResources` and
 * `risk` are whatever the caller declared, carried verbatim.
 *
 * **It is reproducible.** No clock, no randomness, no inferred field. A plan is a
 * document a human approves before work runs, so re-running intake must not rewrite what
 * was agreed to.
 */

/**
 * Scheduling facts a caller declares for one record.
 *
 * Mirrors the optional fields of `ScheduledWorkUnit` in `src/kernel/scheduler.ts` and of
 * the plan entries `readWorkUnitFile` parses in `src/cli/args.ts`. Declared, not
 * inferred: `risk` in particular is a control the security gate enforces, so deriving it
 * from a record's content would be a guess dressed as a gate.
 */
export interface IntakePlanUnitExtras {
  dependsOn?: string[];
  paths?: string[];
  contracts?: string[];
  runtimes?: string[];
  protectedResources?: string[];
  risk?: ExecutionRiskInput;
}

/** One planned unit, in the wire form a plan file holds. */
export interface IntakePlanUnit extends IntakePlanUnitExtras {
  /** `work-unit.schema.json` wire form: snake_case, validated by the CLI on read. */
  workUnit: Record<string, unknown>;
}

/**
 * A refused provider record.
 *
 * `outcome` is `"refused"` and never anything else. The scheduler's vocabulary is
 * `scheduled`/`blocked` against a `workUnitId`; reusing either word here is how `work
 * run` came to print "intake refused" while reading scheduler decisions. The source
 * reference is the subject instead, because a refused record never became a Work Unit to
 * name.
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
 * `units` is a plan file. `refusals` is the part that says why anything is missing from
 * it — an operator does not have to re-run intake to find out what was excluded.
 */
export interface IntakePlan {
  units: IntakePlanUnit[];
  refusals: IntakePlanRefusal[];
}

export interface BuildIntakePlanOptions<TRecord, TPolicy> {
  /** The provider, reached through the one boundary every provider implements. */
  adapter: ProviderIntakeAdapter<TRecord, TPolicy>;
  /** The records to consider, in the order the caller wants them planned. */
  records: TRecord[];
  /** Whatever that provider calls its policy. Never inspected here. */
  policy: TPolicy;
  /**
   * Per-record scheduling facts, keyed by the provider's own id for the record
   * (`adapter.sourceId`). Copied verbatim; nothing is read from the record itself.
   */
  extras?: Record<string, IntakePlanUnitExtras>;
}

/**
 * Runs every record from one provider through the boundary and collects the two
 * outcomes.
 *
 * Deterministic: the same records and policy produce an identical plan, in input order,
 * with no clock and no randomness.
 */
export function buildIntakePlan<TRecord, TPolicy>(options: BuildIntakePlanOptions<TRecord, TPolicy>): IntakePlan {
  const { adapter, records, policy, extras = {} } = options;

  const units: IntakePlanUnit[] = [];
  const refusals: IntakePlanRefusal[] = [];

  for (const record of records) {
    const result = runIntake(adapter, record, policy);

    if (result.outcome === "refused") {
      refusals.push({
        outcome: "refused",
        source: result.source,
        refusal: result.refusal,
        message: describeIntakeOutcome(result),
      });
      continue;
    }

    const declared = extras[adapter.sourceId(record)];
    const unit: IntakePlanUnit = { workUnit: workUnitToWireForm(result.workUnit) };
    // Copied one field at a time rather than spread, so an undeclared fact stays
    // absent. `readWorkUnitFile` treats a missing optional field differently from an
    // empty one, and "the caller said nothing" is not "the caller said none".
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