import type { Defect } from "./corpus.mjs";

/**
 * Type declarations for `scripts/mutation/evaluate.mjs`.
 *
 * See `corpus.d.mts` for why the runner modules carry declaration files rather
 * than `@ts-expect-error` on the import: TS7016 is raised by the import itself,
 * so nothing after it can suppress it.
 *
 * These are declarations of a module whose parameter and result are contracts
 * with a later runner, so they state the whole outcome shape rather than the
 * subset one test happens to assert on.
 */

/**
 * What evaluating a defect can conclude.
 *
 *   caught       the suite failed on a mutated tree that was green beforehand.
 *   escaped      the suite passed on a mutated tree.
 *   corpus-error the defect could not be evaluated at all — never an escape.
 */
export type DefectOutcomeKind = "caught" | "escaped" | "corpus-error";

export interface DefectOutcome {
  /** The defect's id, or `<unnamed>` when the entry had none. */
  id: string;
  outcome: DefectOutcomeKind;
  /**
   * Test files that failed on the mutated tree and were green in the baseline.
   * Empty for an escape, and empty for a catch that no check can be credited for
   * — a mutated tree that would not collect, say.
   */
  caughtBy: string[];
  /** Why this outcome, in prose: a check that named it, or the problem that stopped it. */
  reason: string;
  durationMs: number;
  /**
   * The test file this defect aimed at, carried over from its corpus entry.
   * Absent, not guessed, when the entry named no aim — so a downstream guard
   * can tell "no aim" from "aim unknown at evaluation time".
   */
  aimsAt?: string;
}

export interface EvaluationOptions {
  /**
   * Wall-clock ceiling for each of the two suite runs, in milliseconds. Defaults
   * to `RUN_TIMEOUT_MS`. Exceeding it is a `corpus-error`, never an escape.
   */
  timeoutMs?: number;
}

/** Wall-clock ceiling for a single suite run, in milliseconds. */
export declare const RUN_TIMEOUT_MS: number;

/**
 * Test files excluded from the suite an evaluation runs — this file's own tests
 * among them, since running the evaluator inside the suite it evaluates would
 * recurse. Exported so a runner can refuse a corpus defect that aims at an
 * excluded file rather than reporting it as an escape.
 */
export declare const SUITE_EXCLUDE: string[];

/**
 * The failing test files a run reported, deduplicated and sorted. An empty list
 * means the run named no file, which is not the same as a run that passed: read
 * the exit code as well.
 */
export declare function extractFailingTests(output: string): string[];

/**
 * Evaluates one defect against a scratch copy of `repoRoot`, running the suite
 * once unmutated to establish a baseline and once mutated, and reports which
 * checks failed only in the second run. Never throws for a bad defect, a drifted
 * anchor, a tree that is already red, a suite that will not start, or a run that
 * does not finish: each is returned as a `corpus-error`.
 *
 * `defect` is the shape `loadCorpus` validates toward. That function returns
 * whatever the file contained, typed `unknown[]`, so narrow its entries before
 * calling — an entry that is not a usable defect yields a `corpus-error` naming
 * the problem rather than an exception belonging to no defect.
 *
 * Only `repoRoot` is read. The mutation is written into the scratch copy, never
 * into the caller's tree.
 */
export declare function evaluateDefect(
  repoRoot: string,
  defect: Defect,
  options?: EvaluationOptions,
): Promise<DefectOutcome>;
