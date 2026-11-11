import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluateProcessPolicy } from "../../security/process-policy.js";

const execFileAsync = promisify(execFile);

export interface HerdrCommandResult {
  stdout: string;
  stderr: string;
}

export interface HerdrCommandRunner {
  run(args: string[], cwd: string, env?: Record<string, string>): Promise<HerdrCommandResult>;
}

export const defaultHerdrCommandRunner: HerdrCommandRunner = {
  async run(args, cwd, env) {
    const policy =
      env === undefined
        ? evaluateProcessPolicy({ role: "runtime.herdr.command", hostEnv: process.env as Record<string, string | undefined> })
        : undefined;
    const effectiveEnv = env ?? policy?.effectiveEnv;
    if (env === undefined) {
      if (!policy || policy.decision !== "allow" || !effectiveEnv) {
        throw new Error(`herdr command refused by process policy: ${policy?.reasonCode ?? "policy_unavailable"}`);
      }
    }
    return execFileAsync("herdr", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: effectiveEnv,
    });
  },
};
