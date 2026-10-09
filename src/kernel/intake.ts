import type { WorkUnit } from "../protocol.js";

/**
 * The provider-neutral intake boundary.
 *
 * Intake is where an external task system — Linear today, GitHub next — hands the
 * factory work to execute. Every provider agrees on the same handover, and none of
 * them may renegotiate it by widening `WorkUnit`.
 *
 * Two rules hold this together.
 *
 * **The Work Unit is the only thing that crosses the boundary.** Provider identity,
 * the source reference and the decision are recorded *around* a Work Unit, never
 * inside one. `WorkUnit` is the factory's portable execution contract: it is what a
 * scheduler places, what a runtime receives and what the integration gate judges. The
 * moment a Linear status or a GitHub label becomes a field on it, work compiled from
 * one provider is no longer portable to another, and the protocol stops being a
 * contract and becomes an implementation detail of whichever provider arrived first.
 *
 * **Refusal is a first-class outcome, not an absence.** A refused record produces a
 * complete `IntakeResult` carrying the reason it was refused. `accepted` and
 * `refused` are the only two outcomes and they are mutually exclusive, so a caller
 * cannot hold a Work Unit it failed to justify: refusing means no Work Unit exists,
 * and the type makes that unrepresentable rather than merely discouraged.
 *
 * Evaluation is deterministic. The same record and the same policy configuration
 * produce an identical result — no clock, no randomness, no inferred fields — so a
 * refusal can be audited and reproduced instead of being a thing that happened once.
 *
 * Provider-specific eligibility rules stay in the provider adapter. This module knows
 * *that* a record was refused and *why in general terms*; it does not know what a
 * status allowlist, a `blockedBy` relation or a label means. See
 * `src/adapters/linear/intake.ts` for that half.
 */

/**
 * The coarse reason a record was refused, in provider-neutral terms.
 *
 * Deliberately small. This is the vocabulary the factory itself can reason about —
 * a caller can act on "this is blocked by an incomplete dependency" without knowing
 * that Linear calls it `blocked_by_incomplete_issue`. The provider's own reason code
 * travels alongside it in `IntakeRefusal.providerReason` as an opaque string, so no
 * provider-specific detail is lost by being summarised rather than dropped.
 *
 * | Classification | Meaning |
 * | --- | --- |
 * | `not_dispatchable` | The provider's own hard exclusion: this kind of record never dispatches, whatever configuration says |
 * | `not_allowlisted` | The record is not in an explicit allowlist a human has approved |
 * | `policy_blocked` | A declared signal — a label, a flag, a reviewer — blocks dispatch |
 * | `dependency_incomplete` | A known predecessor has not finished |
 * | `dependency_unresolved` | A predecessor could not be resolved, so readiness cannot be established |
 * | `requirements_undeclared` | The record does not state what the factory needs |
 * | `target_undeclared` | No target repository was supplied, and the factory will not infer one |
 */
export type IntakeRefusalClassification =
  | "not_dispatchable"
  | "not_allowlisted"
  | "policy_blocked"
  | "dependency_incomplete"
  | "dependency_unresolved"
  | "requirements_undeclared"
  | "target_undeclared";

/** Why one record was refused, in both general and provider-native terms. */
export interface IntakeRefusal {
  classification: IntakeRefusalClassification;
  /** The provider's own reason code, carried through opaquely. */
  providerReason: string;
  /** Human-readable detail. Never parsed by the factory. */
  detail?: string;
  /** Which provider check decided, in the provider's own stable order. */
  check?: string;
}

/** An adapter's eligibility verdict: either eligible, or refused with a reason. */
export type IntakeEligibility = { eligible: true } | { eligible: false; refusal: IntakeRefusal };

/**
 * Where a record came from, recorded beside the Work Unit rather than inside it.
 *
 * This is the provenance answer to "which system is this work from?", and it is the
 * only place a provider names itself. Keeping it here is what lets a Work Unit stay
 * provider-neutral while a human can still trace the unit back to the issue that
 * produced it.
 */
export interface IntakeSource {
  /** Stable provider identifier, e.g. `linear`. Never a UI label. */
  provider: string;
  /** The provider's own identifier for the record, e.g. `ENG-902`. */
  reference: string;
  /** Deep link to the source record, when the provider has one. */
  url?: string;
}

/** The result of intake: a Work Unit, or a reason there is none. */
export type IntakeResult =
  | { outcome: "accepted"; source: IntakeSource; workUnit: WorkUnit }
  | { outcome: "refused"; source: IntakeSource; refusal: IntakeRefusal };

/**
 * What every task provider implements.
 *
 * A provider owns its wire shape and its eligibility rules; this interface is the
 * whole of what the factory asks for. `TRecord` is the provider's record type and
 * `TPolicy` its own policy configuration, so neither leaks into the protocol.
 */
export interface ProviderIntakeAdapter<TRecord, TPolicy> {
  /** Stable provider identifier recorded on every result. */
  readonly provider: string;
  /** The provider's own id for a record, e.g. `ENG-902`. */
  sourceId(record: TRecord): string;
  /** Deep link to a record, when the provider has one. */
  sourceUrl?(record: TRecord): string | undefined;
  /** The provider's eligibility rules. Order is the provider's to choose. */
  evaluate(record: TRecord, policy: TPolicy): IntakeEligibility;
  /**
   * Compiles an eligible record into a canonical Work Unit.
   *
   * Returning `undefined` is a refusal, not a degraded pass: a provider that cannot
   * state the work does not get to dispatch it.
   */
  compile(record: TRecord, policy: TPolicy): WorkUnit | undefined;
}

/**
 * Runs one record from one provider through the boundary.
 *
 * Total and synchronous. It cannot throw for a refusal, because a refusal is a value
 * here — the distinction that keeps "the provider declined" from being reported as
 * "the factory broke".
 */
export function runIntake<TRecord, TPolicy>(
  adapter: ProviderIntakeAdapter<TRecord, TPolicy>,
  record: TRecord,
  policy: TPolicy,
): IntakeResult {
  // Read the optional accessor once. Calling it twice would both read as a smell
  // and, under `exactOptionalPropertyTypes`, leave the result too wide to assign.
  const url = adapter.sourceUrl?.(record);
  const source: IntakeSource = {
    provider: adapter.provider,
    reference: adapter.sourceId(record),
    ...(url === undefined ? {} : { url }),
  };

  const eligibility = adapter.evaluate(record, policy);
  if (!eligibility.eligible) {
    return { outcome: "refused", source, refusal: eligibility.refusal };
  }

  const workUnit = adapter.compile(record, policy);
  // Eligible but uncompilable is a refusal with the provider's own reason, so the
  // record is still reported rather than vanishing between the two steps.
  if (workUnit === undefined) {
    return {
      outcome: "refused",
      source,
      refusal: { classification: "requirements_undeclared", providerReason: "no_work_unit_compiled" },
    };
  }

  return { outcome: "accepted", source, workUnit };
}

/**
 * Renders an intake outcome as one line an operator can act on.
 *
 * The wording is fixed on purpose. `work run` once printed "intake refused" while
 * reading `planSchedule`, so a reader had no way to tell a refused Linear issue from
 * a Work Unit the scheduler blocked — an unsatisfied dependency or a missing
 * capability. Two things prevent that here: every line is prefixed `intake`, and
 * every line names the provider and the record, which a scheduling decision does
 * not have.
 *
 * Both the factory's classification and the provider's own reason code are shown.
 * The classification is what a caller can act on across providers; the provider's
 * code is what the provider's own documentation explains. Reporting only one would
 * make the other unreachable.
 */
export function describeIntakeOutcome(result: IntakeResult): string {
  const subject = `${result.source.reference} (${result.source.provider})`;

  if (result.outcome === "accepted") return `intake accepted ${subject}`;

  const parts = [`intake refused ${subject}: ${result.refusal.classification}`];
  parts.push(result.refusal.providerReason);
  if (result.refusal.check !== undefined) parts.push(`check=${result.refusal.check}`);
  if (result.refusal.detail !== undefined) parts.push(result.refusal.detail);
  return parts.join(" ");
}