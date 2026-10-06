import { readFileSync } from "node:fs";
import type { JsonSchema } from "../kernel/json-schema.js";
import type { ScheduledWorkUnit } from "../kernel/scheduler.js";
import type { LabelledRuntime } from "../kernel/work-unit.js";
import { workUnitFromWireForm } from "../kernel/work-unit.js";
import type { ShellCheckSpec, ShellRunner } from "../adapters/verification/shell.js";
import type { EventLog } from "../state/event-log.js";

/**
 * Minimal command-line surface.
 *
 * Argument parsing is hand-rolled and dependency-free on purpose: the factory has
 * added zero dependencies across seventeen units, and a CLI framework is not worth
 * breaking that for. It also keeps the trust boundary visible — nothing here can
 * execute a command it was not given.
 */

export interface ParsedArgs {
  command: string[];
  flags: Map<string, string>;
  booleans: Set<string>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      command.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      index += 1;
    } else {
      booleans.add(body);
    }
  }

  return { command, flags, booleans };
}

export interface CliDependencies {
  /** Work Units to dispatch, in provider-neutral form. */
  workUnits: ScheduledWorkUnit[];
  schema: JsonSchema;
  runtimes: LabelledRuntime[];
  checks: ShellCheckSpec[];
  cwd: string;
  runner?: ShellRunner;
  eventLog?: EventLog;
}

export interface CommandOutput {
  exitCode: number;
  lines: string[];
}

export const USAGE = [
  "Usage:",
  "  factory work run       --work-units <plan.json> [--runtime <name>]",
  "  factory work validate  --work-units <plan.json>",
  "  factory verify",
  "  factory doctor",
  "",
  "Flags:",
  "  --work-units <path>   Plan: array of { workUnit, dependsOn?, paths?, contracts? }",
  "  --checks <path>       JSON array of { name, command, args? }; default is npm test",
  "  --runtime <name>      Restrict dispatch to one runtime by name",
  "  --max-parallel <n>    Bound concurrency inside one batch",
  "  --verify-in <where>   'worktree' (default, verifies the executed tree) or 'repo'",
  "  --json                Emit machine-readable output",
  "  --debug               Include a stack trace on failure",
  "  --help                Show this message",
].join("\n");

/**
 * Reads a checks file: the deterministic commands that prove a Work Unit correct.
 *
 * Read and validated rather than cast. These are commands the factory will execute
 * inside a worktree, so a malformed or empty entry is a refusal, not something to
 * discover at dispatch time.
 *
 * An empty array is rejected deliberately. "Pass verification" with no checks would
 * mean a Work Unit is ready because nothing was run, which is exactly the failure
 * mode independent verification exists to prevent.
 */
export function readChecksFile(path: string): ShellCheckSpec[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of checks`);
  }
  if (parsed.length === 0) {
    throw new Error(`${path}: at least one check is required; an empty list would pass everything`);
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${path}[${index}]: expected an object`);
    }
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    const command = record["command"];
    if (typeof name !== "string" || name === "") {
      throw new Error(`${path}[${index}]: 'name' must be a non-empty string`);
    }
    if (typeof command !== "string" || command === "") {
      throw new Error(`${path}[${index}]: 'command' must be a non-empty string`);
    }
    const args = record["args"];
    if (args !== undefined && (!Array.isArray(args) || args.some((value) => typeof value !== "string"))) {
      throw new Error(`${path}[${index}]: 'args' must be an array of strings`);
    }

    const check: ShellCheckSpec = { name, command };
    if (args !== undefined) check.args = [...(args as string[])];
    return check;
  });
}

/**
 * Reads a work-unit file.
 *
 * The file is the published wire contract — snake_case, matching
 * `schemas/work-unit.schema.json` — so it is parsed through
 * `workUnitFromWireForm` rather than cast. A cast here would let a malformed file
 * reach a runtime as a half-populated object; the parser throws instead.
 *
 * Scheduling facts travel alongside each Work Unit, so one file describes a whole
 * plan. They are optional, which keeps a single-unit file valid.
 */
export function readWorkUnitFile(path: string): ScheduledWorkUnit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON array of work units`);
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${path}[${index}]: expected an object`);
    }
    const record = entry as Record<string, unknown>;
    const raw = record["workUnit"];
    if (raw === undefined) {
      throw new Error(`${path}[${index}]: missing 'workUnit'`);
    }

    const scheduled: ScheduledWorkUnit = { workUnit: workUnitFromWireForm(raw) };
    if (record["dependsOn"] !== undefined) scheduled.dependsOn = strings(record["dependsOn"], "dependsOn", index);
    if (record["paths"] !== undefined) scheduled.paths = strings(record["paths"], "paths", index);
    if (record["contracts"] !== undefined) scheduled.contracts = strings(record["contracts"], "contracts", index);
    if (record["runtimes"] !== undefined) scheduled.runtimes = strings(record["runtimes"], "runtimes", index);
    if (record["protectedResources"] !== undefined) {
      scheduled.protectedResources = strings(record["protectedResources"], "protectedResources", index);
    }
    return scheduled;
  });
}

function strings(value: unknown, field: string, index: number): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field}[${index}]: expected an array of strings`);
  }
  return [...(value as string[])];
}

export function selectRuntimes(runtimes: LabelledRuntime[], name: string | undefined): LabelledRuntime[] {
  if (name === undefined) return runtimes;
  const chosen = runtimes.filter((candidate) => candidate.name === name);
  if (chosen.length === 0) {
    throw new Error(`no runtime named '${name}' is available (have: ${runtimes.map((r) => r.name).join(", ")})`);
  }
  return chosen;
}