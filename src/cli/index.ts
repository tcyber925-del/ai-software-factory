import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { JsonSchema } from "../kernel/json-schema.js";
import { runPipeline } from "../kernel/pipeline.js";
import type { PipelineResult } from "../kernel/pipeline.js";
import { validateWorkUnit } from "../kernel/work-unit.js";
import { formatDoctorReport, runDoctor } from "../doctor/doctor.js";
import { createSystemProbe } from "../doctor/probe.js";
import { JsonlEventLog } from "../state/event-log.js";
import { gitChangedFiles } from "../adapters/git/changes.js";
import { gitRepoSnapshot } from "../adapters/git/snapshot.js";
import { fingerprintWorktree } from "../kernel/settle.js";
import { FakeRuntime } from "../fake-runtime.js";
import { OpenCodeRuntime } from "../adapters/opencode/runtime.js";
import { HerdrRuntime } from "../adapters/herdr/runtime.js";
import { HermesRuntime } from "../adapters/hermes/runtime.js";
import type { LabelledRuntime } from "../kernel/work-unit.js";
import type { ShellCheckSpec } from "../adapters/verification/shell.js";
import type { ScheduledWorkUnit } from "../kernel/scheduler.js";
import type { CliDependencies, CommandOutput, ParsedArgs } from "./args.js";
import { USAGE, parseArgs, readChecksFile, readWorkUnitFile, selectRuntimes } from "./args.js";
import { intakeCommand } from "./intake.js";

/**
 * Command dispatch.
 *
 * Every command is a thin shell over an already-verified kernel function. The CLI
 * owns no policy of its own: it cannot declare a run successful, cannot skip
 * verification, and has no path that turns runtime status into correctness.
 */

/**
 * Locates the Work Unit schema.
 *
 * The schema ships *with the factory*, not with the project being worked on, so it
 * is resolved relative to this module first. Falling back to the current directory
 * keeps the factory usable when it is run from inside its own checkout.
 *
 * Reading only from `process.cwd()` would make the CLI unusable in an adopting
 * project: the factory's own `doctor` does not require `schemas/` there, so it
 * would report a healthy environment and then `work run` would fail on a missing
 * file. The check and the action must agree on where the contract lives.
 */
export function loadSchema(): JsonSchema {
  const here = dirname(fileURLToPath(import.meta.url));
  // `src/cli/` and `dist/cli/` are both two levels below the package root.
  const candidates = [
    join(here, "..", "..", "schemas", "work-unit.schema.json"),
    join(process.cwd(), "schemas", "work-unit.schema.json"),
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as JsonSchema;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `could not locate schemas/work-unit.schema.json (looked in ${candidates.join(", ")}). The factory installation appears incomplete.`,
  );
}

/**
 * Runtimes available to the CLI.
 *
 * `fake` is always present and needs nothing installed, so `factory work run` is
 * reproducible on a fresh clone. The others appear only when the binary is on PATH;
 * an unavailable runtime is reported rather than silently substituted.
 */
export function availableRuntimes(repositoryRoot: string, promptTimeoutMs?: number): LabelledRuntime[] {
  const timeout = promptTimeoutMs === undefined ? {} : { promptTimeoutMs };
  const optional: LabelledRuntime[] = [
    { name: "opencode", runtime: new OpenCodeRuntime({ repositoryRoot, ...timeout }) },
    { name: "herdr", runtime: new HerdrRuntime({ repositoryRoot }) },
    { name: "hermes", runtime: new HermesRuntime({ repositoryRoot }) },
  ];
  const runtimes: LabelledRuntime[] = [];
  for (const candidate of optional) {
    // A runtime whose binary is absent is not offered, rather than offered and
    // failing mid-run.
    if (isOnPath(candidate.name)) runtimes.push(candidate);
  }
  // `fake` last, and this ordering is load-bearing.
  //
  // `selectRuntime` takes the first candidate that satisfies a Work Unit's
  // capabilities, with no ranking of its own, so fleet order *is* the selection
  // policy. `fake` declares a broad capability set and creates a fictional
  // worktree, so when it led the fleet it won every Work Unit it could satisfy —
  // verification then failed against a path that does not exist, repair burned its
  // attempts, and the run blocked for a reason no operator could act on.
  //
  // Last means it is a fallback: chosen when nothing installed can satisfy the work,
  // which is the point of having it, so a fresh clone with nothing on `PATH` still
  // runs. Naming it explicitly still selects it — `--runtime fake` filters the fleet
  // to one entry before selection happens.
  runtimes.push({ name: "fake", runtime: new FakeRuntime() });
  return runtimes;
}

function isOnPath(binary: string): boolean {
  const path = process.env["PATH"] ?? "";
  return path.split(":").some((dir) => dir.length > 0 && isExecutable(join(dir, binary)));
}

function isExecutable(path: string): boolean {
  try {
    // eslint-disable-next-line no-bitwise
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export interface RunContext {
  cwd: string;
}

export async function dispatch(argv: string[], context: RunContext): Promise<CommandOutput> {
  const args = parseArgs(argv);

  // Asking for help succeeds; having nothing to do fails, so a bare `factory`
  // cannot be mistaken for a successful run.
  if (args.booleans.has("help")) return { exitCode: 0, lines: [USAGE] };
  if (args.command.length === 0) return { exitCode: 1, lines: [USAGE] };

  try {
    switch (args.command.join(" ")) {
      case "work run":
        return await workRun(args, context);
      case "work validate":
        return workValidate(args, context);
      // Intake sits before the pipeline and writes a plan; it never reaches it. See
      // `src/cli/intake.ts` for why the two steps stay separate commands.
      case "intake":
        return intakeCommand(args);
      case "verify":
        return await factoryVerify(context);
      case "doctor":
        return await factoryDoctor(args, context);
      default:
        return { exitCode: 1, lines: [`unknown command: ${args.command.join(" ")}`, "", USAGE] };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A stack trace is developer output, not operator output: show it only when
    // the caller asked for it, so routine failures stay one readable line.
    if (args.booleans.has("debug")) {
      return { exitCode: 1, lines: [message, error instanceof Error ? (error.stack ?? "") : ""] };
    }
    return { exitCode: 1, lines: [message] };
  }
}

function resolveUnits(args: ParsedArgs): ScheduledWorkUnit[] {
  const path = args.flags.get("work-units");
  if (path === undefined) {
    throw new Error("--work-units <file.json> is required");
  }
  return readWorkUnitFile(path);
}

async function workRun(args: ParsedArgs, context: RunContext): Promise<CommandOutput> {
  const workUnits = resolveUnits(args);
  const schema = loadSchema();
  const cwd = context.cwd;
  // An operator whose runtime is legitimately slow needs a recourse; a ceiling they
  // cannot move is indistinguishable from a hang.
  const promptTimeoutRaw = args.flags.get("prompt-timeout-ms");
  let promptTimeoutMs: number | undefined;
  if (promptTimeoutRaw !== undefined) {
    promptTimeoutMs = Number.parseInt(promptTimeoutRaw, 10);
    if (!Number.isFinite(promptTimeoutMs) || promptTimeoutMs <= 0) {
      throw new Error(`--prompt-timeout-ms must be a positive number of milliseconds (got '${promptTimeoutRaw}')`);
    }
  }

  const runtimes = selectRuntimes(availableRuntimes(cwd, promptTimeoutMs), args.flags.get("runtime"));
  // The default suits npm projects, which is what the templates ship. Anything else
  // supplies its own checks, because a verification command the project does not
  // recognise can only ever fail — and a check that cannot pass is indistinguishable
  // from a check that found a problem.
  const checksPath = args.flags.get("checks");
  const checks: ShellCheckSpec[] =
    checksPath === undefined
      ? [{ name: "npm-test", command: "npm", args: ["test"] }]
      : readChecksFile(checksPath);
  const eventLog = new JsonlEventLog(join(cwd, ".factory/events.jsonl"));

  const maxParallelRaw = args.flags.get("max-parallel");
  const maxParallel = maxParallelRaw === undefined ? undefined : Number.parseInt(maxParallelRaw, 10);

  // Verification defaults to the executed worktree. `--verify-in repo` opts out
  // explicitly, for the case where the factory is verifying its own checkout.
  const verifyInFlag = args.flags.get("verify-in");
  if (verifyInFlag !== undefined && verifyInFlag !== "worktree" && verifyInFlag !== "repo") {
    throw new Error(`--verify-in must be 'worktree' or 'repo' (got '${verifyInFlag}')`);
  }

  const result = await runPipeline({
    workUnits,
    schema,
    runtimes,
    checks,
    cwd,
    eventLog,
    ...(verifyInFlag === undefined ? {} : { verifyIn: verifyInFlag }),
    ...(maxParallel === undefined || Number.isNaN(maxParallel) ? {} : { maxParallel }),
    // Scope enforcement is on wherever `paths` are declared. `--no-strict-scope`
    // downgrades a violation to a warning for the case where a Work Unit legitimately
    // needs to touch more than it predicted.
    changedFiles: gitChangedFiles,
    // Always supplied, unlike `changedFiles` a moment ago: a run with no scope gate
    // still works, but a run with no containment gate is the one that reported
    // `ready` while an agent edited the checkout it was given.
    repoSnapshot: gitRepoSnapshot,
    // Always supplied, like repoSnapshot. A runtime resolving its prompt call is
    // not evidence the agent stopped, and without this the pipeline verifies a
    // tree that may still be being written to.
    settleWork: { fingerprint: fingerprintWorktree },
    ...(args.booleans.has("no-strict-scope") ? { strictScope: false } : {}),
  });

  return { exitCode: result.status === "ready" ? 0 : 1, lines: renderPipeline(result, args.booleans.has("json")) };
}

function workValidate(args: ParsedArgs, context: RunContext): CommandOutput {
  const workUnits = resolveUnits(args);
  const schema = loadSchema();
  const lines: string[] = [];
  let invalid = 0;

  for (const scheduled of workUnits) {
    const validation = validateWorkUnit(scheduled.workUnit, schema);
    if (validation.valid) {
      lines.push(`ok    ${scheduled.workUnit.id}`);
      continue;
    }
    invalid += 1;
    lines.push(`fail  ${scheduled.workUnit.id}`);
    for (const issue of validation.issues) lines.push(`        ${issue.path} ${issue.message}`);
  }

  void context;
  lines.push(`${workUnits.length - invalid}/${workUnits.length} work unit(s) valid.`);
  return { exitCode: invalid === 0 ? 0 : 1, lines };
}

/**
 * Deterministic verification steps, in the order they should run.
 *
 * `verify` is last so a project that defines it — which is what CI runs — gets the
 * whole contract exactly as CI sees it, rather than a reconstruction of it.
 */
const VERIFY_STEPS = ["format:check", "lint", "typecheck", "test", "build", "verify"] as const;

/**
 * Runs the project's own deterministic checks.
 *
 * The steps are read from the target project's `package.json` rather than assumed.
 * The previous version invoked a fixed list including `format:check`, `lint`, and
 * `typecheck`, which this repository does not define — so `factory verify` always
 * failed on a factory that is itself green. A verification command the project does
 * not recognise can only ever fail, and a command that cannot pass is
 * indistinguishable from one that found a problem.
 *
 * A project that declares none of the steps is a **failure**, not a pass. "Nothing
 * was verified" must never be reported as "verification passed".
 */
async function factoryVerify(context: RunContext): Promise<CommandOutput> {
  const run = promisify(execFile);
  const lines: string[] = [];

  let scripts: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(context.cwd, "package.json"), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const candidate = (parsed as Record<string, unknown>)["scripts"];
      if (typeof candidate === "object" && candidate !== null) {
        scripts = candidate as Record<string, unknown>;
      }
    }
  } catch {
    lines.push("fail  no readable package.json — cannot determine this project's checks");
    return { exitCode: 1, lines };
  }

  // `verify` is the project's own aggregate contract — it is what its CI runs. When
  // it exists, run it *alone*: a `verify` script that already chains `test` would
  // otherwise run the whole suite twice, and a slow check that times out reads as a
  // verification failure.
  if (typeof scripts["verify"] === "string") {
    try {
      await run("npm", ["run", "verify"], { cwd: context.cwd, maxBuffer: 32 * 1024 * 1024 });
      lines.push("ok    npm run verify");
      lines.push("verification passed (1 step).");
      return { exitCode: 0, lines };
    } catch {
      lines.push("fail  npm run verify");
      return { exitCode: 1, lines };
    }
  }

  const present = VERIFY_STEPS.filter((step) => typeof scripts[step] === "string");
  const absent = VERIFY_STEPS.filter((step) => typeof scripts[step] !== "string");

  if (present.length === 0) {
    lines.push("fail  package.json declares none of: " + VERIFY_STEPS.join(", "));
    lines.push("      Declare at least one deterministic check, or the factory cannot verify anything.");
    return { exitCode: 1, lines };
  }

  for (const step of present) {
    try {
      await run("npm", ["run", step], { cwd: context.cwd, maxBuffer: 32 * 1024 * 1024 });
      lines.push(`ok    npm run ${step}`);
    } catch {
      lines.push(`fail  npm run ${step}`);
      return { exitCode: 1, lines };
    }
  }

  if (absent.length > 0) {
    lines.push(`skip  not declared by this project: ${absent.join(", ")}`);
  }
  lines.push(`verification passed (${present.length} step${present.length === 1 ? "" : "s"}).`);
  return { exitCode: 0, lines };
}

async function factoryDoctor(args: ParsedArgs, context: RunContext): Promise<CommandOutput> {
  // `--probe` actually runs one prompt per runtime. Off by default because it costs a
  // model call each; without it the report says "is installed" rather than "is
  // available", because installed is all `--version` can establish.
  const report = await runDoctor({
    probe: createSystemProbe(context.cwd, { probeDispatch: args.booleans.has("probe") }),
  });
  return {
    // A blocked environment is reported as a failure so CI can gate on it, while
    // a merely degraded one (e.g. an absent optional runtime) is not an error.
    exitCode: report.status === "blocked" ? 1 : 0,
    lines: [formatDoctorReport(report)],
  };
}

function renderPipeline(result: PipelineResult, asJson: boolean): string[] {
  if (asJson) return [JSON.stringify({ status: result.status, reason: result.reason, runs: result.runs.map((run) => ({ workUnitId: run.workUnitId, outcome: run.outcome, verification: run.verification.status, integration: run.integration.state, reason: run.integration.reason })) }, null, 2)];

  const lines: string[] = [];
  lines.push(`factory: ${result.status} — ${result.reason}`);
  lines.push(`batches: ${JSON.stringify(result.plan.batches)}`);
  for (const run of result.runs) {
    lines.push(
      `  ${run.outcome.padEnd(16)} ${run.workUnitId}  verification=${run.verification.status} integration=${run.integration.state} (${run.integration.reason})`,
    );
    if (run.repairAttempts !== undefined) {
      lines.push(`                   repair attempts=${run.repairAttempts} ${run.repairReason ?? ""}`.trimEnd());
    }
    if (run.failure !== undefined) lines.push(`                   runtime failure=${run.failure}`);
  }
  for (const pending of result.notDispatched) {
    lines.push(`  not dispatched    ${pending}  (blocked earlier in the plan)`);
  }
  lines.push(
    "Note: readiness comes only from independent verification, never from runtime status.",
  );
  return lines;
}
