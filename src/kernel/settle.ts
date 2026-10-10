import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Waiting for the work to stop changing.
 *
 * A runtime reporting that its prompt resolved is a statement about a *process*, not
 * about the *work*. The factory treats it as the latter, and `AGENTS.md` already
 * names the error: *"Runtime status must never be treated as proof of Work Unit
 * completion."*
 *
 * When the two differ, everything downstream is built on sand. Verification reads a
 * tree that is still being written to, so it judges a state the run will never
 * report; cleanup then deletes that tree underneath a live agent; and the run can
 * reach `ready` describing work that had not finished arriving.
 *
 * So the pipeline stops inferring completion from a process exit and starts
 * observing the artifact instead: poll the executed worktree until its contents stop
 * changing, then verify that. The observation is of the thing verification actually
 * cares about, so it does not depend on any runtime reporting honestly, and it
 * needs no change to the `WorkerRuntime` contract.
 */

/** A digest of everything in a worktree that could be the agent's work. */
export type WorktreeFingerprint = (worktreePath: string) => Promise<string>;

/**
 * How long to wait for the work to settle.
 *
 * `stableReads` is the real parameter, not `timeoutMs`. An agent edits in bursts —
 * write, think, write — so one quiet interval proves very little; several in a row
 * means the burst is over. `timeoutMs` only bounds a run that never settles, so it
 * can be generous without making the common case slow.
 */
export interface SettleOptions {
  /** Gap between reads. Default 250ms. */
  readonly intervalMs?: number;
  /** Consecutive identical reads required. Default 3. */
  readonly stableReads?: number;
  /** Ceiling on the whole wait. Default 120_000ms. */
  readonly timeoutMs?: number;
  /** Injectable clock, so tests do not depend on wall time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SettleResult {
  /** Whether the worktree stopped changing within the bound. */
  readonly settled: boolean;
  /** How many reads were taken. */
  readonly reads: number;
  /** Why it stopped, when it did not settle. */
  readonly reason?: string;
}

/**
 * Waits until the worktree's fingerprint repeats.
 *
 * Returns `settled: false` rather than throwing when the bound is reached, because an
 * unsettled worktree is a reportable outcome and not a crash: the caller decides what
 * an unfinished run means, and it should have the evidence to say so.
 */
export async function waitForSettledWork(
  fingerprint: WorktreeFingerprint,
  worktreePath: string,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const intervalMs = options.intervalMs ?? 250;
  const stableReads = Math.max(1, options.stableReads ?? 3);
  const timeoutMs = options.timeoutMs ?? 120_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const deadline = Date.now() + timeoutMs;
  let reads = 0;
  let previous: string | undefined;
  let stable = 0;

  for (;;) {
    const current = await fingerprint(worktreePath);
    reads += 1;

    if (current === previous) {
      stable += 1;
      // One read is the baseline, not evidence: the first read has nothing to be
      // compared against, so `stableReads: 3` means three agreeing reads in total.
      if (stable + 1 >= stableReads) return { settled: true, reads };
    } else {
      stable = 0;
    }
    previous = current;

    if (Date.now() >= deadline) {
      return {
        settled: false,
        reads,
        reason: `the worktree was still changing after ${timeoutMs}ms and ${reads} read(s)`,
      };
    }
    await sleep(intervalMs);
  }
}

/**
 * Directories that cannot be the agent's work and would stop a tree ever settling.
 *
 * `node_modules` is written continuously by installs and lives outside anything the
 * factory dispatched work to; `.git` churns on every status read the factory itself
 * performs. Including either would mean a run could never settle on a real project,
 * which is the failure mode of a gate that always fires.
 */
const IGNORED = new Set([".git", "node_modules"]);

/**
 * A digest of the worktree's files: path, size and modification time.
 *
 * **Not** a content hash. Hashing every byte of a real repository on every poll is
 * expensive enough that the wait would dominate the run, and the goal is to notice
 * that *something* is still being written — which a size or mtime change reveals.
 *
 * Size and mtime together rather than mtime alone: a write that lands the same
 * number of bytes in the same millisecond would fool mtime on its own, and that is
 * cheap to avoid.
 */
export const fingerprintWorktree: WorktreeFingerprint = async (worktreePath: string) => {
  const hash = createHash("sha256");
  const entries: string[] = [];

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (IGNORED.has(name)) continue;
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
      } else if (stats.isFile()) {
        entries.push(`${relative(worktreePath, full).split(sep).join("/")}:${stats.size}:${stats.mtimeMs}`);
      }
    }
  };

  walk(worktreePath);
  for (const entry of entries) hash.update(entry).update("\n");
  return hash.digest("hex");
};