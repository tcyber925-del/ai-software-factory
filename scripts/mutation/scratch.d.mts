/**
 * Type declarations for `scripts/mutation/scratch.mjs`.
 *
 * See `corpus.d.mts` for why the runner modules carry declaration files rather
 * than `@ts-expect-error` on the import: TS7016 is raised by the import itself,
 * so nothing after it can suppress it.
 */

/** A throwaway copy of the repository that defects are applied to. */
export interface Scratch {
  /** Absolute path of the scratch tree. */
  path: string;
  /** Removes the scratch tree. Safe to call more than once. */
  cleanup: () => void;
}

/**
 * Copies `repoRoot` into a fresh directory under the OS temp directory, then
 * `git init`s it. Only reads from `repoRoot` — the working tree is never written.
 *
 * The `git init` is not optional decoration: without a repository of its own, a
 * scratch tree cannot run the repo-hygiene tests, because `git check-ignore`
 * reports "not a git repository" and they fail whatever mutation is applied.
 */
export declare function createScratch(repoRoot: string): Scratch;

/**
 * Throws when the scratch tree's `node_modules` is a symlink, which would make
 * `git check-ignore` fail with "beyond a symbolic link" and surface as a
 * repo-hygiene failure that has nothing to do with the defect under test.
 *
 * `createScratch` copies `node_modules` rather than symlinking it, so this is a
 * guard against a regression rather than a description of current behaviour. A
 * missing `node_modules` is not an error: there is nothing to resolve past.
 */
export declare function assertRealNodeModules(scratchPath: string): void;
