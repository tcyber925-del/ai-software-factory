import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult { stdout: string; stderr: string; }
export interface CommandRunner { run(command: string, args: string[], cwd: string): Promise<CommandResult>; }

export const defaultCommandRunner: CommandRunner = {
  async run(command, args, cwd) {
    return execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  },
};
