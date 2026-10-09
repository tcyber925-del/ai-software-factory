import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parsePorcelain } from "./changes.js";
import type { RepoSnapshot, RepoSnapshotProvider } from "../../kernel/containment.js";

const execFileAsync = promisify(execFile);

/** Maximum bytes read from either command. A pathological tree must not exhaust memory. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Reads the repository root's `HEAD` and dirty set, for the containment check.
 *
 * Both halves matter and they fail differently. `git status` alone misses the
 * observed breach's most alarming half — the agent created a branch, which moves
 * `HEAD` and modifies nothing. `rev-parse HEAD` alone misses every ordinary write.
 * So this reads both, and a failure in either is thrown rather than defaulted:
 *
 * An unreadable snapshot is not an empty one. Returning `head: ""` and no files
 * would compare equal to a snapshot with the same emptiness and report no breach,
 * which is the false green this check exists to replace. Better to fail the run than
 * to certify it.
 */
export const gitRepoSnapshot: RepoSnapshotProvider = async (root) => {
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, maxBuffer: MAX_BYTES }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: root,
      maxBuffer: MAX_BYTES,
    }),
  ]);
  return { head: head.stdout.trim(), dirty: parsePorcelain(status.stdout) };
};