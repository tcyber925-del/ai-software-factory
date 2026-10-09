import { readFileSync, writeFileSync } from "node:fs";
// Imported from the adapter modules rather than their barrels on purpose. A barrel is
// convenient right up until it re-exports something this command must not be able to
// reach: the Linear barrel also exports `buildTransition` and `deriveOutcome`, which
// propose status changes. Importing the narrow module is what makes "this command cannot
// propose a transition" an import-list fact rather than a promise, and it keeps the test
// that checks that list honest.
import type { GitHubIssue, GitHubIntakePolicy } from "../adapters/github/intake.js";
import { githubIntakeAdapter } from "../adapters/github/intake.js";
import type { LinearIntakePolicy, LinearIssue } from "../adapters/linear/intake.js";
import { linearIntakeAdapter } from "../adapters/linear/intake.js";
import { isRecord } from "../kernel/json-schema.js";
import type { IntakePlan } from "../kernel/intake-plan.js";
import { buildIntakePlan } from "../kernel/intake-plan.js";
import type { CommandOutput, ParsedArgs } from "./args.js";

/**
 * `factory intake`: compile provider records into a plan file.
 *
 * The adapters were reachable, but not from here. Linear had a plan builder and GitHub
 * had an adapter, and an operator had no way to run either without writing a program —
 * so every provider had a different private path to the same job, and "intake is not
 * composed" was true of the command surface even though the machinery existed.
 *
 * Three decisions are load-bearing, and each closes a question rather than adding a
 * feature.
 *
 * **It writes a plan; it never pipes into dispatch.** That was the question FCT-018
 * deferred when it was closed as won't-fix for V1, and it is answered here rather than
 * re-opened: writing the file keeps intake and execution composable and inspectable, and
 * it means a human reads what will be dispatched before any of it runs. This module
 * therefore has no import of the pipeline, the scheduler, execution, a runtime or the
 * event log — it cannot dispatch because it has no path that could.
 *
 * **One command, two providers, selected by `--source`.** The provider decides which
 * adapter and whose policy are used, and nothing else. There is no `linear run` and no
 * `github run`: execution stays the single `factory work run` boundary, so a second
 * provider can never arrive with its own execution path.
 *
 * **It reads records, it does not fetch them.** `--records` is a file. Live provider
 * access stays explicit opt-in and unimplemented, which is why CI needs no credential:
 * the offline fixtures already cover the accepted path and every refused one.
 *
 * The eligibility allowlist still defaults to empty, and this command adds no way around
 * it. The flags that *set* an allowlist are the operator's decision; a flag that
 * *bypasses* one would turn every open issue in a repository into a dispatch queue.
 */

/** The providers this command can intake from. */
const SOURCES = ["linear", "github"] as const;
type IntakeSourceName = (typeof SOURCES)[number];

/**
 * Flags that mean something only to one provider.
 *
 * They are refused rather than ignored for the other one: a `--eligible-label` handed
 * to Linear would be silently meaningless, and the operator would read the resulting
 * "nothing was eligible" as a problem with their labels rather than with the flag.
 */
const PROVIDER_FLAGS: Record<IntakeSourceName, string[]> = {
  linear: ["eligible-status", "eligible-status-name"],
  github: ["eligible-label"],
};

/**
 * Reads provider records from a file.
 *
 * Two spellings are accepted because both are in circulation: the shipped fixtures wrap
 * their records in an object, and a caller exporting records from its own system will
 * not necessarily wrap them.
 *
 * Every element is checked to be an object before it reaches a provider, so a malformed
 * file is reported as a malformed file rather than surfacing later as a refusal about a
 * record that does not exist.
 */
function readRecords(path: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: could not be read as JSON (${detail})`);
  }

  const listed = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed["issues"])
      ? (parsed["issues"] as unknown[])
      : undefined;
  if (listed === undefined) {
    throw new Error(`${path}: expected a JSON array of records, or an object with an "issues" array`);
  }

  return listed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${path}[${index}]: expected an object`);
    return entry;
  });
}

/** Splits a comma-separated flag value. Empty entries are dropped, not passed on. */
function list(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (value === undefined) throw new Error(`--${name} <value> is required`);
  return value;
}

/**
 * The fields each adapter dereferences without checking them first.
 *
 * The adapters' *eligibility* rules handle a record that is merely ineligible, and say
 * so by name. A record that cannot be read at all is a different failure: without this,
 * a `labels` field that is a string instead of a list throws from inside the provider's
 * rule, and an operator gets a stack trace for a typo in a file they wrote.
 *
 * `url` earns a place here for a reason the others do not: it is the one optional field
 * an adapter *calls a method on*. GitHub compares a recorded link with `startsWith`
 * before it has decided anything, so a number where a string belongs throws from inside
 * the provider — and, having got that far, would also launder into the machine-readable
 * report, where `IntakeSource.url` promises a string.
 */
const REQUIRED_FIELDS: Record<IntakeSourceName, Array<[string, "string" | "number"]>> = {
  linear: [["id", "string"], ["title", "string"], ["statusType", "string"]],
  github: [["id", "number"], ["owner", "string"], ["repo", "string"], ["title", "string"], ["state", "string"]],
};

/**
 * GitHub's taxonomy offers exactly these two states, and a value outside them is a
 * malformed file rather than an ineligible record.
 *
 * Checked as a value set, not just a type, because the adapter's refusal for a
 * non-`open` state says "issue is closed and is never dispatchable" — which, for
 * `"OPEN"`, is a confident false statement about a record the provider never described.
 * Failing safe is right; being confidently wrong is not.
 */
const STATE_VALUES: Partial<Record<IntakeSourceName, Record<string, readonly string[]>>> = {
  github: { state: ["open", "closed"] },
};

/** `blockedBy`, `labels` and `url` are optional; present but wrongly typed is malformed. */
const OPTIONAL_LIST_FIELDS = ["labels", "blockedBy"] as const;
const OPTIONAL_STRING_FIELDS = ["url"] as const;

function validateRecords(source: IntakeSourceName, path: string, records: Record<string, unknown>[]): void {
  records.forEach((record, index) => {
    for (const [field, type] of REQUIRED_FIELDS[source]) {
      if (typeof record[field] !== type) {
        throw new Error(`${path}[${index}]: '${field}' must be a ${type} (received ${typeof record[field]})`);
      }
    }
    for (const [field, allowed] of Object.entries(STATE_VALUES[source] ?? {})) {
      const value = record[field];
      if (typeof value === "string" && (allowed as readonly string[]).includes(value) === false) {
        const permitted = (allowed as readonly string[]).map((entry) => `'${entry}'`).join(" or ");
        throw new Error(`${path}[${index}]: '${field}' must be ${permitted}`);
      }
    }
    for (const field of OPTIONAL_LIST_FIELDS) {
      const value = record[field];
      if (value === undefined) continue;
      if (Array.isArray(value) === false || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`${path}[${index}]: '${field}' must be an array of strings`);
      }
    }
    for (const field of OPTIONAL_STRING_FIELDS) {
      const value = record[field];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new Error(`${path}[${index}]: '${field}' must be a string (received ${typeof value})`);
      }
    }
  });
}

/**
 * The validated records as a provider's own type.
 *
 * A cast, deliberately, and only after `validateRecords` has checked every field the
 * provider dereferences. It is not a way to smuggle unchecked data past the type
 * system: what the cast asserts is precisely what the validation above established.
 */
function asProviderRecords<T>(records: Record<string, unknown>[]): T[] {
  return records as unknown as T[];
}

/**
 * Builds the provider's own policy from the shared flag surface.
 *
 * Each provider's rules stay in its adapter; this only supplies what that adapter asks
 * for. `knownIssues` is the file's own records, so an issue's `blockedBy` resolves
 * against the same snapshot the plan is compiled from — resolving it against anything
 * else would let intake decide readiness from a state the plan does not describe.
 */
function policyFor(
  source: IntakeSourceName,
  args: ParsedArgs,
  records: Record<string, unknown>[],
): LinearIntakePolicy | GitHubIntakePolicy {
  const repository = args.flags.get("repository");
  const blockingLabels = list(args.flags.get("blocking-label"));

  if (source === "linear") {
    return {
      config: {
        eligibleStatusTypes: list(args.flags.get("eligible-status")),
        eligibleStatusNames: list(args.flags.get("eligible-status-name")),
        blockingLabels,
      },
      knownIssues: asProviderRecords<LinearIssue>(records),
      ...(repository === undefined ? {} : { repository }),
    };
  }

  return {
    config: {
      // Empty unless a human says otherwise, which is the whole safety property: an
      // open issue is not a readiness signal and no flag here changes that.
      eligibleLabels: list(args.flags.get("eligible-label")),
      blockingLabels,
    },
    ...(repository === undefined ? {} : { repository }),
  };
}

function planFor(
  source: IntakeSourceName,
  args: ParsedArgs,
  records: Record<string, unknown>[],
): IntakePlan {
  if (source === "linear") {
    return buildIntakePlan({
      adapter: linearIntakeAdapter,
      records: asProviderRecords<LinearIssue>(records),
      policy: policyFor(source, args, records) as LinearIntakePolicy,
    });
  }
  return buildIntakePlan({
    adapter: githubIntakeAdapter,
    records: asProviderRecords<GitHubIssue>(records),
    policy: policyFor(source, args, records) as GitHubIntakePolicy,
  });
}

/**
 * The command. Synchronous on purpose: it reads a file and writes a file, and a path
 * that could block would only give intake a way to become something other than a plan.
 */
export function intakeCommand(args: ParsedArgs): CommandOutput {
  const requested = args.flags.get("source");
  if (requested === undefined) throw new Error("--source <linear|github> is required");
  if ((SOURCES as readonly string[]).includes(requested) === false) {
    throw new Error(`--source must be one of: ${SOURCES.join(", ")} (got '${requested}')`);
  }
  const source = requested as IntakeSourceName;

  for (const [provider, flags] of Object.entries(PROVIDER_FLAGS)) {
    if (provider === source) continue;
    for (const flag of flags) {
      if (args.flags.has(flag)) {
        throw new Error(`--${flag} is a ${provider} flag and cannot be used with --source ${source}`);
      }
    }
  }

  const recordsPath = requireFlag(args, "records");
  const outPath = requireFlag(args, "out");
  // Writing the plan over the records would destroy the operator's only copy of the
  // input, and a second run would then report "no work found" about a file that is now
  // a plan. Cheap to refuse, and the mistake is not obvious from the command line.
  if (outPath === recordsPath) throw new Error("--out must differ from --records");
  const records = readRecords(recordsPath);
  validateRecords(source, recordsPath, records);
  const plan = planFor(source, args, records);

  // One file per invocation, overwritten whole. A plan is the entire decision rather
  // than an append to a previous one: merging the old units in would dispatch work
  // nobody re-approved.
  writeFileSync(outPath, `${JSON.stringify(plan.units, null, 2)}\n`);

  if (args.booleans.has("json")) {
    return { exitCode: 0, lines: [JSON.stringify(report(source, records.length, outPath, plan), null, 2)] };
  }
  return { exitCode: 0, lines: render(source, records.length, outPath, plan) };
}

/**
 * The machine-readable report.
 *
 * `dispatched: false` is a stated field rather than an inference from the absence of a
 * pipeline call, because the caller wiring this into automation needs something it can
 * assert on. Provenance travels with every entry: a planned unit by the id it carries —
 * which for both shipped providers *is* the provider's own reference — and a refusal by
 * the full `IntakeSource`, deep link included.
 */
function report(
  source: IntakeSourceName,
  recordCount: number,
  outPath: string,
  plan: IntakePlan,
): Record<string, unknown> {
  return {
    source,
    records: recordCount,
    plan: outPath,
    dispatched: false,
    units: plan.units.map((unit) => ({ id: unit.workUnit["id"], provider: source })),
    refusals: plan.refusals,
  };
}

function render(source: IntakeSourceName, recordCount: number, outPath: string, plan: IntakePlan): string[] {
  const lines: string[] = [];
  lines.push(
    `intake: ${source} — ${plan.units.length} accepted, ${plan.refusals.length} refused (${recordCount} record(s))`,
  );
  lines.push(`plan written: ${outPath}`);

  for (const unit of plan.units) {
    // The unit's own id, which is where its provenance lives: both shipped adapters
    // compile a Work Unit whose id is the provider's reference for the record, so a
    // reader holding this line can find the issue without a lookup table.
    lines.push(`intake accepted ${String(unit.workUnit["id"])} (${source})`);
  }
  // Rendered by the kernel's own wording, so the `intake` prefix and the naming of the
  // provider and record hold. A paraphrased refusal is how "the provider declined" and
  // "the factory broke" became indistinguishable in the first place.
  for (const refusal of plan.refusals) lines.push(refusal.message);

  // The two steps, named separately. Intake deciding what to run and running it are
  // different acts, and the operator is the one who makes the second one.
  lines.push(`nothing was dispatched; review the plan, then run: factory work run --work-units ${outPath}`);
  return lines;
}

/**
 * The command's own help, which `USAGE` splices in rather than restating.
 *
 * One copy, because a second is how a flag ends up documented in `--help` but not
 * validated, or validated but not documented. `PROVIDER_FLAGS` is the same constant the
 * command validates against, so a provider-specific flag cannot be added without
 * appearing here.
 */
export const INTAKE_USAGE: string[] = [
  "  factory intake --source <linear|github> --records <issues.json> --out <plan.json>",
  "                        [--repository <owner/name>] [--blocking-label <list>] [--json]",
  "         linear only:  [--eligible-status <list>] [--eligible-status-name <list>]",
  "        github only:   [--eligible-label <list>]",
  "",
  "  Compiles provider records into a plan file. It never dispatches:",
  "  running the plan it writes is the separate, human-initiated `work run`.",
  "  --source <name>        Task provider to intake from: linear or github",
  "  --records <path>       Provider records: a JSON array, or { \"issues\": [...] }",
  "  --out <path>           Where to write the plan `work run --work-units` reads",
  "  --repository <name>    Target repository for compiled work; never inferred",
  "  --eligible-status <list>       Linear: status types cleared for dispatch (default: none)",
  "  --eligible-status-name <list>  Linear: status names cleared for dispatch (default: none)",
  "  --eligible-label <list>        GitHub: labels cleared for dispatch (default: none)",
  "  --blocking-label <list>        Refuse records carrying these labels",
];