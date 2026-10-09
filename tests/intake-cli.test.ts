import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../src/kernel/pipeline.js";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { validateAgainstSchema } from "../src/kernel/json-schema.js";
import { dispatch } from "../src/cli/index.js";
import { readWorkUnitFile } from "../src/cli/args.js";
import { FakeRuntime } from "../src/fake-runtime.js";

/**
 * `factory intake`: one command, two providers, one plan file.
 *
 * The command exists because the intake adapters were reachable only from a caller's
 * own code. FCT-026 defined the boundary, FCT-027 planned Linear and FCT-028 added
 * GitHub, and an operator still had no way to run either — so every provider had a
 * different private path to the same job.
 *
 * What these tests pin is the operator-facing contract: what the command accepts, what
 * it writes, what it prints, and which failures exit non-zero. The properties that
 * matter are structural rather than cosmetic: the command plans, it never dispatches,
 * and a refused record stays an *intake* refusal.
 *
 * Everything runs from `fixtures/`, which holds recorded and explicitly-marked
 * synthetic payloads. No provider credential is read anywhere on this path, because
 * nothing here opens a socket or an environment variable.
 */

const execFileAsync = promisify(execFile);

const LINEAR_FIXTURE = "fixtures/linear/issues.json";
const GITHUB_FIXTURE = "fixtures/github/issues.json";

function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), `factory-intake-${name}-`));
}

async function run(argv: string[]) {
  return dispatch(argv, { cwd: process.cwd() });
}

/** Reads the plan the command wrote, in the shape an operator would open it in. */
function writtenPlan(path: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
}

function plannedIds(path: string): unknown[] {
  return writtenPlan(path).map((entry) => (entry["workUnit"] as Record<string, unknown>)["id"]);
}

/** GitHub's accepted records, under an allowlist that clears issue 900's label. */
function githubArgs(out: string, ...extra: string[]): string[] {
  return ["intake", "--source", "github", "--records", GITHUB_FIXTURE, "--out", out, "--repository", "acme/widgets", "--eligible-label", "factory:eligible", ...extra];
}

describe("one command plans work from either provider", () => {
  it("writes an inspectable plan from Linear records", async () => {
    const out = join(scratch("linear"), "plan.json");
    const result = await run([
      "intake",
      "--source", "linear",
      "--records", LINEAR_FIXTURE,
      "--out", out,
      "--repository", "acme/widgets",
      "--eligible-status", "started",
      "--eligible-status-name", "In Progress",
    ]);

    expect(result.exitCode).toBe(0);
    expect(plannedIds(out)).toEqual(["ENG-903", "ENG-905"]);
  });

  it("writes the same shape of plan from GitHub records", async () => {
    const out = join(scratch("github"), "plan.json");
    const result = await run(githubArgs(out));

    expect(result.exitCode).toBe(0);
    // GitHub's own cross-reference is the Work Unit id, so a reader holding the plan
    // can find the issue it came from without a lookup table.
    expect(plannedIds(out)).toEqual(["acme/widgets#900", "acme/widgets#904"]);
  });

  it("emits entries `factory work run --work-units` reads and nothing else", async () => {
    const out = join(scratch("shape"), "plan.json");
    await run(githubArgs(out));

    // A bare Work Unit is not a plan; an entry is `{ workUnit, … }`. The command
    // writes the existing format rather than a new one, so an operator who already
    // keeps plans by hand can read what intake produces.
    for (const entry of writtenPlan(out)) {
      expect(Object.keys(entry).sort()).toEqual(["workUnit"]);
      expect(Object.keys(entry["workUnit"] as Record<string, unknown>).sort()).toEqual([
        "acceptance_criteria",
        "autonomy",
        "capabilities",
        "goal",
        "id",
        "repository",
      ]);
    }
  });

  it("reads a bare array as readily as a { issues: [...] } payload", async () => {
    // Both spellings are in circulation: the shipped fixtures are wrapped, and a
    // caller exporting records from their own system will not necessarily wrap them.
    const out = join(scratch("bare"), "plan.json");
    const records = join(scratch("bare-in"), "issues.json");
    const issues = (JSON.parse(readFileSync(GITHUB_FIXTURE, "utf8")) as { issues: unknown[] }).issues;
    writeFileSync(records, JSON.stringify([issues[4]]));

    const result = await run([
      "intake", "--source", "github", "--records", records, "--out", out,
      "--repository", "acme/widgets", "--eligible-label", "factory:eligible",
    ]);

    expect(result.exitCode).toBe(0);
    expect(plannedIds(out)).toEqual(["acme/widgets#900"]);
  });

  it("keeps the file readable: indented JSON, one entry per planned unit", async () => {
    const out = join(scratch("readable"), "plan.json");
    await run(githubArgs(out));

    const body = readFileSync(out, "utf8");
    // A plan a human reviews before work runs has to be readable by a person.
    expect(body).toContain('\n  {\n    "workUnit": {\n      "id"');
    expect(body.endsWith("\n")).toBe(true);
  });
});

describe("the resulting plan is what `work run` consumes", () => {
  it("round-trips through the real plan reader", async () => {
    // The real reader rather than a local copy of it: if the plan shape drifted from
    // `readWorkUnitFile`, this read would throw rather than the plan quietly becoming
    // unusable. Scheduling facts come from nowhere here, because intake infers none.
    const out = join(scratch("consumable"), "plan.json");
    await run(githubArgs(out));

    const parsed = readWorkUnitFile(out);
    expect(parsed.map((scheduled) => scheduled.workUnit.id)).toEqual([
      "acme/widgets#900",
      "acme/widgets#904",
    ]);
    for (const scheduled of parsed) {
      // Intake declared no scheduling structure, so none is inferred: a unit that
      // names no `paths` is serialized against everything downstream, which is the
      // scheduler's call to make and not intake's.
      expect(scheduled.paths).toBeUndefined();
      expect(scheduled.dependsOn).toBeUndefined();
    }
  });

  it("passes `factory work validate` for both providers", async () => {
    // The end-to-end claim criterion 5 asks for, through the command surface itself:
    // intake wrote this, and the command that consumes a plan accepts it.
    const linearOut = join(scratch("validate-linear"), "plan.json");
    const githubOut = join(scratch("validate-github"), "plan.json");
    await run([
      "intake", "--source", "linear", "--records", LINEAR_FIXTURE, "--out", linearOut,
      "--repository", "acme/widgets", "--eligible-status", "started", "--eligible-status-name", "In Progress",
    ]);
    await run(githubArgs(githubOut));

    const linear = await run(["work", "validate", "--work-units", linearOut]);
    const github = await run(["work", "validate", "--work-units", githubOut]);

    expect(linear.exitCode).toBe(0);
    expect(github.exitCode).toBe(0);
    expect(github.lines.join("\n")).toContain("2/2 work unit(s) valid.");
  });

  it("validates the compiled Work Units against the factory's own schema", async () => {
    // `work-unit.schema.json` has `additionalProperties: false`, so this is also the
    // check that no provider field — a Linear status, a GitHub label, an owner —
    // leaked into a compiled unit.
    const out = join(scratch("schema"), "plan.json");
    await run(githubArgs(out));

    const schema = JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8")) as never;
    const { validateAgainstSchema } = await import("../src/kernel/json-schema.js");
    for (const entry of writtenPlan(out)) {
      expect(validateAgainstSchema(entry["workUnit"], schema)).toEqual([]);
    }
  });
});

describe("the eligibility allowlist still defaults to empty", () => {
  it("plans nothing from either provider until a human clears something", async () => {
    // The safety property, at the CLI boundary: the flag that *sets* the allowlist is
    // the operator's decision, and with no flag there is no allowlist at all. Issue
    // 901 and ENG-905 are eligible, fully declared and unblocked, and still refuse.
    const linearOut = join(scratch("default-linear"), "plan.json");
    const githubOut = join(scratch("default-github"), "plan.json");

    const linear = await run(["intake", "--source", "linear", "--records", LINEAR_FIXTURE, "--out", linearOut, "--repository", "acme/widgets"]);
    const github = await run(["intake", "--source", "github", "--records", GITHUB_FIXTURE, "--out", githubOut, "--repository", "acme/widgets"]);

    expect(linear.exitCode).toBe(0);
    expect(github.exitCode).toBe(0);
    expect(writtenPlan(linearOut)).toEqual([]);
    expect(writtenPlan(githubOut)).toEqual([]);
    expect(linear.lines.join("\n")).toContain("nothing dispatches by default");
    expect(github.lines.join("\n")).toContain("nothing dispatches by default");
  });

  it("offers no flag that bypasses an allowlist", async () => {
    // Whatever this command grows, it must not grow a way to say "dispatch whatever
    // is open". The USAGE text is the surface an operator reads to find that flag.
    const usage = (await run(["--help"])).lines.join("\n");
    for (const forbidden of ["--force", "--all", "--yes", "--dispatch", "--no-eligibility", "--override"]) {
      expect(usage, `intake must not offer ${forbidden}`).not.toContain(forbidden);
    }
    expect(usage).toContain("factory intake");
  });

  it("honours a configured blocking label over an allowlisted one", async () => {
    // Issue 904 carries both. Reporting `not_allowlisted` would hide the label that
    // actually stopped it and send an operator to configure the wrong thing.
    const out = join(scratch("blocking"), "plan.json");
    const result = await run(githubArgs(out, "--blocking-label", "needs-founder-approval"));

    expect(result.exitCode).toBe(0);
    expect(plannedIds(out)).toEqual(["acme/widgets#900"]);
    expect(result.lines.join("\n")).toContain("policy_blocked");
  });
});

describe("intake refuses rather than inferring", () => {
  it("names a missing repository instead of guessing one", async () => {
    // Linear carries no repository field and a GitHub issue's own repository is where
    // the conversation happened, not necessarily where the code changes. So the
    // absence is reported per record, which is where an operator can act on it.
    const out = join(scratch("no-repo"), "plan.json");
    const result = await run([
      "intake", "--source", "linear", "--records", LINEAR_FIXTURE, "--out", out,
      "--eligible-status", "started", "--eligible-status-name", "In Progress",
    ]);

    expect(result.exitCode).toBe(0);
    expect(writtenPlan(out)).toEqual([]);
    expect(result.lines.join("\n")).toContain("target_undeclared");
    expect(result.lines.join("\n")).toContain("missing_repository");
  });

  it("never plans an issue whose acceptance criteria exist only in prose", async () => {
    // ENG-901 says the site "should be faster" in plain prose.
    const out = join(scratch("prose"), "plan.json");
    const result = await run([
      "intake", "--source", "linear", "--records", LINEAR_FIXTURE, "--out", out,
      "--repository", "acme/widgets", "--eligible-status", "started", "--eligible-status-name", "In Progress",
    ]);

    expect(result.exitCode).toBe(0);
    expect(plannedIds(out)).not.toContain("ENG-901");
    expect(result.lines.join("\n")).toContain("requirements_undeclared");
  });
});

describe("an intake refusal reads as an intake refusal", () => {
  it("reports every refusal through the kernel's own wording", async () => {
    const out = join(scratch("refusals"), "plan.json");
    const result = await run(githubArgs(out));

    const text = result.lines.join("\n");
    // Every refusal names its provider and its record, and the line is prefixed
    // `intake`. A reader who greps for a problem is told which subsystem decided.
    expect(text).toContain("intake refused acme/widgets#901 (github): not_allowlisted");
    expect(text).toContain("eligibility_label_not_allowlisted");
    // The recorded payload too, named by whatever repository the fixture records — read
    // from the fixture rather than written here, because the core must not carry a
    // concrete project's coordinates into its own tests.
    const recorded = (JSON.parse(readFileSync(GITHUB_FIXTURE, "utf8")) as {
      issues: Array<{ id: number; owner: string; repo: string; labels: string[] }>;
    }).issues[0]!;
    expect(recorded.labels).toEqual([]);
    expect(text).toContain(`intake refused ${recorded.owner}/${recorded.repo}#${recorded.id} (github)`);
    // Never the scheduler's vocabulary: a refused issue is not a blocked work unit.
    expect(text).not.toContain("scheduler");
    expect(text).not.toContain("blocked");
  });

  it("lists what it accepted as well as what it refused", async () => {
    const out = join(scratch("both"), "plan.json");
    const result = await run(githubArgs(out));

    // Having both lists is the point: an operator does not re-run intake to find out
    // what was excluded, and does not have to diff the plan against the issue list.
    expect(result.lines.join("\n")).toContain("intake accepted acme/widgets#900 (github)");
    expect(result.lines.join("\n")).toContain("2 accepted, 8 refused");
  });
});

describe("intake plans; it does not dispatch", () => {
  it("says so, and names the separate command that runs the plan", async () => {
    const out = join(scratch("nodispatch"), "plan.json");
    const result = await run(githubArgs(out));

    const text = result.lines.join("\n");
    expect(text).toContain("nothing was dispatched");
    // Running the plan is a separate, human-initiated command. Naming it here is how
    // the two steps stay visibly distinct instead of being piped together.
    expect(text).toContain(`factory work run --work-units ${out}`);
  });

  it("has no import that could dispatch, mutate a provider, or reflect status", async () => {
    // Structural evidence, beside the behavioural test above: a green run cannot see
    // a capability the module does not happen to call on this input. `node:fs` is the
    // one reach it is allowed, because writing the plan is the command's whole job.
    const source = readFileSync("src/cli/intake.ts", "utf8");
    const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]!);
    expect([...new Set(imports)].sort()).toEqual([
      "../adapters/github/index.js",
      "../adapters/linear/index.js",
      "../kernel/intake-plan.js",
      "../kernel/json-schema.js",
      "./args.js",
      "node:fs",
    ]);
    for (const forbidden of [
      "node:child_process",
      "node:http",
      "node:https",
      "kernel/pipeline",
      "kernel/execution",
      "kernel/scheduler",
      "kernel/integration",
      "kernel/repair",
      "security/index",
      "state/event-log",
      "adapters/opencode",
      "adapters/herdr",
      "adapters/hermes",
      "linear/status",
      "import(",
      "require(",
    ]) {
      expect(source, `the intake command must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("leaves a real repository with nothing but the plan file behind", async () => {
    // Behavioural evidence rather than a claim about imports. A fresh repository, one
    // intake run, and then: no branch, no worktree, no event log, no modified file.
    const repo = scratch("readonly");
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    const out = join(repo, "plan.json");

    const result = await dispatch(
      ["intake", "--source", "github", "--records", join(process.cwd(), GITHUB_FIXTURE), "--out", out,
        "--repository", "acme/widgets", "--eligible-label", "factory:eligible"],
      { cwd: repo },
    );

    expect(result.exitCode).toBe(0);

    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo });
    // `plan.json` is the decision intake was asked to make, and it is untracked like
    // any new file. Nothing else was created: no `.factory/events.jsonl`, no worktree
    // registration, no mutation of the checkout.
    expect(status.stdout.trim().split("\n").filter((line) => line.length > 0).sort()).toEqual(["?? plan.json"]);

    const branches = await execFileAsync("git", ["branch", "--list"], { cwd: repo });
    expect(branches.stdout.split("\n").filter((line) => line.trim().length > 0)).toEqual([]);
    const worktrees = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
    expect(worktrees.stdout.split("\n").filter((line) => line.trim().length > 0)).toHaveLength(1);
    expect(() => readFileSync(join(repo, ".factory/events.jsonl"), "utf8")).toThrow();
  });
});

describe("the command reports itself in machine-readable form", () => {
  it("emits provenance for every unit and refusal under --json", async () => {
    const out = join(scratch("json"), "plan.json");
    const result = await run(githubArgs(out, "--json"));

    const report = JSON.parse(result.lines.join("\n")) as {
      source: string;
      records: number;
      plan: string;
      dispatched: boolean;
      units: Array<{ id: string; provider: string }>;
      refusals: Array<{ source: { provider: string; reference: string; url?: string }; refusal: { classification: string } }>;
    };

    expect(report.source).toBe("github");
    expect(report.records).toBe(10);
    expect(report.plan).toBe(out);
    // Stated as a field, not just implied by the absence of a pipeline call: the one
    // property a caller wiring this into automation most needs to assert on.
    expect(report.dispatched).toBe(false);

    // Provenance survives: a planned unit is traceable to its provider record, and a
    // refusal carries the full source including the deep link.
    expect(report.units).toEqual([
      { id: "acme/widgets#900", provider: "github" },
      { id: "acme/widgets#904", provider: "github" },
    ]);
    const refusal = report.refusals.find((entry) => entry.source.reference === "acme/widgets#901");
    expect(refusal?.source.provider).toBe("github");
    expect(refusal?.source.url).toContain("/issues/901");
    expect(refusal?.refusal.classification).toBe("not_allowlisted");
  });

  it("records the Linear deep link so a plan can be traced back to its issue", async () => {
    const out = join(scratch("json-linear"), "plan.json");
    const result = await run([
      "intake", "--source", "linear", "--records", LINEAR_FIXTURE, "--out", out,
      "--repository", "acme/widgets", "--eligible-status", "started",
      "--eligible-status-name", "In Progress", "--json",
    ]);

    const report = JSON.parse(result.lines.join("\n")) as {
      units: Array<{ id: string; provider: string }>;
      refusals: Array<{ source: { url?: string } }>;
    };
    expect(report.units).toEqual([
      { id: "ENG-903", provider: "linear" },
      { id: "ENG-905", provider: "linear" },
    ]);
    expect(report.refusals.some((entry) => entry.source.url?.includes("ENG-900"))).toBe(true);
  });
});

describe("intake runs with no provider credentials", () => {
  it("plans identically whether or not a provider token is present", async () => {
    const names = ["LINEAR_API_KEY", "LINEAR_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
    const saved = names.map((name) => process.env[name]);
    const output = async (): Promise<string> => {
      const out = join(scratch("credentials"), "plan.json");
      const result = await dispatch(
        ["intake", "--source", "github", "--records", GITHUB_FIXTURE, "--out", out,
          "--repository", "acme/widgets", "--eligible-label", "factory:eligible", "--json"],
        { cwd: process.cwd() },
      );
      // The plan path differs per run by construction, so it is removed before the
      // comparison; everything else about the decision must be identical.
      return result.lines.join("\n").replaceAll(out, "<plan>");
    };

    let withoutCredentials: string;
    try {
      for (const name of names) delete process.env[name];
      withoutCredentials = await output();
      for (const name of names) process.env[name] = "synthetic_not_a_real_credential";
      expect(await output()).toBe(withoutCredentials);
    } finally {
      for (const [index, name] of names.entries()) {
        const value = saved[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("reads no environment variable on the intake path at all", () => {
    // Stronger than comparing two runs: a credential check that only ever compared
    // equal would still be a credential check. CI has no provider auth, so any
    // dependency on one would fail there instead of here.
    const source = readFileSync("src/cli/intake.ts", "utf8");
    expect(source).not.toContain("process.env");
  });
});

describe("a mistake in the invocation is an error, not an empty plan", () => {
  const cases: Array<[string, string[], RegExp]> = [
    ["no --source", ["intake", "--records", GITHUB_FIXTURE, "--out", "plan.json"], /--source/],
    ["an unknown provider", ["intake", "--source", "jira", "--records", GITHUB_FIXTURE, "--out", "plan.json"], /must be one of: linear, github/],
    ["no --records", ["intake", "--source", "github", "--out", "plan.json"], /--records/],
    ["no --out", ["intake", "--source", "github", "--records", GITHUB_FIXTURE], /--out/],
    ["a missing records file", ["intake", "--source", "github", "--records", "fixtures/does-not-exist.json", "--out", "plan.json"], /does-not-exist/],
    ["a flag the provider does not have", ["intake", "--source", "linear", "--records", LINEAR_FIXTURE, "--out", "plan.json", "--eligible-label", "factory:eligible"], /--eligible-label/],
  ];

  for (const [why, argv, expected] of cases) {
    it(`refuses ${why}`, async () => {
      const result = await run(argv);

      // Each of these is a mistake the operator made, and each exits 1 with a line
      // naming it. A command that shrugged and wrote an empty plan would report "no
      // work found" for a typo in a path.
      expect(result.exitCode).toBe(1);
      expect(result.lines.join("\n")).toMatch(expected);
    });
  }

  it("refuses a records file that is not a list of records", async () => {
    const path = join(scratch("malformed"), "issues.json");
    writeFileSync(path, JSON.stringify({ issues: { not: "an array" } }));
    const result = await run(["intake", "--source", "github", "--records", path, "--out", "plan.json"]);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain(path);
  });

  it("names the record and the field when a record cannot be read at all", async () => {
    // A record that is *ineligible* is refused by the provider, by name. A record that
    // cannot be read — `labels` a string rather than a list — is a different failure,
    // and reporting it as a stack trace from inside a provider rule would send an
    // operator looking in the wrong place.
    const path = join(scratch("unreadable"), "issues.json");
    writeFileSync(path, JSON.stringify([{ id: 900, owner: "acme", repo: "widgets", title: "t", state: "open", labels: "factory:eligible" }]));
    const result = await run(["intake", "--source", "github", "--records", path, "--out", "plan.json"]);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain(`${path}[0]: 'labels' must be an array of strings`);
  });

  it("names the field a provider needs when a record is missing it", async () => {
    const path = join(scratch("missing-field"), "issues.json");
    writeFileSync(path, JSON.stringify([{ id: 900, owner: "acme", repo: "widgets", title: "t" }]));
    const result = await run(["intake", "--source", "github", "--records", path, "--out", "plan.json"]);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain(`${path}[0]: 'state' must be a string`);
  });

  it("writes no plan file when the invocation was wrong", async () => {
    // A failed command that still leaves a plan behind is worse than one that does
    // not: the file looks like a decision someone made.
    const out = join(scratch("no-write"), "plan.json");
    const result = await run(["intake", "--source", "jira", "--records", GITHUB_FIXTURE, "--out", out]);

    expect(result.exitCode).toBe(1);
    expect(() => readFileSync(out, "utf8")).toThrow();
  });
});

describe("intake refusal and scheduler refusal are two different reports", () => {
  /**
   * `work run` once printed "intake refused" while reading `planSchedule` decisions, so
   * an operator could not tell a refused issue from a Work Unit the scheduler blocked.
   * Both reports are produced by this repository, so the distinction is asserted by
   * producing both here rather than by checking one string.
   */
  it("reports a refused record as intake and a blocked unit as the scheduler", async () => {
    const out = join(scratch("identity"), "plan.json");
    const intake = await run(githubArgs(out));

    // Issue 901 is open and fully declared, and carries no eligibility label.
    const intakeRefusal = intake.lines.find((line) => line.includes("acme/widgets#901"));
    if (intakeRefusal === undefined) throw new Error("unreachable: 901 is refused");
    expect(intakeRefusal).toContain("intake refused acme/widgets#901 (github): not_allowlisted");
    expect(intakeRefusal).not.toContain("scheduler");
    expect(intakeRefusal).not.toContain("blocked");

    // The same vocabulary, on the other side: a Work Unit whose declared capabilities
    // no runtime provides is blocked by the scheduler, and the reason names the
    // scheduler and never says "intake".
    const blocked = await runPipeline({
      workUnits: [
        {
          workUnit: {
            id: "ENG-903",
            goal: "Content schema slug validation",
            repository: "acme/widgets",
            capabilities: ["a-capability-no-runtime-provides"],
            acceptanceCriteria: ["Duplicate slugs fail the build."],
          },
          paths: ["src/slug"],
        },
      ],
      schema: JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8")) as JsonSchema,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      checks: [{ name: "noop", command: "true" }],
      cwd: process.cwd(),
      // A fixed clock so the comparison is about wording, not about time.
      now: () => "2026-01-01T00:00:00.000Z",
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toContain("scheduler blocked");
    expect(blocked.reason).not.toContain("intake");
  });
});

describe("the documentation matches what shipped", () => {
  const cli = readFileSync("docs/cli.md", "utf8");

  it("documents the command, its flags, and that it writes rather than runs", () => {
    // A command an operator cannot discover is not a command. The three flags that
    // cannot be guessed are which provider, where the records are, and where the plan
    // goes — so all three are named in the doc, not just in `--help`.
    expect(cli).toMatch(/factory intake/);
    expect(cli).toMatch(/--source/);
    expect(cli).toMatch(/--records/);
    expect(cli).toMatch(/--out\b/);
    // And the two steps stay visibly separate, because that is the decision FCT-018
    // deferred: intake plans, a human runs.
    expect(cli).toMatch(/nothing (was |is )?dispatch/i);
  });

  it("no longer claims that no CLI command reads a provider", () => {
    // This claim was true when written and is false now, for both providers.
    for (const path of [
      "docs/cli.md",
      "docs/protocols.md",
      "docs/linear-adapter.md",
      "docs/github-intake.md",
      "README.md",
    ]) {
      const body = readFileSync(path, "utf8");
      expect(body, `${path} still says no CLI command reads a provider`).not.toMatch(
        /No CLI command reads Linear|no `factory` command reads a provider|not reachable from the CLI/i,
      );
    }
  });

  it("states where provenance survives, rather than implying it is on the Work Unit", () => {
    // The interesting question about a plan entry is how a reader traces it back to
    // its issue, and the honest answer is the id plus the report — not a provider field
    // inside a provider-neutral contract.
    expect(cli).toMatch(/provenance/i);
  });
});

describe("the same inputs plan the same bytes, twice", () => {
  it("produces an identical plan file for identical records and policy", async () => {
    // Multi-unit on purpose: a single-unit plan is byte-identical to almost any
    // serialisation, so the determinism claim is only worth making over a plan whose
    // order and content both had something to get wrong.
    const args = (out: string): string[] => [
      "intake", "--source", "linear", "--records", LINEAR_FIXTURE, "--out", out,
      "--repository", "acme/widgets", "--eligible-status", "started", "--eligible-status-name", "In Progress",
    ];
    const first = join(scratch("determinism-a"), "plan.json");
    const second = join(scratch("determinism-b"), "plan.json");

    await run(args(first));
    await run(args(second));

    // The plan is a document a human reviews before work runs, so re-running intake
    // must not rewrite what they agreed to. A timestamp would break this.
    expect(writtenPlan(first)).toHaveLength(2);
    expect(readFileSync(second, "utf8")).toBe(readFileSync(first, "utf8"));
    expect(readFileSync(first, "utf8")).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps a multi-source plan stable across both providers", async () => {
    // The brief's criterion is "multi-Work Unit intake is deterministic for the same
    // source inputs and policy config", so the check runs both providers and compares
    // the pair rather than one provider twice.
    const rounds: Array<{ files: string[]; units: number }> = [];
    for (const round of [0, 1]) {
      const linear = join(scratch(`multi-linear-${round}`), "plan.json");
      const github = join(scratch(`multi-github-${round}`), "plan.json");
      await run([
        "intake", "--source", "linear", "--records", LINEAR_FIXTURE, "--out", linear,
        "--repository", "acme/widgets", "--eligible-status", "started", "--eligible-status-name", "In Progress",
      ]);
      await run(githubArgs(github));
      rounds.push({
        files: [readFileSync(linear, "utf8"), readFileSync(github, "utf8")],
        units: plannedIds(linear).length + plannedIds(github).length,
      });
    }

    // Four units per round — two Linear, two GitHub — so the comparison is over
    // something a shuffled or clock-stamped serialiser could actually differ on.
    expect(rounds[0]?.units).toBe(4);
    expect(rounds[1]?.files).toEqual(rounds[0]?.files);
  });

  it("orders planned units by the input order of the records", async () => {
    // Determinism includes order. Sorting by id would make a plan stable while
    // quietly reordering the work an operator reviewed.
    const out = join(scratch("order"), "plan.json");
    await run(githubArgs(out));

    const parsed = readWorkUnitFile(out).map((scheduled) => scheduled.workUnit.id);
    expect(parsed).toEqual(["acme/widgets#900", "acme/widgets#904"]);
    expect([...parsed]).toEqual([...parsed].sort());
  });

  it("overwrites an existing plan rather than appending to it", async () => {
    const out = join(scratch("overwrite"), "plan.json");
    writeFileSync(out, JSON.stringify([{ workUnit: { id: "STALE-1" } }]));

    await run(githubArgs(out));

    // A plan is the whole decision, not an append to one. Merging a previous plan's
    // units into this run's would dispatch work nobody re-approved.
    expect(plannedIds(out)).not.toContain("STALE-1");
    expect(plannedIds(out)).toEqual(["acme/widgets#900", "acme/widgets#904"]);
  });
});