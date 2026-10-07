import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Scratch tree construction.
 *
 * The working tree is never written. Every mutation is applied to a throwaway
 * copy, so a killed runner can only ever damage a directory the OS reclaims.
 * That is the whole reason for this file: the obvious design — mutate in place,
 * restore in a `finally` — fails on SIGKILL, which is exactly what happens when
 * a CI job times out.
 *
 * The copy has to be a usable repository, not merely a file tree. Without a
 * `git init`, `git check-ignore` reports "not a git repository", so six of the
 * seven repo-hygiene tests fail whatever mutation is applied — and a mutation run
 * would then report every defect as caught for a reason that has nothing to do
 * with the defect. That is a systematic false positive, which is worse than no
 * runner at all: it looks like evidence.
 */

/**
 * Not copied by the generic loop. Matched by name rather than by entry type,
 * because a name in this set is not always a directory: inside a linked worktree
 * `.git` is a *file* naming the real git directory, so an `isDirectory()` guard
 * would copy it and leave the scratch tree holding a gitdir pointer for a
 * repository that does not exist.
 *
 * `node_modules` is skipped here and copied explicitly below, so the most
 * expensive entry in the tree is stated rather than implied.
 */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".worktrees",
  ".tmp-test",
  ".factory",
]);

/**
 * A guard, not a description of how the tree is built.
 *
 * `createScratch` copies `node_modules` rather than symlinking it, because a
 * symlink makes `git check-ignore` fail with "beyond a symbolic link". That
 * failure was observed during planning and briefly mistaken for a real defect:
 * it is a property of the scratch tree, not of the mutation. Symlinking saved
 * about three seconds and cost a test whose result was about nothing, which is a
 * bad trade in a tool whose whole output is "was this defect caught".
 *
 * This stays exported so that a regression back to symlinking is caught where it
 * is made, rather than rediscovered later as a hygiene failure nobody can
 * attribute.
 */
export function assertRealNodeModules(scratchPath) {
  const modules = join(scratchPath, "node_modules");
  if (!existsSync(modules)) return;
  if (lstatSync(modules).isSymbolicLink()) {
    throw new Error(
      "the scratch tree's node_modules is a symlink; git check-ignore cannot " +
        "resolve paths beyond one, which would surface as a spurious " +
        "repo-hygiene failure rather than a result about the defect",
    );
  }
}

export function createScratch(repoRoot) {
  const path = mkdtempSync(join(tmpdir(), "factory-mutation-"));

  // From here on, anything can throw. The caller receives a handle to this
  // directory only if construction completes, so a failure part-way through
  // orphans a directory nobody has a way to remove — a full tree on a copy
  // failure, a partial one on a mid-copy failure. Clean up here rather than
  // handing the problem to a caller that never got the handle.
  try {
    for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      cpSync(join(repoRoot, entry.name), join(path, entry.name), {
        recursive: true,
        dereference: false,
      });
    }

    const realModules = join(repoRoot, "node_modules");
    if (existsSync(realModules)) {
      // dereference: false, and not a symlink either: node_modules/.bin holds
      // relative symlinks, and dereferencing would replace each one with a
      // duplicated real file.
      cpSync(realModules, join(path, "node_modules"), {
        recursive: true,
        dereference: false,
      });
    }

    // A copied `.gitignore` is inert until something resolves it, and the thing
    // that resolves it is git. Without this repository the repo-hygiene tests
    // cannot run in the scratch tree at all: `git check-ignore` reports "not a
    // git repository" and they fail before any mutation is applied.
    execFileSync("git", ["init", "--quiet", path], { stdio: "ignore" });
  } catch (error) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort. A cleanup failure must not replace the error that explains
      // why construction failed, which is the one thing a caller needs to read.
    }
    throw error;
  }

  let cleaned = false;
  return {
    path,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(path, { recursive: true, force: true });
    },
  };
}
