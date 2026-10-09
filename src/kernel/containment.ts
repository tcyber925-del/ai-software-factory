/**
 * Containment — did the work stay where it was put?
 *
 * The scope gate reads the *worktree's* diff. That is the right thing for it to
 * read, and it is also blind in a specific way: if a dispatched agent writes
 * somewhere other than its worktree, the worktree diff is empty, `outOfScope` is
 * empty, and the gate reports clean. It certifies an escape as an absence of
 * problems.
 *
 * Observed end to end: an agent dispatched through the OpenCode runtime created a
 * branch in the main checkout and edited four files there, two of them outside
 * its declared `paths`. The worktree was untouched. `checkScope` found nothing,
 * verification passed against a green repository, and the run reported `ready`.
 * Every event the factory recorded was true, and the run was still unsafe.
 *
 * This module closes that hole from the other side. It does not ask whether the
 * work stayed in scope — the scope gate already does, against the tree that holds
 * the work. It asks whether anything moved *outside* that tree, by comparing the
 * repository root before and after dispatch. A change there is a containment
 * breach regardless of which mechanism produced it, so this holds even when a
 * runtime ignores the directory it was handed.
 *
 * Deliberately not a sandbox. It cannot stop a write; it can only refuse to call
 * the run successful afterwards. That is the property that was missing.
 */

/**
 * The repository-root state a containment check compares.
 *
 * `head` is included because the observed breach moved it: the agent created a
 * branch. A run that changed only `head` changed something just as real as one
 * that touched files, and neither is visible from a worktree diff.
 */
export interface RepoSnapshot {
  /** `git rev-parse HEAD` — the commit the root checkout is sitting on. */
  readonly head: string;
  /** Repository-relative paths `git status` reports, in the same shape `ChangedFiles` produces. */
  readonly dirty: readonly string[];
}

/**
 * Reads the repository-root state.
 *
 * Injected rather than called directly, for the same reason `ChangedFiles` is: the
 * kernel should not know that Git exists. A caller that supplies no provider gets
 * no containment gate — recorded as unchecked, never as clean.
 */
export type RepoSnapshotProvider = (root: string) => Promise<RepoSnapshot>;

/**
 * Paths the factory writes in its own checkout, which are not containment breaches.
 *
 * A run creates `.factory/workspaces/<id>/` to hold the worktrees it is about to
 * dispatch into, and appends to `.factory/events.jsonl`. Both land in the very
 * directory being watched, so without this the gate would fire on every run and a
 * check that always fires is a check nobody reads.
 *
 * Listed narrowly and explicitly. A prefix allowlist invented here would be exactly
 * the kind of standing exemption that turns a gate into decoration, so anything not
 * named is treated as a breach.
 */
export const FACTORY_OWNED_PREFIXES: readonly string[] = [".factory/workspaces/"];

/** Whether a path is the factory's own bookkeeping rather than an agent's write. */
export function isFactoryOwned(path: string): boolean {
  return FACTORY_OWNED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/** What a containment check found, in enough detail to act on and to explain. */
export interface ContainmentBreach {
  /** `head_moved` when the checkout moved; `files_appeared` when it did not. */
  readonly kind: "head_moved" | "files_appeared";
  readonly headBefore: string;
  readonly headAfter: string;
  /** Files that appeared in the root checkout. Empty for `head_moved`. */
  readonly files: readonly string[];
}

/**
 * Compares two repository-root snapshots.
 *
 * Returns `undefined` when nothing outside the factory's own bookkeeping moved.
 *
 * Only *newly present* dirty paths count. A file already modified before the run
 * was not written by this run, and reporting it would make the gate fire on
 * whatever state the operator happened to be in — including on a repository with
 * uncommitted work, which is the normal state of a checkout someone is using.
 *
 * Files that *disappeared* are not a breach. An agent that reverted a file it had
 * created is not a containment failure, and the scope gate remains the authority on
 * whether the resulting work is correct.
 */
export function detectContainmentBreach(
  before: RepoSnapshot,
  after: RepoSnapshot,
): ContainmentBreach | undefined {
  const files = after.dirty.filter((path) => !before.dirty.includes(path) && !isFactoryOwned(path));
  if (before.head !== after.head) {
    return { kind: "head_moved", headBefore: before.head, headAfter: after.head, files };
  }
  if (files.length > 0) {
    return { kind: "files_appeared", headBefore: before.head, headAfter: after.head, files };
  }
  return undefined;
}

/**
 * Renders a breach for the integration record.
 *
 * Names the files, because the checkout is not cleaned up by the time an operator
 * reads this and a bare "breach" would send them looking somewhere else.
 */
export function describeContainmentBreach(breach: ContainmentBreach): string {
  if (breach.kind === "head_moved") {
    const moved = `the checkout moved from ${breach.headBefore.slice(0, 7)} to ${breach.headAfter.slice(0, 7)}`;
    return breach.files.length === 0
      ? `containment breach: the dispatched work left its worktree — ${moved}`
      : `containment breach: the dispatched work left its worktree — ${moved}, and touched ${breach.files.join(", ")} in the checkout it was given`;
  }
  return `containment breach: the dispatched work wrote outside its worktree — ${breach.files.join(", ")} in the checkout it was given`;
}