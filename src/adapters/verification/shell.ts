import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionEvent, VerificationCheck, VerificationResult } from "../../protocol.js";
import type { EventLog } from "../../state/event-log.js";
import { evaluateProcessPolicy } from "../../security/process-policy.js";
import { redactSecrets, safeCommandInvocation, sanitizeEvidence } from "../../security/redaction.js";

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
  run(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<ShellCommandResult>;
}

export const defaultShellRunner: ShellRunner = {
  async run(command, args, cwd, env) {
    const policy =
      env === undefined
        ? evaluateProcessPolicy({ role: "verification.shell", hostEnv: process.env as Record<string, string | undefined> })
        : undefined;
    const effectiveEnv = env ?? policy?.effectiveEnv;
    if (env === undefined) {
      if (!policy || policy.decision !== "allow" || !effectiveEnv) {
        throw new Error(`verification command refused by process policy: ${policy?.reasonCode ?? "policy_unavailable"}`);
      }
    }
    try {
      const { stdout, stderr } = await execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024, env: effectiveEnv });
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
  /** When provided, verification events are persisted durably. */
  eventLog?: EventLog;
  runId?: string;
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

  const attempt = options.attempt ?? 1;
  const runId = options.runId ?? id();
  const log = options.eventLog;

  const persist = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    if (log === undefined) return;
    await log.append([{ workUnitId, runId, source: "factory", type, payload }]);
  };

  emit("verification.started", { checks: checks.map((check) => check.name), attempt });
  await persist("verification.started", { checks: checks.map((check) => check.name), attempt });

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
    attempt,
  };

  const outcome = failed.length === 0 ? "verification.passed" : "verification.failed";
  const outcomePayload = { failed: failed.map((check) => check.name), attempt };
  emit(outcome, outcomePayload);
  await persist(outcome, outcomePayload);

  return { result, events };
}

function evidenceFor(check: ShellCheckSpec, result: ShellCommandResult, tailBytes: number): string {
  const invocation = safeCommandInvocation(check.command, check.args ?? []);
  const output = redactSecrets(`${result.stdout}${result.stderr}`.trimEnd());
  const tail = output.length > tailBytes ? output.slice(-tailBytes) : output;
  const boundedTail = tail.length > 0 ? sanitizeEvidence(tail, Math.max(512, tailBytes)) : "";
  const summary = `$ ${invocation}\nexit=${result.exitCode}`;
  return boundedTail.length > 0 ? `${summary}\n${boundedTail}` : summary;
}