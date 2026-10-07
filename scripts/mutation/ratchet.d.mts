/**
 * Type declarations for `scripts/mutation/ratchet.mjs`. Kept in step with the
 * module by hand, like the other mutation-runner declarations.
 */

/** The committed floor: what the corpus must never fall below. */
export interface Ratchet {
  /** Minimum number of defects that must have been evaluated. */
  defects: number;
}

/** What a run produces for one defect. Structurally compatible with `DefectOutcome` from `evaluate.mjs`. */
export interface RatchetOutcome {
  id: string;
  outcome: string;
  /** Test files that failed only because of the mutation. */
  caughtBy?: string[];
  /** The test file the defect was aimed at. Falls back to the corpus lookup by id. */
  aimsAt?: string;
}

export interface RatchetVerdict {
  ok: boolean;
  problems: string[];
}

/**
 * Guards the corpus against being traded away quietly: fails when the corpus
 * shrank, when a defect escaped or could not be evaluated, or when a caught
 * defect's own `aimsAt` was not among the files that caught it.
 */
export declare function checkRatchet(
  ratchet: Ratchet,
  outcomes: RatchetOutcome[],
): RatchetVerdict;
