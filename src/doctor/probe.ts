import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { defaultCommandRunner } from "../adapters/opencode/process.js";

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
  /**
   * Attempts one trivial prompt against a runtime, to test whether it can actually
   * do the job rather than merely be installed.
   *
   * Optional because it costs a model call per runtime, which is the wrong price for
   * a routine health check. When absent, the report says what it checked — that the
   * binary is installed — and says nothing about dispatch.
   */
  dispatchCheck?(runtime: string): Promise<DispatchCheck>;
}

/**
 * The result of trying to run one prompt.
 *
 * Tri-state, and the middle value is the point. `probed: false` means no invocation
 * is known for that runtime, which is **not** evidence it is broken. Collapsing that
 * into `ok: false` would report a working runtime as failing — the same mistake as
 * claiming availability from a `--version` probe, in the opposite direction.
 */
export interface DispatchCheck {
  /** Whether an attempt was actually made. */
  readonly probed: boolean;
  /** Whether the attempt succeeded. Meaningless when `probed` is false. */
  readonly ok: boolean;
  /** Why it failed, or why it was not probed. */
  readonly detail?: string;
}

/**
 * How long a `<runtime> --version` probe may take before it is treated as unusable.
 *
 * Long enough for a healthy binary on a loaded machine, short enough that a wedged
 * one cannot stall a dispatch decision indefinitely.
 */
/**
 * How long a real dispatch probe may take.
 *
 * Far longer than the `--version` probe, because this one crosses the network, a
 * provider and a credential. A slow answer is not evidence of an unusable runtime,
 * and cutting it short would produce exactly the false negative this probe exists
 * to avoid.
 */
export const DISPATCH_PROBE_TIMEOUT_MS = 60_000;

export const RUNTIME_PROBE_TIMEOUT_MS = 5_000;

/** Probes the real machine. Read-only. */
export interface SystemProbeOptions {
  /**
   * Whether to actually try one prompt against each runtime.
   *
   * Off by default. It costs a model call per runtime and crosses the network, which
   * is the wrong price for a routine check that usually runs in CI. The absence of a
   * dispatch probe is not a silent weakening: the report then says "is installed"
   * rather than "is available", and points at `--probe`.
   */
  readonly probeDispatch?: boolean;
  /** Overrides how a runtime is invoked for the dispatch probe. */
  readonly dispatchCommands?: Readonly<Record<string, readonly string[]>>;
}

export function createSystemProbe(repositoryRoot?: string, options: SystemProbeOptions = {}): DoctorProbe {
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

    // Only runtimes whose invocation this file knows how to write are probed.
    //
    // A generic `<runtime> run <prompt>` was tried and is wrong: `herdr` is a
    // terminal workspace manager with no `run` subcommand at all, and `hermes` takes
    // its prompt as `-z`. Probing them that way reported two working runtimes as
    // broken — a false *negative*, which is the mirror image of the false positive
    // this whole change exists to remove, and no better.
    //
    // So a runtime with no known invocation is reported as unprobed, never as failed.
    // Claiming a failure we did not establish is the same mistake in the other
    // direction.
    ...(options.probeDispatch === true ? dispatchChecksFor(root, options.dispatchCommands) : {}),
  };
}
/**
 * How each probeable runtime is actually invoked.
 *
 * Keyed by the binary name, because that is what is on PATH and therefore what
 * doctor can run. A runtime absent from this map is not probed.
 */
const DEFAULT_DISPATCH_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  opencode: ["run", "reply with the single word ok"],
};

/**
 * Builds the `dispatchCheck` for every runtime with a known invocation.
 *
 * Returns a partial `DoctorProbe` so it can be spread into the probe factory, which
 * keeps a runtime with no known invocation simply absent rather than present-and-failing.
 */
function dispatchChecksFor(
  root: string,
  overrides: Readonly<Record<string, readonly string[]>> = {},
): Pick<DoctorProbe, "dispatchCheck"> {
  const commands = { ...DEFAULT_DISPATCH_COMMANDS, ...overrides };
  return {
    dispatchCheck: async (runtime) => {
      const args = commands[runtime];
      if (args === undefined) return { probed: false, ok: false, detail: "no probe defined for this runtime" };
      // Through the repository's own subprocess runner, not `execFile`.
      //
      // This was `execFile` first, and it reported `opencode` as unable to run a
      // prompt while the identical command finished in three seconds. `execFile`
      // waits on pipes; a runtime agent that keeps a pipe open past its own exit
      // never closes it, so the call sat until the 60s bound and was killed. The
      // repository already learned this — a dispatch through a pipe hung to its
      // ceiling while the same command on a file completed — and the fix is to
      // redirect to a file, which is exactly what `defaultCommandRunner` does.
      //
      // Reusing it rather than reimplementing the redirection is the point: the
      // lesson is encoded once, where the runtimes use it too.
      try {
        // Resolving means it exited zero. `defaultCommandRunner` rejects on a
        // non-zero exit, so success is the absence of the catch below.
        await defaultCommandRunner.run(runtime, [...args], root, {
          timeoutMs: DISPATCH_PROBE_TIMEOUT_MS,
        });
        return { probed: true, ok: true };
      } catch (error) {
        // The runner reaps its process group on timeout, so this is a wedged or
        // missing binary rather than a runtime that answered. Either way the probe
        // did not succeed, and saying so is the whole point of running it.
        return { probed: true, ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : "the probe could not complete" };
      }
    },
  };
}
