# Mutation Corpus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hand-authored defect corpus and a zero-dependency runner that proves the existing test suite fails when a factory control is deliberately degraded.

**Architecture:** Five named defects live in `defects/mutations.json`, each naming the source line to change and the check meant to catch it. `scripts/mutation/run.mjs` copies the repository to a scratch directory, applies one defect there, runs the suite, and records which test file caught it. The working tree is never written, so a killed run cannot leave a mutated `src/` behind. `defects/ratchet.json` fails the rung if the corpus shrinks or any defect becomes uncaught.

**Tech Stack:** Node 22 ESM, no dependencies. Vitest as the runner-under-test. `node:fs`, `node:child_process`, `node:os`, `node:path` only.

**Spec:** `docs/superpowers/specs/2026-10-06-mutation-runner-design.md`

## Global Constraints

- **Zero new dependencies.** `package.json` and `package-lock.json` must be byte-identical when this work lands. This is a documented invariant (`src/kernel/json-schema.ts`, `docs/verification-and-merge-gates.md`), not a preference.
- **The working tree is never written.** All mutation happens in a scratch directory outside the repository. No step may `git checkout` or otherwise restore a mutated file as its correctness mechanism.
- **An unevaluated mutation is not an escape.** Any condition preventing the suite from running against a mutated tree is a corpus error, reported by name, exiting non-zero. It is never reported as "escaped."
- **An anchor that does not match exactly once is a corpus error.** Never silently skipped.
- **The CI rung is non-blocking.** `continue-on-error: true`, with the reason in the workflow file.
- The corpus must not quote the test-suite size anywhere. `main` removed those numbers deliberately (#57); re-adding one re-arms the trap.
- Node 22 minimum, matching `MINIMUM_NODE_MAJOR` in `src/doctor/doctor.ts`.
- Tests are discovered only from `tests/**/*.test.ts` (`vitest.config.ts`). Anything the runner adds must land there, or it will not run.

## Review Focus

Five input classes most likely to bite someone using this tool. Each is pinned by a test in the task that owns the code.

1. **A corpus file names a source line that has since been edited** — the anchor silently matches zero times. Expected: a corpus error naming the defect, never a green run and never an "escape."
2. **The runner is killed mid-run** (CI timeout, `SIGKILL`, cancelled job). Expected: the working tree is byte-identical afterwards, because it was never written.
3. **A mutated tree fails to build** — a syntax error in the mutated file, or a type error. Expected: reported as caught (the suite cannot pass), distinct from corpus error.
4. **`node_modules` is a symlink** rather than a real directory in the scratch tree. Expected: detected and reported as a corpus error, not an escape — this was observed to produce a spurious `repo-hygiene` failure during planning.
5. **The corpus is edited to remove a defect** — someone deletes a row to make the rung pass. Expected: the ratchet fails on a shrinking corpus.

---

## File Structure

```
defects/
  README.md              why the corpus exists, and how to add a defect
  mutations.json         the five defects: id, aimsAt, why, file, find, replace
  ratchet.json           the counts that must not go down
scripts/mutation/
  run.mjs                CLI entry: loads corpus, builds scratch tree, reports
  corpus.mjs             load + validate mutations.json; anchor resolution
  scratch.mjs            copy repo to temp dir, node_modules symlink detection
  evaluate.mjs           apply one defect, run suite, return which test caught it
  ratchet.mjs            compare current corpus against ratchet.json
tests/
  mutation-runner.test.ts  tests the runner itself
```

Rationale for splitting: `corpus.mjs` (loading/validating) has no I/O beyond reading JSON and is the piece with the most edge cases; `scratch.mjs` is filesystem setup; `evaluate.mjs` is process orchestration; `ratchet.mjs` is pure comparison. A single 400-line `run.mjs` would make the anchor-validation logic — the part that must not lie — hard to test in isolation.

---

## Task 1: Corpus format and anchor validation

The load and validate layer, plus the defect corpus itself. Nothing runs a suite yet.

**Files:**
- Create: `defects/mutations.json`
- Create: `defects/README.md`
- Create: `scripts/mutation/corpus.mjs`
- Test: `tests/mutation-runner.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `loadCorpus(repoRoot) -> { defects: Defect[], errors: CorpusError[] }`
  - `CorpusError = { defectId: string, file: string, message: string }`
  - `applyDefect(source, defect) -> { mutated: string }` — throws `CorpusError` when `find` is not present exactly once
  - `Defect = { id, aimsAt, why, file, find, replace, expected }`

- [ ] **Step 1: Write the failing tests**

Create `tests/mutation-runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyDefect, loadCorpus } from "../scripts/mutation/corpus.mjs";

// TypeScript cannot import a .mjs without a declaration; the runner is plain
// ESM on purpose. These casts keep the test honest about the shape it expects.
const loadCorpusTyped = loadCorpus as unknown as (
  repoRoot: string,
) => { defects: unknown[]; errors: { defectId: string; file: string; message: string }[] };
const applyDefectTyped = applyDefect as unknown as (
  source: string,
  defect: unknown,
) => { mutated: string };

describe("mutation corpus", () => {
  const repoRoot = process.cwd();

  it("loads five defects from the shipped corpus", () => {
    const { defects } = loadCorpusTyped(repoRoot);
    expect(Array.isArray(defects)).toBe(true);
    expect(defects.length).toBe(5);
  });

  it("gives every defect an id, an aim, a reason, and a file that exists", () => {
    const { defects } = loadCorpusTyped(repoRoot);
    for (const defect of defects) {
      const d = defect as { id: string; aimsAt: string; why: string; file: string };
      expect(typeof d.id).toBe("string");
      expect(d.why.length).toBeGreaterThan(20);
      expect(d.aimsAt).toMatch(/^tests\/.+\.test\.ts$/);
      expect(() => readFileSync(`${repoRoot}/${d.file}`, "utf8")).not.toThrow();
    }
  });

  it("names a test file that actually exists for every defect", () => {
    const { defects } = loadCorpusTyped(repoRoot);
    for (const defect of defects) {
      const d = defect as { aimsAt: string };
      expect(() => readFileSync(`${repoRoot}/${d.aimsAt}`, "utf8")).not.toThrow();
    }
  });

  it("rejects an anchor that matches more than once", () => {
    expect(() =>
      applyDefectTyped("const a = 1;\nconst a = 1;\n", {
        id: "dup",
        file: "x.ts",
        find: "const a = 1;",
        replace: "const a = 2;",
      }),
    ).toThrow(/exactly once/);
  });

  it("rejects an anchor that matches nothing", () => {
    expect(() =>
      applyDefectTyped("const a = 1;\n", {
        id: "missing",
        file: "x.ts",
        find: "const z = 9;",
        replace: "const z = 8;",
      }),
    ).toThrow(/exactly once/);
  });

  it("applies a unique anchor", () => {
    const { mutated } = applyDefectTyped("const a = 1;\n", {
      id: "ok",
      file: "x.ts",
      find: "const a = 1;",
      replace: "const a = 2;",
    });
    expect(mutated).toBe("const a = 2;\n");
  });

  it("resolves every shipped anchor against live source", () => {
    // The check that keeps the corpus honest: a defect whose anchor has drifted
    // must fail here rather than silently report an escape at run time.
    const { defects } = loadCorpusTyped(repoRoot);
    for (const defect of defects) {
      const d = defect as { id: string; file: string; find: string; replace: string };
      const source = readFileSync(`${repoRoot}/${d.file}`, "utf8");
      expect(() => applyDefectTyped(source, d)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mutation-runner.test.ts`

Expected: FAIL — `Cannot find module '../scripts/mutation/corpus.mjs'`

- [ ] **Step 3: Write the corpus**

Create `defects/mutations.json`. Every anchor below was verified against live `main` at `f53a0c9`: each was applied, the suite was run, and each was observed to fail. The `aimsAt` values are the test files that actually caught them.

```json
{
  "defects": [
    {
      "id": "integration-gate-ignores-scope",
      "aimsAt": "tests/scope.test.ts",
      "why": "A scope violation must block integration. If the scopeReason override is dropped, a Work Unit that wrote outside its declared boundary reports ready, and the operator reads a green result while the boundary was crossed.",
      "file": "src/kernel/integration.ts",
      "find": "const blocker = options.scopeReason ?? blockingReason(execution, verification);",
      "replace": "const blocker = blockingReason(execution, verification);",
      "expected": "caught"
    },
    {
      "id": "repair-limit-never-reached",
      "aimsAt": "tests/repair.test.ts",
      "why": "Bounded repair is what stops a failing Work Unit retrying forever. Raising the default so the loop cannot escalate turns every deterministic failure into an unbounded one.",
      "file": "src/kernel/repair.ts",
      "find": "export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;",
      "replace": "export const DEFAULT_MAX_REPAIR_ATTEMPTS = 1000;",
      "expected": "caught"
    },
    {
      "id": "security-destructive-needs-no-sandbox",
      "aimsAt": "tests/security.test.ts",
      "why": "Higher-risk work requires a sandbox; this is the control that stops a destructive Work Unit quietly running in an ordinary worktree, where isolation means files and not privileges.",
      "file": "src/security/risk.ts",
      "find": "export function minimumIsolationFor(risk: RiskClass): IsolationLevel {\n  switch (risk) {\n    case \"destructive\":\n    case \"untrusted\":\n      return \"sandbox\";",
      "replace": "export function minimumIsolationFor(risk: RiskClass): IsolationLevel {\n  switch (risk) {\n    case \"destructive\":\n      return \"git_worktree\";\n    case \"untrusted\":\n      return \"sandbox\";",
      "expected": "caught"
    },
    {
      "id": "scope-undeclared-not-flagged",
      "aimsAt": "tests/scope.test.ts",
      "why": "A Work Unit that declares no paths gets no scope gate. Reporting that as in-scope makes an undeclared Work Unit look exactly like a narrowly-scoped one.",
      "file": "src/kernel/scope.ts",
      "find": "return { changed, outOfScope: [], undeclared: true };",
      "replace": "return { changed, outOfScope: [], undeclared: false };",
      "expected": "caught"
    },
    {
      "id": "verification-failure-reads-as-pass",
      "aimsAt": "tests/execution-slice.test.ts",
      "why": "Verification status is derived from the exit code. If a failing check is recorded as passing, the integration gate's central rule becomes unreachable and every Work Unit is ready.",
      "file": "src/adapters/verification/shell.ts",
      "find": "const status = result.exitCode === 0 ? \"passed\" : \"failed\";",
      "replace": "const status = \"passed\";",
      "expected": "caught"
    }
  ]
}
```

Note the security anchor is the **whole function signature**, not the bare `case "destructive":` line — the bare line appears five times in the file, and an ambiguous anchor is a corpus error. This was found by running the corpus, not by reading it.

- [ ] **Step 4: Write `corpus.mjs`**

Create `scripts/mutation/corpus.mjs`:

```javascript
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Corpus loading and anchor resolution.
 *
 * The single rule this module enforces: an anchor must match its target file
 * exactly once. An anchor matching zero times means the source moved and the
 * corpus is stale; matching several times means the defect is ambiguous. Both
 * are reported as corpus errors, and neither is ever reported as a defect that
 * escaped — that number means "the check missed it", and a defect that never
 * ran is not evidence of anything.
 */

export function loadCorpus(repoRoot) {
  const corpusPath = join(repoRoot, "defects", "mutations.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(corpusPath, "utf8"));
  } catch (error) {
    return {
      defects: [],
      errors: [
        {
          defectId: "<corpus>",
          file: corpusPath,
          message: `the corpus could not be read: ${error.message}`,
        },
      ],
    };
  }

  const defects = Array.isArray(parsed.defects) ? parsed.defects : [];
  const errors = [];
  const seen = new Set();

  for (const defect of defects) {
    for (const field of ["id", "aimsAt", "why", "file", "find", "replace", "expected"]) {
      if (typeof defect[field] !== "string" || defect[field].length === 0) {
        errors.push({
          defectId: defect.id ?? "<unnamed>",
          file: defect.file ?? corpusPath,
          message: `field '${field}' is missing or not a non-empty string`,
        });
      }
    }
    if (seen.has(defect.id)) {
      errors.push({
        defectId: defect.id,
        file: defect.file ?? corpusPath,
        message: "duplicate defect id",
      });
    }
    seen.add(defect.id);
  }

  return { defects, errors };
}

export function applyDefect(source, defect) {
  const occurrences = source.split(defect.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `anchor for defect '${defect.id}' matched ${occurrences} times in ${defect.file}; ` +
        `it must match exactly once`,
    );
  }
  return { mutated: source.replace(defect.find, defect.replace) };
}

/** Reads a target file and applies a defect, reporting rather than throwing on drift. */
export function mutateFile(repoRoot, defect) {
  const absolute = join(repoRoot, defect.file);
  const source = readFileSync(absolute, "utf8");
  return applyDefect(source, defect);
}
```

- [ ] **Step 5: Write `defects/README.md`**

```markdown
# Defect corpus

Five deliberate degradations of this repository's own controls, each paired with the check
that is supposed to notice it. The runner applies them one at a time and records which test
file caught each one.

## Why this exists

`docs/verification-and-merge-gates.md` states that the suite's non-vacuity was proven by
deliberately weakening the implementation and confirming the tests then failed. That was done
by hand, once. This corpus makes it re-checkable on every run.

The claim being defended: **a green `contract` run is evidence, and a check that cannot fail is
not a check.**

## Adding a defect

1. Choose a promise the module documents in prose.
2. Make the smallest change that breaks that promise. Do not damage the module beyond
   recognition — a defect that wrecks a file proves an assertion exists, not that the assertion
   guards the control.
3. Find the exact source text to replace, and confirm it appears **exactly once** in the file.
   Use the surrounding function signature where a bare line is ambiguous.
4. Record the test file that catches it in `aimsAt`. Confirm by running the suite.
5. Add the defect and raise `ratchet.json` in the same commit.

## Rules

- Anchors must match exactly once. Zero matches means the source moved — that is a corpus error,
  and it is reported as one rather than as a defect that escaped.
- A mutation that cannot be evaluated is never reported as an escape. An escape means the check
  missed it, and a defect that never ran is not evidence of anything.
- Never quote the test-suite size in this directory. `main` removed those numbers deliberately;
  `npm run verify` is the source of truth.

## Running

```
npm run mutations          # evaluate every defect
npm run mutations -- --defect repair-limit-never-reached   # one defect
```

A defect that is not caught is a finding, not a failure of the tool. Report it.
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/mutation-runner.test.ts`

Expected: PASS, 7 tests. This file grows by one describe block per task: 7 after
this task, 11 after Task 2, 16 after Task 3, 21 after Task 4.

- [ ] **Step 7: Verify the anchors resolve against real source**

Run: `npx vitest run tests/mutation-runner.test.ts -t "resolves every shipped anchor"`

Expected: PASS. If it fails, an anchor has drifted — fix the corpus, not the test.

- [ ] **Step 8: Commit**

```bash
git add defects/ scripts/mutation/corpus.mjs tests/mutation-runner.test.ts
git commit -m "Add the mutation corpus and its anchor validation

Five defects, each aimed at a promise a module documents in prose, each
naming the test that catches it. Every anchor was verified against live
main by applying it and running the suite; all five were observed to fail.

The security defect's anchor is the whole function signature rather than
the bare case label, which appears five times. That ambiguity was found by
running the corpus rather than by reading it.

Anchor resolution refuses anything that does not match exactly once. A
defect whose source line has moved is a corpus error, never a defect that
escaped, because an unevaluated mutation is not evidence the check missed
anything."
```

---

## Task 2: Scratch tree construction

Building an isolated copy to mutate. This is what makes working-tree immutability structural
rather than a cleanup handler.

**Files:**
- Create: `scripts/mutation/scratch.mjs`
- Modify: `tests/mutation-runner.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `createScratch(repoRoot) -> { path: string, cleanup: () => void }`
  - `assertRealNodeModules(path) -> void` — throws if `node_modules` is a symlink
  - `SKIP_DIRECTORIES` — the set not copied

- [ ] **Step 1: Write the failing tests**

Append to `tests/mutation-runner.test.ts`:

```ts
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScratch, assertRealNodeModules } from "../scripts/mutation/scratch.mjs";

const createScratchTyped = createScratch as unknown as (repoRoot: string) => {
  path: string;
  cleanup: () => void;
};
const assertRealTyped = assertRealNodeModules as unknown as (path: string) => void;

describe("scratch tree", () => {
  it("copies src and tests into the scratch tree", () => {
    const repoRoot = process.cwd();
    const scratch = createScratchTyped(repoRoot);
    try {
      expect(existsSync(join(scratch.path, "src", "kernel", "integration.ts"))).toBe(true);
      expect(existsSync(join(scratch.path, "tests"))).toBe(true);
      expect(existsSync(join(scratch.path, "package.json"))).toBe(true);
    } finally {
      scratch.cleanup();
    }
  });

  it("does not copy .git, node_modules, dist, or worktrees", () => {
    const repoRoot = process.cwd();
    const scratch = createScratchTyped(repoRoot);
    try {
      expect(existsSync(join(scratch.path, ".git"))).toBe(false);
      expect(existsSync(join(scratch.path, ".worktrees"))).toBe(false);
      expect(existsSync(join(scratch.path, "dist"))).toBe(false);
    } finally {
      scratch.cleanup();
    }
  });

  it("refuses a scratch tree whose node_modules is a symlink", () => {
    // Observed during planning: a symlinked node_modules makes
    // `git check-ignore` fail with "beyond a symbolic link", which surfaced
    // as a spurious repo-hygiene failure that looked like a real defect.
    const base = mkdtempSync(join(tmpdir(), "scratch-symlink-"));
    try {
      const target = join(base, "target");
      mkdirSync(target);
      symlinkSync(base, join(target, "node_modules"));
      expect(() => assertRealTyped(target)).toThrow(/symlink/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("cleanup removes the scratch tree", () => {
    const scratch = createScratchTyped(process.cwd());
    const path = scratch.path;
    expect(existsSync(path)).toBe(true);
    scratch.cleanup();
    expect(existsSync(path)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mutation-runner.test.ts`

Expected: FAIL — `Cannot find module '../scripts/mutation/scratch.mjs'`

- [ ] **Step 3: Implement `scratch.mjs`**

Create `scripts/mutation/scratch.mjs`:

```javascript
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Scratch tree construction.
 *
 * The working tree is never written. Every mutation is applied to a throwaway
 * copy, so a killed runner can only ever damage a directory the OS reclaims.
 * That is the whole reason for this file: the obvious design — mutate in place,
 * restore in a `finally` — fails on SIGKILL, which is exactly what happens when
 * a CI job times out.
 */

/** Copied from the repository root. Everything else is skipped. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  ".worktrees",
  ".tmp-test",
  ".factory",
]);

/**
 * `node_modules` is symlinked rather than copied, because a copy is hundreds of
 * megabytes and the suite does not need a writable one. The consequence is that
 * `git check-ignore` fails inside the scratch tree with "beyond a symbolic
 * link", which makes tests/repo-hygiene.test.ts fail for a reason that has
 * nothing to do with the defect under test.
 *
 * So: symlink, run, then report a corpus error rather than a false escape.
 */
export function assertRealNodeModules(scratchPath) {
  const modules = join(scratchPath, "node_modules");
  if (!existsSync(modules)) return;
  if (lstatSync(modules).isSymbolicLink()) {
    throw new Error(
      "the scratch tree's node_modules is a symlink; git check-ignore cannot " +
        "resolve paths beyond one, which would surface as a spurious " +
        "repo-hygiene failure rather than a result about the defect",
    );
  }
}

export function createScratch(repoRoot) {
  const path = mkdtempSync(join(tmpdir(), "factory-mutation-"));

  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    cpSync(join(repoRoot, entry.name), join(path, entry.name), {
      recursive: true,
      dereference: false,
    });
  }

  // Symlink for speed; assertRealNodeModules reports the consequence honestly
  // rather than hiding it.
  const realModules = join(repoRoot, "node_modules");
  if (existsSync(realModules)) {
    symlinkSync(realModules, join(path, "node_modules"));
  }

  let cleaned = false;
  return {
    path,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(path, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mutation-runner.test.ts`

Expected: PASS, 11 tests total in this file.

- [ ] **Step 5: Verify the working tree is untouched**

```bash
git status --short
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add scripts/mutation/scratch.mjs tests/mutation-runner.test.ts
git commit -m "Build mutations in a scratch tree, never in the working tree

Mutate-in-place with a finally-restore is the obvious design and it fails
on SIGKILL, which is what a timed-out CI job sends. Copying the repository
per defect costs seconds and makes working-tree immutability structural
rather than a cleanup handler that runs when it feels like it.

node_modules is symlinked for speed, which makes git check-ignore fail
inside the scratch tree with 'beyond a symbolic link'. That failure was
observed during planning and looked like a real defect. Detected and
reported as a corpus error rather than silently misattributed."
```

---

## Task 3: Evaluate one defect

The orchestration: apply, run, attribute, report.

**Files:**
- Create: `scripts/mutation/evaluate.mjs`
- Modify: `tests/mutation-runner.test.ts`

**Interfaces:**
- Consumes: `loadCorpus(repoRoot)`, `mutateFile(repoRoot, defect)` from Task 1; `createScratch(repoRoot)`, `assertRealNodeModules(path)` from Task 2
- Produces:
  - `evaluateDefect(repoRoot, defect) -> DefectOutcome`
  - `DefectOutcome = { id, outcome: "caught" | "escaped" | "corpus-error", caughtBy: string[], reason: string, durationMs: number }`
  - `extractFailingTests(vitestOutput) -> string[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mutation-runner.test.ts`:

```ts
import { evaluateDefect, extractFailingTests } from "../scripts/mutation/evaluate.mjs";

const evaluateTyped = evaluateDefect as unknown as (
  repoRoot: string,
  defect: unknown,
) => { id: string; outcome: string; caughtBy: string[]; reason: string; durationMs: number };
const extractTyped = extractFailingTests as unknown as (output: string) => string[];

describe("defect evaluation", () => {
  it("extracts failing test files from vitest output", () => {
    const output = [
      " FAIL  tests/scope.test.ts > reports no gate when paths are undeclared",
      " FAIL  tests/repair.test.ts > escalates at the limit",
      " Test Files  1 failed | 1 passed (2)",
    ].join("\n");
    expect(extractTyped(output).sort()).toEqual(["tests/repair.test.ts", "tests/scope.test.ts"]);
  });

  it("returns an empty list when nothing failed", () => {
    expect(extractTyped(" Test Files  22 passed (22)")).toEqual([]);
  });

  it("reports an escaped defect when the suite passes on a mutated tree", async () => {
    // A defect that changes nothing observable: the suite passes, so the
    // control has no test watching it.
    const outcome = evaluateTyped(process.cwd(), {
      id: "no-op",
      aimsAt: "tests/mutation-runner.test.ts",
      why: "a defect that changes nothing, to prove escape detection works",
      file: "src/kernel/repair.ts",
      find: "export type RepairLoopStatus = \"verified\" | \"escalated\";",
      replace: "export type RepairLoopStatus = \"verified\" | \"escalated\" | \"still_worse\";",
      expected: "caught",
    });
    expect(outcome.outcome).toBe("escaped");
    expect(outcome.caughtBy).toEqual([]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  }, 180000);

  it("reports a corpus error, never an escape, when the anchor has drifted", async () => {
    const outcome = evaluateTyped(process.cwd(), {
      id: "drifted",
      aimsAt: "tests/mutation-runner.test.ts",
      why: "an anchor that no longer exists must not be reported as an escape",
      file: "src/kernel/repair.ts",
      find: "this text is not in the file",
      replace: "anything",
      expected: "caught",
    });
    expect(outcome.outcome).toBe("corpus-error");
    expect(outcome.reason).toMatch(/exactly once/);
  }, 30000);

  it("catches a defect the suite is known to catch", async () => {
    const outcome = evaluateTyped(process.cwd(), {
      id: "repair-limit-never-reached",
      aimsAt: "tests/repair.test.ts",
      why: "bounded repair is what stops an unbounded retry",
      file: "src/kernel/repair.ts",
      find: "export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;",
      replace: "export const DEFAULT_MAX_REPAIR_ATTEMPTS = 1000;",
      expected: "caught",
    });
    expect(outcome.outcome).toBe("caught");
    expect(outcome.caughtBy.length).toBeGreaterThan(0);
  }, 180000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mutation-runner.test.ts`

Expected: FAIL — `Cannot find module '../scripts/mutation/evaluate.mjs'`

- [ ] **Step 3: Implement `evaluate.mjs`**

Create `scripts/mutation/evaluate.mjs`:

```javascript
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutateFile } from "./corpus.mjs";
import { createScratch, assertRealNodeModules } from "./scratch.mjs";

/**
 * Evaluating one defect.
 *
 * Three outcomes, and the distinction between them is the point of the tool:
 *
 *   caught       the suite failed. Some check noticed.
 *   escaped      the suite passed on a mutated tree. Nothing noticed, which is
 *                a finding about the suite.
 *   corpus-error the defect could not be evaluated at all — a drifted anchor, a
 *                build that never ran. Never reported as an escape, because an
 *                escape means "the check missed it" and a defect that never ran
 *                is not evidence of anything.
 */

const RUN_TIMEOUT_MS = 300000;

export function extractFailingTests(output) {
  const found = new Set();
  for (const line of output.split("\n")) {
    const match = /^ FAIL\s+(tests\/[\w.-]+\.test\.ts)\b/.exec(line);
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

function runSuite(cwd) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["vitest", "run", "--reporter=dot"], {
      cwd,
      env: { ...process.env, CI: "1" },
    });

    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ output, timedOut: true });
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output, code, timedOut: false });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ output, spawnError: error, timedOut: false });
    });
  });
}

export async function evaluateDefect(repoRoot, defect) {
  const started = Date.now();
  const finish = (outcome, caughtBy, reason) => ({
    id: defect.id,
    outcome,
    caughtBy,
    reason,
    durationMs: Date.now() - started,
  });

  // Validate before doing anything expensive, and before building a scratch tree.
  let mutatedSource;
  try {
    ({ mutated: mutatedSource } = mutateFile(repoRoot, defect));
  } catch (error) {
    return finish("corpus-error", [], error.message);
  }

  let scratch;
  try {
    scratch = createScratch(repoRoot);
  } catch (error) {
    return finish("corpus-error", [], `the scratch tree could not be built: ${error.message}`);
  }

  try {
    try {
      assertRealNodeModules(scratch.path);
    } catch (error) {
      return finish("corpus-error", [], error.message);
    }

    writeFileSync(join(scratch.path, defect.file), mutatedSource);

    const { output, code, timedOut, spawnError } = await runSuite(scratch.path);

    if (spawnError) {
      return finish("corpus-error", [], `the suite could not start: ${spawnError.message}`);
    }
    if (timedOut) {
      // A timeout is not evidence either way. Report it as unevaluated.
      return finish("corpus-error", [], `the suite did not finish within ${RUN_TIMEOUT_MS}ms`);
    }

    const caughtBy = extractFailingTests(output);

    if (code !== 0) {
      // The suite failed. If Vitest could not collect — a syntax error in the
      // mutated file, say — that is still a catch: the mutation could not pass.
      // Distinguish it so the report does not claim a test noticed when nothing
      // ran to notice.
      const collectedNothing = /Failed to (load|parse)|No test files found|error TS\d+/.test(output);
      return finish("caught", caughtBy, collectedNothing
        ? "the mutated tree could not be built or collected, so the suite could not pass"
        : `caught by ${caughtBy.length} test file(s)`);
    }

    return finish("escaped", [], "the suite passed on a mutated tree");
  } finally {
    scratch.cleanup();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mutation-runner.test.ts`

Expected: PASS, 16 tests total in this file. The two evaluation tests spawn a real
Vitest run each; allow up to 6 minutes.

- [ ] **Step 5: Verify the working tree is still untouched**

```bash
git status --short
```

Expected: no output. If `src/kernel/repair.ts` shows as modified, the copy-based design failed — stop and fix that before continuing.

- [ ] **Step 6: Commit**

```bash
git add scripts/mutation/evaluate.mjs tests/mutation-runner.test.ts
git commit -m "Evaluate one defect and attribute which check caught it

Three outcomes, kept distinct on purpose. caught means a check noticed.
escaped means the suite passed on a mutated tree, which is a finding about
the suite. corpus-error means the defect could not be evaluated at all —
and that is never reported as an escape, because an escape claims a check
missed something, and a defect that never ran is not evidence.

A timeout is corpus-error rather than a result, for the same reason.

The tests cover the escape path and the drifted-anchor path with real
defects, because those are the two paths that make a number untrustworthy."
```

---

## Task 4: The ratchet

The guard against the guarantee being traded away quietly.

**Files:**
- Create: `scripts/mutation/ratchet.mjs`
- Create: `defects/ratchet.json`
- Modify: `tests/mutation-runner.test.ts`

**Interfaces:**
- Consumes: `DefectOutcome[]` from Task 3
- Produces:
  - `checkRatchet(ratchet, outcomes) -> { ok: boolean, problems: string[] }`
  - Ratchet shape: `{ defects: number, allCaught: true }`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mutation-runner.test.ts`:

```ts
import { readFileSync as readSync } from "node:fs";
import { checkRatchet } from "../scripts/mutation/ratchet.mjs";

const checkRatchetTyped = checkRatchet as unknown as (
  ratchet: { defects: number },
  outcomes: { id: string; outcome: string }[],
) => { ok: boolean; problems: string[] };

describe("ratchet", () => {
  const caught = (id: string) => ({ id, outcome: "caught" });

  it("passes when every defect is caught and none were removed", () => {
    const result = checkRatchetTyped(
      { defects: 2 },
      [caught("a"), caught("b")],
    );
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("fails when a defect escapes", () => {
    const result = checkRatchetTyped({ defects: 1 }, [
      { id: "a", outcome: "escaped" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/escaped/);
  });

  it("fails when the corpus has shrunk", () => {
    const result = checkRatchetTyped({ defects: 5 }, [caught("a")]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/shrunk|fewer/i);
  });

  it("fails when a defect could not be evaluated", () => {
    const result = checkRatchetTyped({ defects: 1 }, [
      { id: "a", outcome: "corpus-error" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("records a corpus at least as large as the shipped ratchet", () => {
    const ratchet = JSON.parse(readSync("defects/ratchet.json", "utf8"));
    expect(ratchet.defects).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mutation-runner.test.ts`

Expected: FAIL — `Cannot find module '../scripts/mutation/ratchet.mjs'`

- [ ] **Step 3: Implement `ratchet.mjs`**

Create `scripts/mutation/ratchet.mjs`:

```javascript
/**
 * The ratchet.
 *
 * A number that can go down is a preference. This one exists so that removing a
 * defect to make the rung pass, or letting one go uncaught, is a visible failure
 * rather than a quieter gate.
 */

export function checkRatchet(ratchet, outcomes) {
  const problems = [];

  if (outcomes.length < ratchet.defects) {
    problems.push(
      `the corpus shrank: ${outcomes.length} defects evaluated, ratchet requires ${ratchet.defects}`,
    );
  }

  for (const outcome of outcomes) {
    if (outcome.outcome === "escaped") {
      problems.push(`'${outcome.id}' escaped: the suite passed on a mutated tree`);
    }
    if (outcome.outcome === "corpus-error") {
      problems.push(`'${outcome.id}' could not be evaluated; that is not a result`);
    }
  }

  return { ok: problems.length === 0, problems };
}
```

Create `defects/ratchet.json`:

```json
{
  "defects": 5
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/mutation-runner.test.ts`

Expected: PASS, 21 tests total in this file.

- [ ] **Step 5: Commit**

```bash
git add scripts/mutation/ratchet.mjs defects/ratchet.json tests/mutation-runner.test.ts
git commit -m "Ratchet the corpus so the guarantee cannot be traded away quietly

Fails when the corpus shrinks, when a defect escapes, or when one could
not be evaluated. Without this, deleting a defect row is the cheapest way
to get a green run, and the rung would be measuring less over time while
looking like it was measuring more."
```

---

## Task 5: CLI entry point and npm script

The command a person or CI actually runs.

**Files:**
- Create: `scripts/mutation/run.mjs`
- Modify: `package.json`
- Modify: `tests/mutation-runner.test.ts`

**Interfaces:**
- Consumes: `loadCorpus`, `applyDefect` (Task 1), `evaluateDefect` (Task 3), `checkRatchet` (Task 4)
- Produces: exit code 0 when every defect is caught; 1 when any escapes or cannot be evaluated; 2 for a usage error

- [ ] **Step 1: Write the failing test**

Append to `tests/mutation-runner.test.ts`:

```ts
import { spawnSync } from "node:child_process";

describe("mutation runner CLI", () => {
  it("reports every defect caught and exits 0", () => {
    const result = spawnSync("node", ["scripts/mutation/run.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 900000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toMatch(/5 defects/);
    expect(output).toMatch(/caught/);
    expect(output).not.toMatch(/escaped/);
    expect(result.status).toBe(0);
  }, 900000);
}, );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mutation-runner.test.ts -t "reports every defect caught"`

Expected: FAIL — `scripts/mutation/run.mjs` does not exist.

- [ ] **Step 3: Implement `run.mjs`**

Create `scripts/mutation/run.mjs`:

```javascript
#!/usr/bin/env node
/**
 * `npm run mutations`
 *
 * Evaluates every defect in `defects/mutations.json` and reports which check
 * caught each one. Exits non-zero when a defect escapes or cannot be evaluated,
 * so the rung can gate a build.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "./corpus.mjs";
import { evaluateDefect } from "./evaluate.mjs";
import { checkRatchet } from "./ratchet.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const only = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--defect") {
      const value = argv[i + 1];
      if (!value) {
        process.stderr.write("usage: npm run mutations -- [--defect <id>]\n");
        process.exit(2);
      }
      only.push(value);
      i += 1;
    }
  }
  return { only };
}

async function main() {
  const { only } = parseArgs(process.argv.slice(2));
  const { defects, errors } = loadCorpus(repoRoot);

  if (errors.length > 0) {
    process.stderr.write("the corpus is not valid:\n");
    for (const error of errors) {
      process.stderr.write(`  [${error.defectId}] ${error.file}: ${error.message}\n`);
    }
    process.exit(1);
  }

  const selected = only.length === 0
    ? defects
    : defects.filter((defect) => only.includes(defect.id));

  if (selected.length === 0) {
    process.stderr.write(`no defect matched ${only.join(", ")}\n`);
    process.exit(2);
  }

  process.stdout.write(`evaluating ${selected.length} defects\n\n`);

  const outcomes = [];
  for (const defect of selected) {
    process.stdout.write(`  ${defect.id} ... `);
    const outcome = await evaluateDefect(repoRoot, defect);
    outcomes.push(outcome);

    if (outcome.outcome === "caught") {
      const detail = outcome.caughtBy.length > 0 ? outcome.caughtBy.join(", ") : "build/collect";
      process.stdout.write(`caught by ${detail} (${outcome.durationMs}ms)\n`);
    } else if (outcome.outcome === "escaped") {
      process.stdout.write(`ESCAPED (${outcome.durationMs}ms)\n`);
    } else {
      process.stdout.write(`CORPUS ERROR (${outcome.durationMs}ms)\n`);
      process.stdout.write(`      ${outcome.reason}\n`);
    }
  }

  // The ratchet guards the whole corpus, so it is only meaningful when every
  // defect was evaluated. A filtered run reports its own results instead.
  let ok = true;
  if (only.length === 0) {
    const ratchet = JSON.parse(readFileSync(join(repoRoot, "defects", "ratchet.json"), "utf8"));
    const verdict = checkRatchet(ratchet, outcomes);
    ok = verdict.ok;
    if (!ok) {
      process.stdout.write("\nratchet:\n");
      for (const problem of verdict.problems) {
        process.stdout.write(`  - ${problem}\n`);
      }
    }
  } else {
    ok = outcomes.every((outcome) => outcome.outcome === "caught");
  }

  const escaped = outcomes.filter((o) => o.outcome === "escaped").length;
  const errored = outcomes.filter((o) => o.outcome === "corpus-error").length;
  const caught = outcomes.length - escaped - errored;

  process.stdout.write(
    `\n${caught} caught, ${escaped} escaped, ${errored} unevaluated, ` +
      `of ${outcomes.length} defects\n`,
  );

  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`the mutation runner failed: ${error.stack}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Add the npm script**

In `package.json`, add to `scripts` after `verify`:

```json
"mutations": "node scripts/mutation/run.mjs"
```

- [ ] **Step 5: Run the CLI**

Run: `npm run mutations`

Expected:

```
evaluating 5 defects

  integration-gate-ignores-scope ... caught by tests/scope.test.ts (...)
  repair-limit-never-reached ... caught by tests/repair.test.ts (...)
  security-destructive-needs-no-sandbox ... caught by tests/security.test.ts (...)
  scope-undeclared-not-flagged ... caught by tests/scope.test.ts (...)
  verification-failure-reads-as-pass ... caught by tests/execution-slice.test.ts (...)

5 caught, 0 escaped, 0 unevaluated, of 5 defects
```

Exit code 0. If any defect reports `escaped`, that is a **finding** — stop and report it. Do not edit the corpus to make it go away, and do not weaken the test.

- [ ] **Step 6: Run the full suite**

Run: `npm test`

Expected: PASS. Note that `tests/mutation-runner.test.ts` now includes slow subprocess tests, so the suite takes longer than before. If it exceeds the default budget, raise `testTimeout` in `vitest.config.ts` and say why in the comment there — it already documents that several tests spawn real processes.

- [ ] **Step 7: Confirm no dependency drift**

```bash
git diff --exit-code package-lock.json
```

Expected: no output. Any diff means a dependency crept in, which the global constraints forbid.

- [ ] **Step 8: Commit**

```bash
git add scripts/mutation/run.mjs package.json tests/mutation-runner.test.ts
git commit -m "Add npm run mutations: the command a person or CI actually runs

Reports which check caught each defect, and exits non-zero when one escapes
or cannot be evaluated so the rung can gate a build. --defect <id> narrows
a run to one defect; the ratchet is skipped there, because it guards the
whole corpus and a filtered run would compare five results against a
five-defect floor."
```

---

## Task 6: Wire the CI rung

**Files:**
- Create: `.github/workflows/mutation.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `npm run mutations` from Task 5
- Produces: a `mutation` job that reports but does not gate

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/mutation.yml`:

```yaml
# The mutation rung.
#
# Separate from `contract` on purpose: a corpus problem and a real regression
# need different responses, and a reader should be able to tell them apart
# without reading logs.
name: Mutation

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  mutation:
    runs-on: ubuntu-latest
    # Non-blocking while the corpus is calibrated. A red here means either a
    # control lost its test (a real finding) or a defect's anchor drifted (a
    # corpus problem). Those need different responses, and this job cannot yet
    # tell you which. Making this blocking is a separate decision that needs a
    # human — see docs/verification-and-merge-gates.md.
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install dependencies
        run: npm ci
      - name: Evaluate the defect corpus
        run: npm run mutations
```

- [ ] **Step 2: Verify the workflow parses**

Run: `node --input-type=module -e "
import { readFileSync } from 'node:fs';
const text = readFileSync('.github/workflows/mutation.yml', 'utf8');
if (!text.includes('continue-on-error: true')) throw new Error('rung must be non-blocking initially');
if (!text.includes('npm run mutations')) throw new Error('workflow must run the rung');
console.log('mutation workflow declares the rung and its non-blocking intent');
"

Expected: the success line.

- [ ] **Step 3: Confirm `contract` is untouched**

Run: `git diff --exit-code .github/workflows/ci.yml`

Expected: no output. The `contract` job is the enforcement gate; this work must not touch it.

- [ ] **Step 4: Document the rung in the gates policy**

Append to `docs/verification-and-merge-gates.md`, under "The gate is a floor, not a ceiling":

```markdown
### The mutation rung

`docs/verification-and-merge-gates.md` states that the suite's non-vacuity was proven by
deliberately weakening the implementation and confirming the tests then failed. `npm run mutations`
re-checks that claim on every run: `defects/mutations.json` holds five named degradations of this
repository's own controls, each naming the check meant to catch it, and
`scripts/mutation/run.mjs` applies them one at a time in a scratch tree and records which test
file failed.

It runs as a **separate, non-blocking** `mutation` job. Making it blocking requires the settings
in the previous section to hold for it as well, and that is a decision for a person, not a default.

Two properties are deliberate. The working tree is never written — mutations are applied to a
throwaway copy — so an interrupted run cannot leave a degraded `src/` behind, which is the failure
mode that makes an in-place mutation unsafe in CI. And a mutation that cannot be evaluated is
reported as a corpus error, never as an escape: an escape claims a check missed something, and a
defect that never ran is not evidence.
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 6: Verify no dependency drift**

```bash
git diff --exit-code package.json package-lock.json
```

Expected: no output beyond the `"mutations"` script line added in Task 5.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/mutation.yml docs/verification-and-merge-gates.md
git commit -m "Run the mutation rung in CI, non-blocking

Separate job from contract, so a corpus problem is distinguishable from a
real regression without reading logs. Non-blocking because the rung cannot
yet tell those two apart on its own, and the first time it goes red that
ambiguity should not be resolved by a maintainer guessing.

Deliberately does not touch the contract job, which is the enforcement
gate."
```

---

## Task 7: Record the runner's own limits

The tool's blind spots, written where a future maintainer will find them.

**Files:**
- Modify: `defects/README.md`
- Modify: `docs/verification-and-merge-gates.md`

**Interfaces:**
- Consumes: everything above
- Produces: no code

- [ ] **Step 1: Append the limits section to `defects/README.md`**

```markdown
## What this does not prove

**It only finds defects someone thought of.** This is the corpus's real limit and it is not
measurable from inside the tool. Five defects cover five controls; the kernel has more. A mutation
score would put a number here, and the number would be as misleading as the three suite sizes this
project has already published.

**It proves the suite can fail, not that it is correct.** A defect caught by a test that asserts
something adjacent counts the same as one caught by the test that encodes the control. That is why
each defect names the check it aims at, so the attribution is reviewable rather than trusted.

**It does not cover the composition.** `checkScope` is tested directly, and the
pipeline → scopeReason → integration path that uses its result is only exercised indirectly. The
`integration-gate-ignores-scope` defect is caught, but by `tests/scope.test.ts`, which tests the
scoper rather than the wiring. The wiring is the thing that failed in dogfooding. Adding a test
that asserts a scope violation reaches `integration.blocked` is the honest next step, and it is
deliberately not folded in here.
```

- [ ] **Step 2: Record the same gap in the gates policy**

Append to `docs/verification-and-merge-gates.md`:

```markdown
The scope-control composition — a violation detected by `checkScope`, passed through the pipeline
as `scopeReason`, and read by `buildIntegrationResult` — has no test that asserts the whole path.
The two halves are tested separately and the wire between them is not. This is the same
absence-of-a-caller shape as the Linear intake gap above, one level down, and it is recorded rather
than left for a reader to discover.
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add defects/README.md docs/verification-and-merge-gates.md
git commit -m "Record what the mutation corpus does not prove

It finds only defects someone thought of, and that number is not measurable
from inside the tool. It proves the suite can fail, not that it is correct —
which is why each defect names its intended catcher.

Also records a real gap found while building this: the scope-control
composition has no test asserting the whole path, only its two halves. The
integration-gate defect is caught by the test for the scoper, not the test
for the wiring, and the wiring is what failed in dogfooding. Same
absence-of-a-caller shape as the Linear intake gap, one level down."
```

---

## Out of Scope

Recorded so it is not rediscovered as an omission:

- **Mutating a target project.** Proving the verification adapter catches defects in the product,
  not the factory. Needs a fixture application and per-check attribution. The more valuable end
  state; deferred because a corpus that judges the factory must be trustworthy before it judges
  anything else.
- **An automatic mutation engine.** Would be the first dependency in the project, against a
  documented invariant. See the spec's rejected-approaches section.
- **`docs/incidents.md`.** Neither project can manufacture one. It begins when this factory runs
  unattended; before then the honest file is absent, with its reason.
