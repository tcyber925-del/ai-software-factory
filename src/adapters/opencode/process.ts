import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Default ceiling for a runtime subprocess.
 *
 * Every call this runner makes is a process that can wedge — `git worktree add`
 * waiting on a lock, an agent that never returns. An unbounded call means a single
 * stuck process stalls the dispatch forever with no error recorded, which is worse
 * than a crash: the event log then reads as work-in-progress indefinitely.
 *
 * Long enough that a healthy operation is never cut off, short enough that a stuck
 * one becomes a recorded failure.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

export interface CommandOptions {
  /** Overrides `DEFAULT_COMMAND_TIMEOUT_MS` for a call known to be long-running. */
  timeoutMs?: number;
}

export interface CommandResult { stdout: string; stderr: string; }
export interface CommandRunner { run(command: string, args: string[], cwd: string, options?: CommandOptions): Promise<CommandResult>; }

export const defaultCommandRunner: CommandRunner = {
  async run(command, args, cwd, options) {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    try {
      return await execFileAsync(command, args, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
        // SIGTERM can be ignored by a wedged child, leaving the timeout useless.
        killSignal: "SIGKILL",
      });
    } catch (error) {
      if (isTimeout(error)) {
        // The wording matters: `#mapFailure` and `asRuntimeFailure` both classify
        // from the message, so a timeout must be identifiable without inspecting
        // Node's error properties at three call sites.
        throw new Error(`timed out after ${timeoutMs}ms: ${command} ${args[0] ?? ""}`.trim(), { cause: error });
      }
      throw error;
    }
  },
};

/**
 * Distinguishes "exceeded the timeout" from "exited non-zero".
 *
 * Node signals the former by killing the child, so `killed` is set and `signal` is
 * the kill signal. A command that fails on its own is never killed, so this cannot
 * be confused with an ordinary failure.
 */
function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { killed?: unknown; signal?: unknown; code?: unknown };
  if (candidate.code === "ETIMEDOUT") return true;
  return candidate.killed === true && typeof candidate.signal === "string";
}