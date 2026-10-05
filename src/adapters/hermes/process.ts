import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Command boundary for the Hermes adapter.
 *
 * Injected so tests are deterministic and never require Hermes to be installed —
 * the same boundary the Herdr adapter uses. Every Hermes-specific invocation is
 * assembled here and nowhere else, so `WorkUnit` and `WorkerRuntime` stay free of
 * provider detail.
 */

const execFileAsync = promisify(execFile);

export interface HermesCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HermesCommandRunner {
  run(args: string[], cwd: string, timeoutMs: number): Promise<HermesCommandResult>;
}

export const HERMES_BIN = "hermes";

export const defaultHermesCommandRunner: HermesCommandRunner = {
  async run(args, cwd, timeoutMs) {
    try {
      const { stdout, stderr } = await execFileAsync(HERMES_BIN, args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  },
};

/**
 * `hermes --version` reports the agent version. Used for `health()` and recorded
 * in runtime evidence so a dispatched execution can be attributed to a specific
 * Hermes build.
 */
export async function hermesVersion(runner: HermesCommandRunner, cwd: string): Promise<string | undefined> {
  const result = await runner.run(["--version"], cwd, 30_000);
  if (result.exitCode !== 0) return undefined;
  const first = result.stdout.split("\n")[0]?.trim() ?? "";
  return first.length > 0 ? first : undefined;
}

/**
 * `hermes --usage-file <path> -z <prompt>` writes JSON usage after a one-shot
 * run. That file is the closest thing to machine-readable execution evidence
 * Hermes emits, so it is read back and returned as operational evidence.
 *
 * This is *runtime* evidence about token/time cost. It is not verification, and
 * the adapter never treats it as such — see `HermesRuntime.waitAgent`.
 */
export interface HermesUsage {
  [key: string]: unknown;
}

export async function readUsageFile(path: string): Promise<HermesUsage | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as HermesUsage) : undefined;
  } catch {
    // A missing or malformed usage file must not fail execution: it is
    // supplementary evidence, not the result of the work.
    return undefined;
  }
}

/** Scratch directory for one run's usage file, isolated per execution. */
export async function createUsageDir(): Promise<{ dir: string; usagePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "factory-hermes-"));
  return { dir, usagePath: join(dir, "usage.json") };
}

export async function cleanupUsageDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}