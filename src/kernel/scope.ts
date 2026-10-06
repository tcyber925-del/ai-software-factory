/**
 * Scope enforcement.
 *
 * A Work Unit's declared `paths` are its write boundary. Until this module existed
 * they were advisory: `paths` fed conflict detection and nothing else, so an agent
 * could edit any file in the worktree and still reach `ready`. Dogfooding found
 * exactly that — a dispatched Work Unit wrote outside its declared paths, including
 * to this repository's `package-lock.json`.
 *
 * Kept free of I/O so the rule is testable on its own. The caller supplies the
 * changed-file list; this module decides whether it is in scope.
 *
 * The path comparison is shared with the scheduler on purpose. Two notions of "these
 * paths are related" that disagree would let work be serialized for a conflict it
 * never had, or allowed past a boundary it crossed.
 */

/** A changed file and which declared path, if any, should have covered it. */
export interface OutOfScopeChange {
  file: string;
  /** The declared path this file sits inside, or undefined when none matched. */
  declaredPath?: string;
  /**
   * True when the file is this repository's dependency lockfile.
   *
   * Called out separately because the lockfile is a reviewed artifact in this
   * project: `docs/verification-and-merge-gates.md` states that an unexplained
   * dependency change is a scope finding. A generic "out of scope" line is easy to
   * skim past; a named lockfile change is not.
   */
  lockfile: boolean;
}

export interface ScopeCheck {
  /** Files the Work Unit changed. */
  changed: string[];
  /** The subset outside every declared path. Empty means within scope. */
  outOfScope: OutOfScopeChange[];
  /**
   * True when the Work Unit declared no `paths`.
   *
   * Deliberately **not** treated as "no limit, silently". A Work Unit that says
   * nothing about its scope gets no gate, and that is reported rather than assumed —
   * otherwise an undeclared Work Unit looks exactly like a narrowly-scoped one.
   */
  undeclared: boolean;
}

/**
 * Files this project treats as dependency locks, named in a scope violation.
 *
 * Not a general-purpose constant: it exists because this repository has a policy
 * about its lockfile, and a scope report that omitted it would understate a real
 * finding.
 */
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "go.sum"];

/**
 * Classifies changed files against a Work Unit's declared paths.
 *
 * A declared path matches an exact file or anything beneath it as a directory, using
 * normalized prefixes rather than substring matching — so `src/kernel` covers
 * `src/kernel/pipeline.ts` without also covering `src/kernel-notes.md`.
 */
export function checkScope(changed: string[], declaredPaths: string[] | undefined): ScopeCheck {
  const paths = (declaredPaths ?? []).map(normalizePath).filter((path) => path.length > 0);

  if (paths.length === 0) {
    return { changed, outOfScope: [], undeclared: true };
  }

  const outOfScope: OutOfScopeChange[] = [];
  for (const raw of changed) {
    const file = normalizePath(raw);
    const owner = paths.find((path) => file === path || file.startsWith(`${path}/`));
    if (owner !== undefined) continue;
    outOfScope.push({
      file: raw,
      lockfile: LOCKFILES.includes(file.split("/").pop() ?? file),
    });
  }

  return { changed, outOfScope, undeclared: false };
}

/**
 * Renders a scope violation for an operator.
 *
 * Names every file, because "scope violated" without the list sends the reader to
 * the worktree, which the cleanup has already removed.
 */
export function describeScopeViolation(check: ScopeCheck): string {
  if (check.undeclared) return "scope not declared; no scope gate was applied";
  if (check.outOfScope.length === 0) return "within declared scope";

  const files = check.outOfScope.map((change) => change.file);
  const locks = check.outOfScope.filter((change) => change.lockfile).map((change) => change.file);
  const parts = [`out-of-scope changes: ${files.join(", ")}`];
  if (locks.length > 0) {
    parts.push(
      `${locks.join(", ")} is a dependency lockfile and is reviewed as source; see docs/verification-and-merge-gates.md`,
    );
  }
  return parts.join("; ");
}

/** Normalized so `./src/a/` and `src/a` are the same boundary. */
export function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}