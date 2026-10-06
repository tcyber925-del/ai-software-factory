import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * Runs a subprocess with stdout and stderr redirected to temporary files.
 *
 * **Not a pipe, and that is load-bearing.** A runtime agent streaming progress to
 * stdout deadlocks when its output is a pipe. Measured against `opencode run` with a
 * demanding prompt: pipe-to-parent hung until the 150s ceiling, the same command with
 * stdout on a file completed in 115s. A `sh -c` wrapper that still ended in a pipe
 * hung too, so it is the pipe itself and not the spawning style.
 *
 * Files sidestep that entirely, and remove any output-size ceiling — `execFile`'s
 * `maxBuffer` would otherwise fail a long agent transcript.
 */
export const defaultCommandRunner: CommandRunner = {
  async run(command, args, cwd, options) {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const dir = mkdtempSync(join(tmpdir(), "factory-cmd-"));
    const stdoutPath = join(dir, "stdout");
    const stderrPath = join(dir, "stderr");
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");

    try {
      return await new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ["ignore", stdoutFd, stderrFd] });
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          timedOut = true;
          // SIGTERM can be ignored by a wedged child, leaving the timeout useless.
          child.kill("SIGKILL");
        }, timeoutMs);
        // The timer must not hold the event loop open once the child has exited.
        timer.unref?.();

        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          action();
        };

        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", (code, signal) => {
          finish(() => {
            if (timedOut) {
              // The wording matters: `#mapFailure` and `asRuntimeFailure` classify from
              // the message, so a timeout must be identifiable without inspecting
              // process properties at three separate call sites.
              reject(new Error(`timed out after ${timeoutMs}ms: ${command} ${args[0] ?? ""}`.trim()));
              return;
            }
            const stdout = readFileSync(stdoutPath, "utf8");
            const stderr = readFileSync(stderrPath, "utf8");
            if (code !== 0) {
              reject(new Error(`exited ${code ?? signal ?? "unknown"}: ${command} ${args[0] ?? ""}`.trim()));
              return;
            }
            resolve({ stdout, stderr });
          });
        });
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
      rmSync(dir, { recursive: true, force: true });
    }
  },
};