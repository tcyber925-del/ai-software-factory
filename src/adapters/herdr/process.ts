import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HerdrCommandResult {
  stdout: string;
  stderr: string;
}

export interface HerdrCommandRunner {
  run(args: string[], cwd: string): Promise<HerdrCommandResult>;
}

export const defaultHerdrCommandRunner: HerdrCommandRunner = {
  async run(args, cwd) {
    return execFileAsync("herdr", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
  },
};
