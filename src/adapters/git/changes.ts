import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Reports the files a dispatched Work Unit changed in its worktree.
 *
 * Injected into the pipeline rather than called from it, because reading a diff is
 * Git's job and the kernel should not know that. A caller without a provider gets
 * no scope gate — which is a visible absence, not a silent pass: the pipeline records
 * that scope could not be checked.
 *
 * `git status --porcelain` rather than `git diff` because agent work is normally
 * uncommitted, and an untracked new file is exactly the case a scope check must not
 * miss.
 *
 * `--untracked-files=all` is load-bearing. Without it Git collapses an untracked
 * *directory* into a single entry — a run that created `newdir/` reported one change
 * named `newdir/` rather than the files inside it, so a scope check compared a
 * directory against file paths and reached the wrong verdict either way. Caught only
 * by running this against a real repository; the unit test used files at the root.
 */
export type ChangedFiles = (worktreePath: string) => Promise<string[]>;

/** Maximum bytes read from `git status`. A pathological tree must not exhaust memory. */
const MAX_STATUS_BYTES = 8 * 1024 * 1024;

export const gitChangedFiles: ChangedFiles = async (worktreePath) => {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: worktreePath,
    maxBuffer: MAX_STATUS_BYTES,
  });
  return parsePorcelain(stdout);
};

/**
 * Parses `git status --porcelain` into repository-relative paths.
 *
 * Renames are reported as `old -> new`; the new path is the one the agent touched,
 * and the old one no longer exists. Quoted paths (Git quotes any path containing a
 * space or non-ASCII byte) are unquoted, so a file named `my file.ts` is compared as
 * itself rather than as a literal `"my file.ts"`.
 */
export function parsePorcelain(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    // `XY path` — the two status columns are fixed width.
    const entry = line.slice(3);
    if (entry.length === 0) continue;
    files.push(unquote(entry.includes(" -> ") ? entry.slice(entry.indexOf(" -> ") + 4) : entry));
  }
  return [...new Set(files)];
}

function unquote(path: string): string {
  const match = /^"(.*)"$/.exec(path);
  if (match === null) return path;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return path;
  }
}