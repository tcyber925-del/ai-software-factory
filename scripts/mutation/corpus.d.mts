/**
 * Type declarations for `scripts/mutation/corpus.mjs`.
 *
 * The runner modules are plain ESM on purpose: they spawn processes and read
 * JSON without a build step. That leaves TypeScript unable to import them —
 * TS7016 fires on the import line itself, which no cast on the imported binding
 * can suppress. Declaring the shapes here is what lets the test import the
 * module directly instead of asserting its shape through `as unknown as` casts.
 *
 * These declarations are a promise about the module, so they are kept in step
 * with it deliberately: a stale declaration is worse than the `@ts-expect-error`
 * it replaced, because it would let a rename pass type-checking and fail at run
 * time instead.
 */

/**
 * A well-formed defect, as authored in `defects/mutations.json`. This is the
 * shape `loadCorpus` validates *toward*, not the shape it guarantees — it hands
 * back whatever the file contained.
 */
export interface Defect {
  id: string;
  /** The test file that must fail when this defect is applied. */
  aimsAt: string;
  /** Why this defect is worth running, in enough prose to review. */
  why: string;
  /** Path of the file to mutate, relative to the repository root. */
  file: string;
  /** Source text the anchor must match exactly once. */
  find: string;
  /** Literal text to put in the anchor's place. */
  replace: string;
  /** Whether the suite is expected to catch this defect. */
  expected: string;
}

export declare class CorpusError extends Error {
  constructor(defectId: string, file: string, message: string);
  /** The defect the problem belongs to, or a `<...>` placeholder for the corpus itself. */
  readonly defectId: string;
  /** The file the problem is about. */
  readonly file: string;
}

/**
 * Reads and validates the corpus. Never throws for a malformed corpus: every
 * problem is returned as a `CorpusError`, because a defect that never ran is not
 * evidence of anything and must not be reportable as one that escaped.
 *
 * `defects` is the raw parsed array, deliberately not a filtered one. A corpus
 * containing a `null` reports that entry in `errors` *and* hands it back in
 * `defects`, because dropping it would leave a caller unable to say which entry
 * went missing, and "these defects ran" has to stay checkable against the file.
 * The consequence is that an element is exactly as trustworthy as `errors` says
 * it is: narrow it before use, or pair each entry with its corpus error.
 */
export declare function loadCorpus(repoRoot: string): {
  defects: unknown[];
  errors: CorpusError[];
};

/**
 * What `applyDefect` actually needs: a unique anchor and its literal
 * replacement. `id` and `file` are read only to label an error, and
 * `aimsAt`/`why`/`expected` are not read at all — `loadCorpus` is what
 * guarantees those. Declaring the full `Defect` here would be a lie about the
 * parameter and would force every caller to invent fields the function ignores.
 */
export interface AnchoredMutation {
  find: string;
  replace: string;
  /** Labels a thrown `CorpusError`; absent renders as `<unnamed>`. */
  id?: string;
  /** Labels a thrown `CorpusError`; absent renders as `<unknown>`. */
  file?: string;
}

/** Applies a defect to a source string; throws `CorpusError` if the anchor is not unique. */
export declare function applyDefect(source: string, defect: AnchoredMutation): { mutated: string };

/** Reads the defect's target file and applies the defect without writing it back. */
export declare function mutateFile(repoRoot: string, defect: Defect): { mutated: string };
