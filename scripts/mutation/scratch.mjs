import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
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
 */

/**
 * Copied from the repository root. Everything else is skipped.
 *
 * Matched by name rather than by entry type, because a name in this set is not
 * always a directory. Inside a linked worktree `.git` is a *file* naming the real
 * git directory, so a `isDirectory()` guard would copy it and leave the scratch
 * tree claiming to be a repository it is not. `node_modules` is the same problem
 * from the other side: where it is a symlink rather than a directory, a type
 * guard would copy the link and then the explicit symlink below would fail with
 * EEXIST.
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
 * `node_modules` is symlinked rather than copied, because a copy is hundreds of
 * megabytes and the suite does not need a writable one. The consequence is that
 * `git check-ignore` fails inside the scratch tree with "beyond a symbolic
 * link", which makes tests/repo-hygiene.test.ts fail for a reason that has
 * nothing to do with the defect under test.
 *
 * So: symlink, run, then report a corpus error rather than a false escape.
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

  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    cpSync(join(repoRoot, entry.name), join(path, entry.name), {
      recursive: true,
      dereference: false,
    });
  }

  // Symlink for speed; assertRealNodeModules reports the consequence honestly
  // rather than hiding it.
  const realModules = join(repoRoot, "node_modules");
  if (existsSync(realModules)) {
    symlinkSync(realModules, join(path, "node_modules"));
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