import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch, loadSchema } from "../src/cli/index.js";
import { parseArgs, readChecksFile, readWorkUnitFile, selectRuntimes } from "../src/cli/args.js";
import { validateWorkUnit, workUnitFromWireForm, workUnitToWireForm } from "../src/kernel/work-unit.js";
import type { LabelledRuntime } from "../src/kernel/work-unit.js";
import { FakeRuntime } from "../src/fake-runtime.js";

/**
 * These tests are about the operator-facing contract: what the CLI accepts, what
 * it prints, and — most importantly — which failures exit non-zero. A command that
 * cannot fail is worse than no command, because it looks like it worked.
 */

function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), `factory-cli-${name}-`));
}

function writeChecks(name: string, body: unknown): string {
  const path = join(scratch(`checks-${name}`), "checks.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return path;
}

function writeUnits(name: string, body: unknown): string {
  const path = join(scratch(name), "work-units.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return path;
}

const validWire = {
  id: "DEMO-1",
  goal: "Add a health endpoint",
  repository: "example/repo",
  capabilities: ["testing"],
  acceptance_criteria: ["tests pass"],
};

function run(argv: string[]) {
  return dispatch(argv, { cwd: process.cwd() });
}

describe("argument parsing", () => {
  it("separates commands, flags, and booleans", () => {
    const args = parseArgs(["work", "run", "--work-units", "a.json", "--json", "--max-parallel=2"]);
    expect(args.command).toEqual(["work", "run"]);
    expect(args.flags.get("work-units")).toBe("a.json");
    expect(args.flags.get("max-parallel")).toBe("2");
    expect(args.booleans.has("json")).toBe(true);
  });

  it("treats a trailing flag as boolean rather than swallowing the next token", () => {
    const args = parseArgs(["doctor", "--json"]);
    expect(args.command).toEqual(["doctor"]);
    expect(args.booleans.has("json")).toBe(true);
  });

  it("does not consume the next flag as a value", () => {
    const args = parseArgs(["work", "run", "--work-units", "--json"]);
    // A token starting with `--` is a flag, never a value: `--work-units` is
    // left valueless and `--json` stays a boolean. Absorbing the flag as a path
    // would fail later with a confusing "file not found".
    expect(args.flags.has("work-units")).toBe(false);
    expect(args.booleans.has("json")).toBe(true);
    expect(args.command).toEqual(["work", "run"]);
  });

  it("ignores a token that is only a bare dash", () => {
    const args = parseArgs(["verify", "-"]);
    expect(args.command).toEqual(["verify", "-"]);
  });
});

describe("runtime selection", () => {
  const runtimes: LabelledRuntime[] = [
    { name: "fake", runtime: new FakeRuntime() },
    { name: "other", runtime: new FakeRuntime() },
  ];

  it("returns every runtime when no name is given", () => {
    expect(selectRuntimes(runtimes, undefined)).toHaveLength(2);
  });

  it("returns only the named runtime", () => {
    expect(selectRuntimes(runtimes, "other").map((r) => r.name)).toEqual(["other"]);
  });

  it("refuses an unknown runtime instead of silently using another", () => {
    expect(() => selectRuntimes(runtimes, "typo")).toThrow(/no runtime named 'typo'/);
  });
});

describe("the wire form round-trips", () => {
  it("reads back what it wrote", () => {
    const original = {
      id: "W-1",
      goal: "ship it",
      repository: "example/repo",
      capabilities: ["testing"],
      acceptanceCriteria: ["it works"],
      baseRevision: "abc123",
      scope: ["src/a"],
      verification: ["npm test"],
      autonomy: "review" as const,
    };
    expect(workUnitFromWireForm(workUnitToWireForm(original))).toEqual(original);
  });

  it("keeps an empty acceptance-criteria list for validation to reject", () => {
    // Parsing is structural and validation is semantic; an empty array parses fine
    // and is refused downstream, so the rejection message comes from the layer
    // that knows what acceptance criteria mean.
    const wire = workUnitToWireForm({
      id: "W-1",
      goal: "g",
      repository: "r",
      capabilities: ["testing"],
      acceptanceCriteria: [],
    });
    const parsed = workUnitFromWireForm(wire);
    expect(parsed.acceptanceCriteria).toEqual([]);
    expect(validateWorkUnit(parsed, loadSchema()).valid).toBe(false);
  });

  it("rejects a missing required field by name", () => {
    expect(() => workUnitFromWireForm({ ...validWire, goal: undefined })).toThrow(/goal/);
  });

  it("rejects an unknown autonomy value", () => {
    expect(() => workUnitFromWireForm({ ...validWire, autonomy: "whenever" })).toThrow(/autonomy/);
  });

  it("rejects a non-array capability list", () => {
    expect(() => workUnitFromWireForm({ ...validWire, capabilities: "testing" })).toThrow(/capabilities/);
  });
});

describe("reading a work-unit file", () => {
  it("reads a valid plan", () => {
    const path = writeUnits("valid", [
      { workUnit: validWire, paths: ["src/a"] },
      { workUnit: { ...validWire, id: "DEMO-2" }, dependsOn: ["DEMO-1"], paths: ["src/b"] },
    ]);
    const units = readWorkUnitFile(path);
    expect(units).toHaveLength(2);
    expect(units[0]?.workUnit.acceptanceCriteria).toEqual(["tests pass"]);
    expect(units[1]?.dependsOn).toEqual(["DEMO-1"]);
  });

  it("rejects a non-array document", () => {
    const path = writeUnits("notarray", { workUnit: validWire });
    expect(() => readWorkUnitFile(path)).toThrow(/expected a JSON array/);
  });

  it("rejects invalid JSON with the file named", () => {
    const path = writeUnits("badjson", "{not json");
    expect(() => readWorkUnitFile(path)).toThrow(/not valid JSON/);
  });

  it("rejects an entry with no workUnit key", () => {
    const path = writeUnits("nowu", [{ paths: ["src/a"] }]);
    expect(() => readWorkUnitFile(path)).toThrow(/missing 'workUnit'/);
  });

  it("rejects a malformed workUnit rather than casting it through", () => {
    const path = writeUnits("malformed", [{ workUnit: { ...validWire, capabilities: 42 } }]);
    expect(() => readWorkUnitFile(path)).toThrow(/capabilities/);
  });

  it("rejects a non-string dependency list", () => {
    const path = writeUnits("baddeps", [{ workUnit: validWire, dependsOn: ["A", 7] }]);
    expect(() => readWorkUnitFile(path)).toThrow(/dependsOn/);
  });
});

describe("work validate reports per-unit results", () => {
  it("exits 0 when every Work Unit is valid", async () => {
    const path = writeUnits("ok", [
      { workUnit: validWire },
      { workUnit: { ...validWire, id: "DEMO-2" } },
    ]);
    const result = await run(["work", "validate", "--work-units", path]);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toMatch(/2\/2 work unit\(s\) valid/);
  });

  it("exits 1 and names the failing field", async () => {
    const path = writeUnits("bad", [{ workUnit: { ...validWire, capabilities: [] } }]);
    const result = await run(["work", "validate", "--work-units", path]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/fail\s+DEMO-1/);
    expect(result.lines.join("\n")).toMatch(/capabilities/);
  });
});

describe("the CLI reports failure rather than succeeding quietly", () => {
  it("exits 1 with usage when given no command", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/Usage:/);
  });

  it("exits 0 when help is explicitly requested", async () => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toMatch(/Usage:/);
  });

  it("exits 1 on an unknown command", async () => {
    const result = await run(["nonsense"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/unknown command: nonsense/);
  });

  it("exits 1 when the work-unit file is missing", async () => {
    const result = await run(["work", "run", "--work-units", "/nonexistent/path.json"]);
    expect(result.exitCode).toBe(1);
  });

  it("exits 1 when --work-units is omitted", async () => {
    const result = await run(["work", "run"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/--work-units/);
  });

  it("exits 1 for an invalid --verify-in value", async () => {
    const path = writeUnits("verifyin", [{ workUnit: validWire }]);
    const result = await run(["work", "run", "--work-units", path, "--verify-in", "somewhere"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/--verify-in must be/);
  });

  it("exits 1 for an unknown runtime rather than substituting one", async () => {
    const path = writeUnits("runtime", [{ workUnit: validWire }]);
    const result = await run(["work", "run", "--work-units", path, "--runtime", "typo"]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/no runtime named 'typo'/);
  });
});

describe("the CLI cannot report success from runtime status", () => {
  it("blocks when the runtime completes but verification fails", async () => {
    // The real `npm test` check runs against the fake runtime's worktree, which
    // does not exist on disk — so verification genuinely fails here. This is the
    // operator-visible form of the invariant the pipeline tests assert.
    const path = writeUnits("blocked", [{ workUnit: { ...validWire, capabilities: ["testing"] } }]);
    const result = await run(["work", "run", "--work-units", path, "--runtime", "fake", "--json"]);
    expect(result.exitCode).toBe(1);

    const payload = JSON.parse(result.lines.join("\n")) as {
      status: string;
      runs: Array<{ verification: string; integration: string }>;
    };
    expect(payload.status).toBe("blocked");
    expect(payload.runs[0]?.verification).not.toBe("passed");
    expect(payload.runs[0]?.integration).toBe("blocked");
  });
});
describe("the schema is found from outside the factory checkout", () => {
  it("resolves schemas/work-unit.schema.json relative to the factory, not the cwd", () => {
    // An adopting project does not ship the factory's schemas, and `doctor` does
    // not require them. If the CLI read them from the cwd, `doctor` would report a
    // healthy environment and `work validate` would then fail on a missing file —
    // a check and an action disagreeing about where the contract lives.
    expect(loadSchema().required).toContain("acceptance_criteria");
  });

  it("does not depend on a schemas directory in the current directory", async () => {
    // Both assertions run from the repository root, which *does* have schemas/.
    // The test is that removing that coincidence would not change the outcome;
    // the candidate list in loadSchema puts the factory location first.
    const previous = process.cwd();
    const scratch = join(tmpdir(), "factory-no-schemas");
    mkdirSync(scratch, { recursive: true });
    try {
      process.chdir(scratch);
      expect(loadSchema().required).toContain("acceptance_criteria");
    } finally {
      process.chdir(previous);
    }
  });
});

describe("the checks file decides what verification runs", () => {
  const checks = (name: string, body: unknown): string =>
    writeChecks(name, typeof body === "string" ? body : JSON.stringify(body));

  it("reads a valid checks file", () => {
    const path = checks("valid", [
      { name: "pytest", command: "pytest", args: ["-q"] },
      { name: "lint", command: "cargo", args: ["fmt", "--check"] },
    ]);
    expect(readChecksFile(path)).toEqual([
      { name: "pytest", command: "pytest", args: ["-q"] },
      { name: "lint", command: "cargo", args: ["fmt", "--check"] },
    ]);
  });

  it("allows a check with no args", () => {
    const path = checks("noargs", [{ name: "typecheck", command: "tsc" }]);
    expect(readChecksFile(path)).toEqual([{ name: "typecheck", command: "tsc" }]);
  });

  it("refuses an empty list, which would pass everything", () => {
    const path = checks("empty", []);
    expect(() => readChecksFile(path)).toThrow(/at least one check is required/);
  });

  it("refuses a non-array document", () => {
    const path = checks("notarray", { name: "x", command: "y" });
    expect(() => readChecksFile(path)).toThrow(/expected a JSON array/);
  });

  it("refuses a check with no command", () => {
    const path = checks("nocmd", [{ name: "lint" }]);
    expect(() => readChecksFile(path)).toThrow(/'command' must be a non-empty string/);
  });

  it("refuses non-string args rather than coercing them", () => {
    const path = checks("badargs", [{ name: "x", command: "y", args: [1] }]);
    expect(() => readChecksFile(path)).toThrow(/'args' must be an array of strings/);
  });

  it("refuses invalid JSON with the file named", () => {
    const path = checks("badjson", "{nope");
    expect(() => readChecksFile(path)).toThrow(/not valid JSON/);
  });

  it("is reported through the CLI rather than crashing", async () => {
    const units = writeUnits("checks-units", [{ workUnit: validWire }]);
    const result = await run(["work", "run", "--work-units", units, "--checks", checks("cli-bad", [])]);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/at least one check is required/);
  });
});

describe("checks reach the verification stage", () => {
  it("runs the supplied checks instead of npm test", async () => {
    // If the flag were ignored, the pipeline would shell out to `npm test`, which
    // does not exist in this scratch project and would fail the run.
    const units = writeUnits("checks-run", [
      { workUnit: { ...validWire, capabilities: ["testing"] } },
    ]);
    const result = await run([
      "work", "run",
      "--work-units", units,
      "--runtime", "fake",
      "--verify-in", "repo",
      "--checks", writeChecks("true", [{ name: "always-true", command: "node", args: ["-e", "process.exit(0)"] }]),
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.lines.join("\n")) as { status: string; runs: Array<{ integration: string }> };
    expect(payload.status).toBe("ready");
    expect(payload.runs[0]?.integration).toBe("ready");
  });

  it("a failing supplied check blocks the run", async () => {
    const units = writeUnits("checks-fail", [
      { workUnit: { ...validWire, capabilities: ["testing"] } },
    ]);
    const result = await run([
      "work", "run",
      "--work-units", units,
      "--runtime", "fake",
      "--verify-in", "repo",
      "--checks", writeChecks("false", [{ name: "always-false", command: "node", args: ["-e", "process.exit(1)"] }]),
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.lines.join("\n")) as { status: string };
    expect(payload.status).toBe("blocked");
  });
});

describe("factory verify reads the project's own checks", () => {
  /**
   * The previous implementation invoked a fixed list including `format:check`,
   * `lint`, and `typecheck` — none of which this repository defines — so
   * `factory verify` failed on a factory that is itself green. A verification
   * command a project does not recognise can only fail, and a command that cannot
   * pass is indistinguishable from one that found a problem.
   */

  function project(scripts: Record<string, string> | null, name: string): string {
    const dir = scratch(`verify-${name}`);
    if (scripts !== null) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", scripts }));
    } else {
      writeFileSync(join(dir, "README.md"), "no package.json here");
    }
    return dir;
  }

  const runVerify = async (cwd: string) => dispatch(["verify"], { cwd });

  it("runs the project's own verify script alone", async () => {
    // A `verify` script that already chains `test` must not also run `test`
    // separately, or the suite runs twice and a slow check reads as a failure.
    const dir = project({ verify: "true", test: "true", build: "true" }, "has-verify");
    const result = await runVerify(dir);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toMatch(/ok\s+npm run verify/);
    expect(result.lines.join("\n")).not.toMatch(/npm run test/);
  });

  it("runs only the steps the project declares, and names the rest", async () => {
    const dir = project({ test: "true" }, "partial");
    const result = await runVerify(dir);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toMatch(/ok\s+npm run test/);
    expect(result.lines.join("\n")).toMatch(/skip\s+not declared by this project: .*lint/);
  });

  it("fails when the project declares no checks at all", async () => {
    // "Nothing was verified" must never be reported as "verification passed".
    const dir = project({ start: "true" }, "none");
    const result = await runVerify(dir);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/declares none of/);
    expect(result.lines.join("\n")).not.toMatch(/verification passed/);
  });

  it("fails when there is no readable package.json", async () => {
    const result = await runVerify(project(null, "nopkg"));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/no readable package\.json/);
  });

  it("fails when a declared check fails", async () => {
    const result = await runVerify(project({ test: "exit 1" }, "failing"));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/fail\s+npm run test/);
    expect(result.lines.join("\n")).not.toMatch(/verification passed/);
  });
});
