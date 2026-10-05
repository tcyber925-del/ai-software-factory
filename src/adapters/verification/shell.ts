import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionEvent, VerificationCheck, VerificationResult } from "../../protocol.js";

/**
 * Deterministic shell verification.
 *
 * Independence is structural, not merely documented: `runShellVerification`
 * accepts no execution record, no runtime status, and no agent state. It cannot
 * consult runtime completion even if a caller wanted it to, because nothing in
 * its inputs carries that information. It executes commands and reports what
 * those commands actually returned.
 */

const execFileAsync = promisify(execFile);

export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ShellRunner {
  run(command: string, args: string[], cwd: string): Promise<ShellCommandResult>;
}

export const defaultShellRunner: ShellRunner = {
  async run(command, args, cwd) {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: unknown };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  },
};

export interface ShellCheckSpec {
  name: string;
  command: string;
  args?: string[];
}

export interface ShellVerificationOptions {
  workUnitId: string;
  checks: ShellCheckSpec[];
  cwd: string;
  runner?: ShellRunner;
  attempt?: number;
  id?: () => string;
  now?: () => string;
  evidenceTailBytes?: number;
}

export interface ShellVerificationOutput {
  result: VerificationResult;
  events: ExecutionEvent[];
}

export async function runShellVerification(options: ShellVerificationOptions): Promise<ShellVerificationOutput> {
  const { workUnitId, checks, cwd } = options;
  const runner = options.runner ?? defaultShellRunner;
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  const tailBytes = options.evidenceTailBytes ?? 2000;

  const events: ExecutionEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown>): void => {
    events.push({ id: id(), workUnitId, type, timestamp: now(), payload });
  };

  emit("verification.started", { checks: checks.map((check) => check.name) });

  const executed: VerificationCheck[] = [];
  for (const check of checks) {
    const result = await runner.run(check.command, check.args ?? [], cwd);
    const status = result.exitCode === 0 ? "passed" : "failed";
    executed.push({
      name: check.name,
      status,
      evidence: evidenceFor(check, result, tailBytes),
    });
  }

  const failed = executed.filter((check) => check.status === "failed");
  const result: VerificationResult = {
    workUnitId,
    status: failed.length === 0 ? "passed" : "failed",
    checks: executed,
  };
  if (options.attempt !== undefined) result.attempt = options.attempt;

  emit(failed.length === 0 ? "verification.passed" : "verification.failed", {
    failed: failed.map((check) => check.name),
  });

  return { result, events };
}

function evidenceFor(check: ShellCheckSpec, result: ShellCommandResult, tailBytes: number): string {
  const invocation = [check.command, ...(check.args ?? [])].join(" ");
  const output = `${result.stdout}${result.stderr}`.trimEnd();
  const tail = output.length > tailBytes ? output.slice(-tailBytes) : output;
  const summary = `$ ${invocation}\nexit=${result.exitCode}`;
  return tail.length > 0 ? `${summary}\n${tail}` : summary;
}