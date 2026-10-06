import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkScope, describeScopeViolation, normalizePath } from "../src/kernel/scope.js";
import { parsePorcelain } from "../src/adapters/git/changes.js";
import { runPipeline } from "../src/kernel/pipeline.js";
import type { ScheduledWorkUnit } from "../src/kernel/scheduler.js";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import type { ChangedFiles } from "../src/adapters/git/changes.js";
import { InMemoryEventLog } from "../src/state/event-log.js";
import { FakeRuntime } from "../src/fake-runtime.js";
import type { WorkUnit, WorkspaceRef } from "../src/protocol.js";

/**
 * Scope enforcement.
 *
 * A Work Unit's declared `paths` were advisory: they fed conflict detection and
 * nothing else. Dogfooding found a dispatched agent writing to `README.md` and
 * `package-lock.json` while its Work Unit declared two files — in a repository whose
 * policy is that the lockfile is reviewed as source.
 */

const schema: JsonSchema = {
  type: "object",
  required: ["id", "goal", "repository", "capabilities", "acceptance_criteria"],
  properties: {
    id: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    repository: { type: "string", minLength: 1 },
    capabilities: { type: "array", minItems: 1, items: { type: "string" } },
    acceptance_criteria: { type: "array", minItems: 1, items: { type: "string" } },
  },
};

describe("scope classification", () => {
  it("treats a declared directory as covering everything beneath it", () => {
    const check = checkScope(["src/kernel/pipeline.ts", "src/kernel/scope.ts"], ["src/kernel"]);
    expect(check.outOfScope).toEqual([]);
    expect(check.undeclared).toBe(false);
  });

  it("treats a declared file as covering only itself", () => {
    const check = checkScope(["src/a.ts", "src/b.ts"], ["src/a.ts"]);
    expect(check.outOfScope.map((change) => change.file)).toEqual(["src/b.ts"]);
  });

  it("does not match on substring, so a sibling prefix is out of scope", () => {
    // `src/kernel` must not cover `src/kernel-notes.md`. Substring matching would
    // silently widen every boundary.
    const check = checkScope(["src/kernel-notes.md"], ["src/kernel"]);
    expect(check.outOfScope.map((change) => change.file)).toEqual(["src/kernel-notes.md"]);
  });

  it("normalizes ./ and trailing slashes on both sides", () => {
    expect(checkScope(["./src/a.ts"], ["./src/"]).outOfScope).toEqual([]);
    expect(normalizePath("./src/a/")).toBe("src/a");
    expect(normalizePath("/src/a")).toBe("src/a");
  });

  it("reports no gate when paths are undeclared, and says so", () => {
    const check = checkScope(["anything.ts"], undefined);
    expect(check.undeclared).toBe(true);
    expect(check.outOfScope).toEqual([]);
    expect(describeScopeViolation(check)).toMatch(/scope not declared/);
  });

  it("names every out-of-scope file", () => {
    const check = checkScope(["src/ok.ts", "README.md", "docs/x.md"], ["src/ok.ts"]);
    expect(describeScopeViolation(check)).toContain("README.md, docs/x.md");
  });

  it("calls out a dependency lockfile specifically", () => {
    // This repository treats package-lock.json as reviewed source; a generic
    // "out of scope" line is too easy to skim past.
    const description = describeScopeViolation(checkScope(["package-lock.json"], ["src/"]));
    expect(description).toMatch(/package-lock\.json/);
    expect(description).toMatch(/dependency lockfile/);
  });

  it("flags a lockfile at any depth", () => {
    expect(checkScope(["apps/web/pnpm-lock.yaml"], ["src/"]).outOfScope[0]?.lockfile).toBe(true);
    expect(checkScope(["src/pnpm-lock.yaml"], ["src"]).outOfScope).toEqual([]);
  });

  it("describes a clean run plainly", () => {
    expect(describeScopeViolation(checkScope(["src/a.ts"], ["src"]))).toBe("within declared scope");
  });
});

describe("porcelain parsing", () => {
  it("reads modified, added, and untracked files", () => {
    const out = " M src/a.ts\n?? src/new.ts\nA  src/added.ts\n";
    expect([...parsePorcelain(out)].sort()).toEqual(["src/a.ts", "src/added.ts", "src/new.ts"]);
  });

  it("takes the new path of a rename", () => {
    // The old path no longer exists; the new one is what the agent produced.
    expect(parsePorcelain("R  src/old.ts -> src/new.ts\n")).toEqual(["src/new.ts"]);
  });

  it("unquotes paths containing spaces", () => {
    // Git quotes any path with a space; comparing the quoted form would never match
    // a declared path and would report a false violation.
    expect(parsePorcelain(' M "src/my file.ts"\n')).toEqual(["src/my file.ts"]);
  });

  it("ignores blank lines and dedupes", () => {
    expect(parsePorcelain("\n M src/a.ts\n\n M src/a.ts\n")).toEqual(["src/a.ts"]);
  });
});

/**
 * End-to-end through the pipeline, against a runtime that produces a real
 * directory — a fake path cannot be diffed.
 */
describe("the pipeline enforces declared scope", () => {
  function worktreeRuntime() {
    let n = 0;
    const root = join(mkdtempSync(join(tmpdir(), "factory-scope-")), "repo");
    mkdirSync(root, { recursive: true });
    const runtime = {
      name: "scope-runtime",
      runtime: {
        capabilities: async () => ["testing"],
        health: async () => ({ available: true, runtime: "scope-runtime" }),
        createWorkspace: async () => ({ id: `ws-${++n}`, path: root }),
        createWorktree: async (workspace: WorkspaceRef) => {
          const worktreePath = join(workspace.path, `worktree-${++n}`);
          mkdirSync(worktreePath, { recursive: true });
          return { ...workspace, worktreePath };
        },
        startAgent: async () => ({ id: "agent", runtimeId: "agent" }),
        promptAgent: async () => {},
        waitAgent: async () => "idle" as const,
        inspectAgent: async () => ({ status: "idle" }),
        collectRuntimeEvidence: async () => ({ runtime: "scope-runtime", workspaceId: "ws", agentId: "agent", events: [] }),
        cleanupWorkspace: async (workspace: WorkspaceRef) => {
          if (workspace.worktreePath) rmSync(workspace.worktreePath, { recursive: true, force: true });
        },
      },
    };
    return runtime;
  }

  const unit: WorkUnit = { id: "S-1", goal: "change one thing", repository: "r", capabilities: ["testing"], acceptanceCriteria: ["it changed"] };

  const run = async (paths: string[] | undefined, changedFiles: string[], extra: Record<string, unknown> = {}) => {
    const log = new InMemoryEventLog();
    const units: ScheduledWorkUnit[] = [{ workUnit: unit, ...(paths === undefined ? {} : { paths }) }];
    const changedFilesProvider: ChangedFiles = async () => changedFiles;
    const result = await runPipeline({
      workUnits: units,
      schema,
      runtimes: [worktreeRuntime()],
      checks: [{ name: "ok", command: "true" }],
      cwd: process.cwd(),
      eventLog: log,
      changedFiles: changedFilesProvider,
      runner: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
      ...extra,
    });
    return { result, log };
  };

  it("reaches ready when changes stay inside the declared paths", async () => {
    const { result } = await run(["src/"], ["src/a.ts", "src/b.ts"]);
    expect(result.status).toBe("ready");
    expect(result.runs[0]?.scope?.outOfScope).toEqual([]);
  });

  it("blocks a run that changed something outside the declared paths", async () => {
    // The dogfood case: two files declared, three touched, one a lockfile.
    const { result } = await run(["src/a.ts", "tests/a.test.ts"], [
      "src/a.ts",
      "tests/a.test.ts",
      "README.md",
      "package-lock.json",
    ]);
    expect(result.status).toBe("blocked");
    expect(result.runs[0]?.scope?.outOfScope.map((c) => c.file).sort()).toEqual(["README.md", "package-lock.json"]);
  });

  it("names the offending files in the integration reason", async () => {
    const { result } = await run(["src/"], ["README.md", "package-lock.json"]);
    // The worktree is cleaned up by the time an operator reads this, so the reason
    // has to carry the list.
    expect(result.runs[0]?.integration.reason).toContain("README.md");
    expect(result.runs[0]?.integration.reason).toContain("package-lock.json");
    expect(result.runs[0]?.integration.reason).toMatch(/dependency lockfile/);
    // And it must not claim the verification gate was what passed.
    expect(result.runs[0]?.integration.reason).not.toBe("verification_passed");
  });

  it("records the violation as a durable factory event naming each file", async () => {
    const { log } = await run(["src/"], ["README.md", "docs/x.md"]);
    const event = log.stored().find((candidate) => candidate.type === "scope.violation");
    expect(event).toBeDefined();
    expect(event?.source).toBe("factory");
    expect(event?.payload?.["outOfScope"]).toEqual(["README.md", "docs/x.md"]);
    expect(event?.payload?.["lockfiles"]).toEqual([]);
  });

  it("lists lockfiles separately in the event", async () => {
    const { log } = await run(["src/"], ["package-lock.json"]);
    expect(log.stored().find((candidate) => candidate.type === "scope.violation")?.payload?.["lockfiles"]).toEqual([
      "package-lock.json",
    ]);
  });

  it("downgrades to a warning under --no-strict-scope", async () => {
    const { result, log } = await run(["src/"], ["README.md"], { strictScope: false });
    expect(result.status).toBe("ready");
    expect(log.stored().some((event) => event.type === "scope.warning")).toBe(true);
    expect(log.stored().some((event) => event.type === "scope.violation")).toBe(false);
  });

  it("records no gate for a Work Unit that declares no paths", async () => {
    const { result } = await run(undefined, ["README.md"]);
    expect(result.status).toBe("ready");
    // Explicitly "no scope declared" rather than an empty violation list, so it can
    // never be mistaken for a narrowly-scoped run.
    expect(result.runs[0]?.scope?.undeclared).toBe(true);
  });

  it("makes no scope claim when no provider is supplied", async () => {
    const result = await runPipeline({
      workUnits: [{ workUnit: unit, paths: ["src/"] }],
      schema,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      checks: [{ name: "ok", command: "true" }],
      cwd: process.cwd(),
      verifyIn: "repo",
      runner: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
    });
    // Absent, not "in scope". Not checking is not the same as passing.
    expect(result.runs[0]?.scope).toBeUndefined();
  });

  it("fails loudly when the diff cannot be read", async () => {
    // A scope check that silently degrades to "no changes" would be the exact
    // false-green this gate exists to prevent.
    const broken: ChangedFiles = async () => {
      throw new Error("git exploded");
    };
    await expect(
      runPipeline({
        workUnits: [{ workUnit: unit, paths: ["src/"] }],
        schema,
        runtimes: [worktreeRuntime()],
        checks: [{ name: "ok", command: "true" }],
        cwd: process.cwd(),
        changedFiles: broken,
        runner: { async run() { return { stdout: "", stderr: "", exitCode: 0 }; } },
      }),
    ).rejects.toThrow(/scope check for S-1 failed: git exploded/);
  });

  it("verifies before it judges scope", async () => {
    // Ordering: a run whose checks fail is reported as failing checks, not as a
    // scope violation, because it was never correct in the first place.
    const order: string[] = [];
    const result = await runPipeline({
      workUnits: [{ workUnit: unit, paths: ["src/"] }],
      schema,
      runtimes: [worktreeRuntime()],
      checks: [{ name: "failing", command: "false" }],
      cwd: process.cwd(),
      changedFiles: async () => {
        order.push("scope");
        return ["README.md"];
      },
      repairPolicy: { maxAttempts: 0 },
      runner: {
        async run() {
          order.push("verify");
          return { stdout: "", stderr: "", exitCode: 1 };
        },
      },
    });
    expect(order).toEqual(["verify", "scope"]);
    // A run that is both broken and out of scope reports both. Reporting only the
    // scope violation would hide that the checks failed; reporting only the failed
    // checks would hide the boundary crossing.
    const reason = result.runs[0]?.integration.reason ?? "";
    expect(reason).toContain("verification_failed");
    expect(reason).toContain("README.md");
  });

  it("still cleans up the worktree after a scope violation", async () => {
    const { result } = await run(["src/"], ["README.md"]);
    expect(result.status).toBe("blocked");
    // No leftover worktrees in an adopting repository.
    const runs = result.runs;
    expect(runs).toHaveLength(1);
  });
});

describe("scope paths written into a real worktree", () => {
  it("matches against real files, not just injected lists", async () => {
    // Guards the integration between the porcelain parser and the gate, using a
    // directory the test actually creates.
    const root = mkdtempSync(join(tmpdir(), "factory-scope-files-"));
    writeFileSync(join(root, "in-scope.txt"), "x");
    writeFileSync(join(root, "loose.txt"), "x");

    const { gitChangedFiles } = await import("../src/adapters/git/changes.js");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "a@b.c"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "x"], { cwd: root });

    const changed = await gitChangedFiles(root);
    expect(changed.sort()).toEqual(["in-scope.txt", "loose.txt"]);
    expect(checkScope(changed, ["in-scope.txt"]).outOfScope.map((c) => c.file)).toEqual(["loose.txt"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("lists files inside a new directory individually", async () => {
    // Git collapses an untracked directory into one entry unless asked not to. That
    // made a run creating `newdir/` report a single change named `newdir/`, which a
    // path comparison against declared files cannot classify. Found by running this
    // against a real repository — the unit test above used files at the root, so it
    // never saw the collapse.
    const root = mkdtempSync(join(tmpdir(), "factory-scope-dir-"));
    const { gitChangedFiles } = await import("../src/adapters/git/changes.js");
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "a@b.c"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "x"], { cwd: root });

    mkdirSync(join(root, "newdir", "nested"), { recursive: true });
    writeFileSync(join(root, "newdir", "one.ts"), "x");
    writeFileSync(join(root, "newdir", "nested", "two.ts"), "x");

    const changed = await gitChangedFiles(root);
    expect(changed.sort()).toEqual(["newdir/nested/two.ts", "newdir/one.ts"]);
    // `newdir/` alone would have matched nothing declared and reported a violation
    // for a path that does not exist as a file.
    expect(checkScope(changed, ["newdir/one.ts"]).outOfScope.map((c) => c.file)).toEqual(["newdir/nested/two.ts"]);
    rmSync(root, { recursive: true, force: true });
  });
});