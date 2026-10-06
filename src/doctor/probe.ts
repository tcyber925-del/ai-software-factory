import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Environment probes for `factory doctor`.
 *
 * All environment access is behind this interface so diagnostics can be tested
 * against a fixture rather than a developer's machine. That is what keeps CI
 * independent of developer-specific local configuration, and it is why the
 * doctor can report deterministically.
 *
 * Every method here is read-only. None of them writes, stages, cleans, or
 * otherwise mutates the project.
 */

const execFileAsync = promisify(execFile);

export interface WorktreeSupport {
  supported: boolean;
  /** Why worktree support is unavailable, when it is. */
  reasons: string[];
}

export interface RepositoryState {
  isGitRepository: boolean;
  clean: boolean;
  detachedHead: boolean;
  insideLinkedWorktree: boolean;
  branch?: string;
  /** Paths Git already reports as registered worktrees. */
  worktrees: string[];
}

export interface RuntimeAvailability {
  available: boolean;
  version?: string;
}

export interface DoctorProbe {
  cwd(): string;
  nodeVersion(): string;
  worktreeSupport(): Promise<WorktreeSupport>;
  repositoryState(): Promise<RepositoryState>;
  runtimeAvailability(runtime: string): Promise<RuntimeAvailability>;
  fileExists(relativePath: string): boolean;
}

/**
 * How long a `<runtime> --version` probe may take before it is treated as unusable.
 *
 * Long enough for a healthy binary on a loaded machine, short enough that a wedged
 * one cannot stall a dispatch decision indefinitely.
 */
export const RUNTIME_PROBE_TIMEOUT_MS = 5_000;

/** Probes the real machine. Read-only. */
export function createSystemProbe(repositoryRoot?: string): DoctorProbe {
  const root = resolve(repositoryRoot ?? process.cwd());

  const git = async (args: string[]): Promise<{ stdout: string; code: number }> => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
      return { stdout, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; code?: unknown };
      return { stdout: failure.stdout ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
    }
  };

  return {
    cwd: () => root,
    nodeVersion: () => process.version,

    async worktreeSupport() {
      if ((await git(["--version"])).code !== 0) {
        return { supported: false, reasons: ["git is not available on PATH"] };
      }
      const inside = await git(["rev-parse", "--is-inside-work-tree"]);
      if (inside.code !== 0 || inside.stdout.trim() !== "true") {
        return { supported: false, reasons: ["not inside a Git working tree"] };
      }
      // `worktree add` fails on very old Git; probe support rather than assume it.
      const probe = await git(["worktree", "list", "--porcelain"]);
      if (probe.code !== 0) {
        return { supported: false, reasons: ["this Git version does not support worktrees"] };
      }
      return { supported: true, reasons: [] };
    },

    async repositoryState() {
      const inside = await git(["rev-parse", "--is-inside-work-tree"]);
      if (inside.code !== 0 || inside.stdout.trim() !== "true") {
        return {
          isGitRepository: false,
          clean: false,
          detachedHead: false,
          insideLinkedWorktree: false,
          worktrees: [],
        };
      }
      const status = await git(["status", "--porcelain"]);
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const commonDir = await git(["rev-parse", "--git-common-dir"]);
      const gitDir = await git(["rev-parse", "--git-dir"]);
      const listed = await git(["worktree", "list", "--porcelain"]);

      const branchName = branch.stdout.trim();
      return {
        isGitRepository: true,
        clean: status.stdout.trim().length === 0,
        detachedHead: branchName === "HEAD" || branchName.length === 0,
        // A linked worktree has a git dir distinct from the common dir.
        insideLinkedWorktree: resolve(root, gitDir.stdout.trim()) !== resolve(root, commonDir.stdout.trim()),
        worktrees: listed.stdout
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice("worktree ".length).trim()),
        ...(branchName === "HEAD" || branchName.length === 0 ? {} : { branch: branchName }),
      };
    },

    async runtimeAvailability(runtime) {
      try {
        const { stdout } = await execFileAsync(runtime, ["--version"], {
          cwd: root,
          maxBuffer: 1024 * 1024,
          // Without a timeout this call blocks indefinitely on a wedged binary, and
          // a probe that hangs is indistinguishable from one that is merely slow.
          // More importantly, an unbounded call makes the report machine-timing
          // dependent: two runs of an unmodified doctor could disagree, which breaks
          // the determinism `runDoctor` documents and its tests assert.
          timeout: RUNTIME_PROBE_TIMEOUT_MS,
        });
        const version = stdout.trim().split("\n")[0] ?? "";
        return version.length > 0 ? { available: true, version } : { available: true };
      } catch {
        // A timeout, a non-zero exit, or a missing binary all mean the same thing
        // here: this runtime is not usable. The reason is deliberately not
        // distinguished — the operator's remedy is the same in every case.
        return { available: false };
      }
    },

    fileExists: (relativePath) => existsSync(resolve(root, relativePath)),
  };
}