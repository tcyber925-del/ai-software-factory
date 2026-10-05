import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatch, loadSchema } from "../src/cli/index.js";
import { parseArgs, readWorkUnitFile, selectRuntimes } from "../src/cli/args.js";
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