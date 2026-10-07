import { describe, expect, it } from "vitest";
import { spawn, execFile as execFileCb } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyDefect, CorpusError, loadCorpus, mutateFile } from "../scripts/mutation/corpus.mjs";
import { assertRealNodeModules, createScratch } from "../scripts/mutation/scratch.mjs";
import {
  evaluateDefect,
  extractFailingTests,
  SUITE_EXCLUDE,
} from "../scripts/mutation/evaluate.mjs";

const execFileAsync = promisify(execFileCb);

/**
 * Both runner modules are plain ESM, so their shapes are declared alongside them
 * in `corpus.d.mts` and `scratch.d.mts` rather than asserted with casts here. A
 * `@ts-expect-error` on the import line cannot suppress TS7016 — the error is
 * raised by the import itself, where no cast can reach it — so the declaration
 * files are what make these imports type-check at all.
 */
type CorpusErrorShape = { defectId: string; file: string; message: string };

/**
 * Fixtures live in the OS temp directory, never in the repository. A test that
 * built its fixtures under the working tree would be writing to the tree it is
 * meant to be validating.
 */
function populatedRoot(defects: unknown[] = [validDefect()]): string {
  const root = mkdtempSync(join(tmpdir(), "corpus-fixture-"));
  mkdirSync(join(root, "defects"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests"), { recursive: true });
  writeFileSync(join(root, "defects", "mutations.json"), JSON.stringify({ defects }));
  writeFileSync(join(root, "src", "sample.ts"), "const a = 1;\n");
  writeFileSync(join(root, "tests", "sample.test.ts"), "it('sample', () => {});\n");
  return root;
}

/** Writes a corpus file verbatim, for the shapes JSON.stringify cannot express. */
function rawRoot(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "corpus-fixture-"));
  mkdirSync(join(root, "defects"), { recursive: true });
  writeFileSync(join(root, "defects", "mutations.json"), contents);
  return root;
}

function validDefect(overrides: Record<string, unknown> = {}) {
  return {
    id: "ok",
    aimsAt: "tests/sample.test.ts",
    why: "a reason long enough to satisfy the corpus field rule",
    file: "src/sample.ts",
    find: "const a = 1;",
    replace: "const a = 2;",
    expected: "caught",
    ...overrides,
  };
}

describe("mutation corpus", () => {
  const repoRoot = process.cwd();

  it("loads five defects from the shipped corpus", () => {
    const { defects } = loadCorpus(repoRoot);
    expect(Array.isArray(defects)).toBe(true);
    expect(defects.length).toBe(5);
  });

  it("gives every defect an id, an aim, a reason, and a file that exists", () => {
    const { defects } = loadCorpus(repoRoot);
    for (const defect of defects) {
      const d = defect as { id: string; aimsAt: string; why: string; file: string };
      expect(typeof d.id).toBe("string");
      expect(d.why.length).toBeGreaterThan(20);
      expect(d.aimsAt).toMatch(/^tests\/.+\.test\.ts$/);
      expect(() => readFileSync(`${repoRoot}/${d.file}`, "utf8")).not.toThrow();
    }
  });

  it("names a test file that actually exists for every defect", () => {
    const { defects } = loadCorpus(repoRoot);
    for (const defect of defects) {
      const d = defect as { aimsAt: string };
      expect(() => readFileSync(`${repoRoot}/${d.aimsAt}`, "utf8")).not.toThrow();
    }
  });

  it("rejects an anchor that matches more than once", () => {
    expect(() =>
      applyDefect("const a = 1;\nconst a = 1;\n", {
        id: "dup",
        file: "x.ts",
        find: "const a = 1;",
        replace: "const a = 2;",
      }),
    ).toThrow(/exactly once/);
  });

  it("rejects an anchor that matches nothing", () => {
    expect(() =>
      applyDefect("const a = 1;\n", {
        id: "missing",
        file: "x.ts",
        find: "const z = 9;",
        replace: "const z = 8;",
      }),
    ).toThrow(/exactly once/);
  });

  it("applies a unique anchor", () => {
    const { mutated } = applyDefect("const a = 1;\n", {
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
    const { defects } = loadCorpus(repoRoot);
    for (const defect of defects) {
      const d = defect as { id: string; file: string; find: string; replace: string };
      const source = readFileSync(`${repoRoot}/${d.file}`, "utf8");
      expect(() => applyDefect(source, d)).not.toThrow();
    }
  });
});

describe("mutation corpus validation", () => {
  /**
   * The assertion this tool exists to make about itself. A loader that reports a
   * malformed corpus as clean would give a mutation run over nothing a clean exit,
   * so "no errors" on the shipped corpus is checked against the module, not only
   * inferred from tests that pass.
   */
  it("loads the shipped corpus with no corpus errors", () => {
    const { defects, errors } = loadCorpus(process.cwd());
    expect(errors).toEqual([]);
    expect(defects.length).toBeGreaterThan(0);
  });

  it("reports no errors for a well-formed corpus", () => {
    // Guards the validator against crying wolf: if every shape errored, the
    // checks above would prove nothing.
    const { defects, errors } = loadCorpus(populatedRoot());
    expect(errors).toEqual([]);
    expect(defects.length).toBe(1);
  });
});

describe("corpus errors: shape of the corpus itself", () => {
  it("reports an unreadable corpus rather than throwing", () => {
    const { defects, errors } = loadCorpus(rawRoot("{ not json"));
    expect(defects).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/could not be read/);
  });

  it("reports a missing corpus file rather than throwing", () => {
    const { errors } = loadCorpus(mkdtempSync(join(tmpdir(), "corpus-empty-")));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/could not be read/);
  });

  it("reports a corpus with no defects key", () => {
    // I-1: this used to load as zero defects and no error, which is a clean run
    // over nothing. A renamed or truncated key must be loud.
    const { defects, errors } = loadCorpus(rawRoot("{}"));
    expect(defects).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/defects/);
  });

  it("reports a defects key that is not an array", () => {
    for (const body of ['{"defects":{}}', '{"defects":"nope"}', '{"defects":5}']) {
      const { defects, errors } = loadCorpus(rawRoot(body));
      expect(defects).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/defects/);
    }
  });

  it("reports a corpus that is not a JSON object at all", () => {
    // A top-level array or scalar is the same vacuous green as a missing key:
    // it would otherwise yield zero defects and a clean exit.
    for (const body of ["[]", '"nope"', "5", "null"]) {
      const { defects, errors } = loadCorpus(rawRoot(body));
      expect(defects).toEqual([]);
      expect(errors).toHaveLength(1);
    }
  });

  it("accepts an empty defects array without calling it an error", () => {
    // An empty corpus is a real state to report, not a malformed one. Silently
    // treating it as an error would train an operator to ignore the error list.
    const { defects, errors } = loadCorpus(rawRoot('{"defects":[]}'));
    expect(defects).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("corpus errors: individual defects", () => {
  it("reports a null entry without throwing, and does not hide the rest", () => {
    // I-4: this used to throw a TypeError out of the loader, killing the run.
    const { defects, errors } = loadCorpus(
      populatedRoot([null, validDefect({ id: "after-the-null" })]),
    );
    expect(defects).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/not an object/);
  });

  it("reports non-object entries of every shape", () => {
    for (const entry of [null, 7, "a string", true, ["an", "array"]]) {
      const { errors } = loadCorpus(populatedRoot([entry]));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/not an object/);
    }
  });

  it("reports a missing required field", () => {
    const defect = validDefect();
    delete (defect as Record<string, unknown>).why;
    const { errors } = loadCorpus(populatedRoot([defect]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/'why'/);
  });

  it("reports an empty required field", () => {
    const { errors } = loadCorpus(populatedRoot([validDefect({ why: "" })]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/'why'/);
  });

  it("reports a duplicate defect id", () => {
    const { errors } = loadCorpus(
      populatedRoot([validDefect({ id: "same" }), validDefect({ id: "same" })]),
    );
    expect(errors.some((e) => /duplicate defect id/.test(e.message))).toBe(true);
  });

  it("reports a target file that does not exist", () => {
    const { errors } = loadCorpus(
      populatedRoot([validDefect({ file: "src/absent.ts" })]),
    );
    expect(errors.some((e) => /target file/.test(e.message))).toBe(true);
  });

  it("reports an anchor that matches nothing in a real file", () => {
    const { errors } = loadCorpus(
      populatedRoot([validDefect({ find: "const gone = 0;" })]),
    );
    expect(errors.some((e) => /matched 0 times/.test(e.message))).toBe(true);
  });

  it("reports an anchor that matches more than once in a real file", () => {
    const root = populatedRoot([validDefect({ find: "a" })]);
    writeFileSync(join(root, "src", "sample.ts"), "const a = 1; // a\n");
    const { errors } = loadCorpus(root);
    expect(errors.some((e) => /matched 2 times/.test(e.message))).toBe(true);
  });

  it("reports an aimsAt that names no test file", () => {
    const { errors } = loadCorpus(
      populatedRoot([validDefect({ aimsAt: "tests/absent.test.ts" })]),
    );
    expect(errors.some((e) => /aims at no test file/.test(e.message))).toBe(true);
  });

  it("rejects an expected value outside the known set", () => {
    const { errors } = loadCorpus(populatedRoot([validDefect({ expected: "banana" })]));
    expect(errors.some((e) => /expected/.test(e.message))).toBe(true);
  });

  it("accepts every allowed expected value", () => {
    for (const expected of ["caught", "escaped"]) {
      const { errors } = loadCorpus(populatedRoot([validDefect({ expected })]));
      expect(errors).toEqual([]);
    }
  });

  it("does not resolve a file or an anchor it was already told is malformed", () => {
    // A missing `file` or `find` is reported once, as a shape error, rather than
    // as a pile of follow-on complaints about a value that does not exist.
    const { errors } = loadCorpus(populatedRoot([validDefect({ file: undefined, find: undefined })]));
    const messages = errors.map((e) => e.message);
    expect(messages.filter((m) => /'file'/.test(m))).toHaveLength(1);
    expect(messages.filter((m) => /'find'/.test(m))).toHaveLength(1);
    expect(messages.some((m) => /target file|matched \d+ times/.test(m))).toBe(false);
  });
});

describe("applyDefect error type and literal replacement", () => {
  it("throws a CorpusError carrying defectId and file", () => {
    // I-3: Task 2 must be able to tell a stale corpus from a crash without
    // regexing a prose message.
    let thrown: unknown;
    try {
      applyDefect("const a = 1;\n", {
        id: "stale",
        file: "src/kernel/repair.ts",
        find: "const gone = 0;",
        replace: "const gone = 1;",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CorpusError);
    const err = thrown as InstanceType<typeof CorpusError> & CorpusErrorShape;
    expect(err.defectId).toBe("stale");
    expect(err.file).toBe("src/kernel/repair.ts");
    expect(err.message).toMatch(/exactly once/);
  });

  it("treats dollar sequences in a replacement as literal text", () => {
    // M-7: String.replace expands $&, $' and friends, silently yielding source
    // that is not what the corpus asked for.
    const cases: Array<[string, string, string, string]> = [
      ["hello world", "world", "[$&]", "hello [$&]"],
      ["abc", "b", "$1$", "a$1$c"],
      ["abc", "b", "x$'y", "ax$'yc"],
      ["abc", "b", "$$", "a$$c"],
      ["abc", "b", "$`", "a$`c"],
    ];
    for (const [source, find, replace, expected] of cases) {
      const { mutated } = applyDefect(source, { id: "d", file: "x.ts", find, replace });
      expect(mutated).toBe(expected);
    }
  });

  it("does not expand a dollar sequence that appears in the anchor", () => {
    const { mutated } = applyDefect("cost is $5\n", {
      id: "d",
      file: "x.ts",
      find: "$5",
      replace: "$6",
    });
    expect(mutated).toBe("cost is $6\n");
  });
});

describe("mutateFile", () => {
  it("reads the target file and applies the defect without writing it back", () => {
    const root = populatedRoot();
    const { mutated } = mutateFile(root, validDefect());
    expect(mutated).toBe("const a = 2;\n");
    // The machinery must leave the tree it is inspecting untouched.
    expect(readFileSync(join(root, "src", "sample.ts"), "utf8")).toBe("const a = 1;\n");
  });

  it("propagates a CorpusError when the anchor is not unique", () => {
    const root = populatedRoot([validDefect({ find: "const gone = 0;" })]);
    expect(() => mutateFile(root, validDefect({ find: "const gone = 0;" }))).toThrow(
      CorpusError,
    );
  });
});

describe("scratch tree", () => {
  /** The scratch directories currently in the OS temp directory, for leak checks. */
  function scratchTrees(): string[] {
    return readdirSync(tmpdir())
      .filter((entry) => entry.startsWith("factory-mutation-"))
      .sort();
  }

  /** Runs git from inside the given working directory; true if it exited zero. */
  async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    try {
      await execFileAsync("git", args, { cwd });
      return true;
    } catch {
      return false;
    }
  }

  /** Asks git whether a path is ignored, from inside the given working directory. */
  function checkIgnored(cwd: string, path: string): Promise<boolean> {
    return gitSucceeds(cwd, ["check-ignore", "-q", "--no-index", path]);
  }

  /**
   * Runs Vitest with `cwd` as the working directory, resolving the runner out of
   * the scratch tree's own `node_modules`.
   *
   * That working directory is the whole point: git resolves `.gitignore` against
   * the repository containing the current path, so the hygiene tests only
   * exercise the copied `.gitignore` if the process starts inside the scratch
   * tree. `VITEST_*` is stripped so the inner run is not steered by the outer
   * runner's state.
   */
  function runVitestIn(
    cwd: string,
    file: string,
  ): Promise<{ code: number; output: string }> {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
    );
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [join(cwd, "node_modules", "vitest", "vitest.mjs"), "run", file],
        { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += String(chunk);
      });
      child.on("error", (error) => {
        resolve({ code: -1, output: `${output}\nspawn failed: ${error.message}` });
      });
      child.on("close", (code) => resolve({ code: code ?? -1, output }));
    });
  }

  it("copies src and tests into the scratch tree", () => {
    const scratch = createScratch(process.cwd());
    try {
      expect(existsSync(join(scratch.path, "src", "kernel", "integration.ts"))).toBe(true);
      expect(existsSync(join(scratch.path, "tests"))).toBe(true);
      expect(existsSync(join(scratch.path, "package.json"))).toBe(true);
    } finally {
      scratch.cleanup();
    }
  });

  it("does not copy the repository's own directories, and copies node_modules", () => {
    // Renamed to match what it checks. The old name claimed node_modules and
    // .worktrees while asserting neither: node_modules is copied, not skipped,
    // and .worktrees does not exist at a worktree root, so asserting its absence
    // proved nothing. .tmp-test and .factory are asserted instead because the
    // repository root really does contain them.
    const scratch = createScratch(process.cwd());
    try {
      // Not "`.git` is absent": `createScratch` now runs `git init`, so `.git`
      // exists by design. What must not have happened is a *copy* of the source
      // repository's git directory — and inside a linked worktree that `.git` is
      // a file naming the real git directory, so a directory here is the proof.
      expect(lstatSync(join(scratch.path, ".git")).isDirectory()).toBe(true);
      expect(existsSync(join(scratch.path, "dist"))).toBe(false);
      expect(existsSync(join(scratch.path, ".tmp-test"))).toBe(false);
      expect(existsSync(join(scratch.path, ".factory"))).toBe(false);
      expect(existsSync(join(scratch.path, "node_modules"))).toBe(true);
    } finally {
      scratch.cleanup();
    }
  });

  it("refuses a scratch tree whose node_modules is a symlink", () => {
    // Observed during planning: a symlinked node_modules makes
    // `git check-ignore` fail with "beyond a symbolic link", which surfaced
    // as a spurious repo-hygiene failure that looked like a real defect. The
    // symlink is no longer how the tree is built; this pins the guard against
    // someone reintroducing it as a speed optimisation.
    const base = mkdtempSync(join(tmpdir(), "scratch-symlink-"));
    try {
      const target = join(base, "target");
      mkdirSync(target);
      symlinkSync(base, join(target, "node_modules"));
      expect(() => assertRealNodeModules(target)).toThrow(/symlink/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("builds a tree the repo-hygiene tests can actually run in", async () => {
    // The property this whole file exists to guarantee, and the one a
    // hand-made fixture cannot check: a mutation run reports "caught" only when
    // the suite failed *because of the mutation*.
    //
    // Without `git init`, `git check-ignore` reports "not a git repository" and
    // most of the hygiene tests fail whatever mutation is applied, so every
    // defect reads as caught for a reason of its own. With a symlinked
    // node_modules, one more fails with "beyond a symbolic link". Measured on the
    // pre-fix tree: 6 failed, 1 passed — with no defect applied at all.
    const scratch = createScratch(process.cwd());
    try {
      expect(existsSync(join(scratch.path, ".git"))).toBe(true);
      expect(() => assertRealNodeModules(scratch.path)).not.toThrow();

      // Its own repository, not a copy of this one. A scratch tree wired to the
      // real git directory would resolve the real `.gitignore` and could commit
      // a mutation into the real history; a fresh one has no HEAD at all.
      expect(await gitSucceeds(scratch.path, ["rev-parse", "--verify", "HEAD"])).toBe(
        false,
      );

      // The mechanism, asserted directly: git resolves `.gitignore` relative to
      // the repository containing the current path, so these answers can only be
      // right if the scratch tree is itself a repository.
      expect(await checkIgnored(scratch.path, "node_modules/")).toBe(true);
      expect(await checkIgnored(scratch.path, ".tmp-test/opencode-ws-1234")).toBe(true);
      expect(await checkIgnored(scratch.path, "package.json")).toBe(false);

      // And the consequence, end to end. `run` exits non-zero when a filter
      // matches nothing, so this cannot pass by collecting no tests.
      const result = await runVitestIn(scratch.path, "tests/repo-hygiene.test.ts");
      expect(result.code, result.output).toBe(0);
    } finally {
      scratch.cleanup();
    }
  });

  it("leaves no scratch directory behind when construction fails", () => {
    // The caller gets a handle to the directory only if construction finishes,
    // so a failure part-way through has to clean up after itself. ENOENT is the
    // cheapest way in; a mid-copy failure orphans a partial tree the same way.
    const missing = join(tmpdir(), "mutation-corpus-no-such-repo-root");
    const before = scratchTrees();
    expect(() => createScratch(missing)).toThrow();
    expect(scratchTrees()).toEqual(before);
    expect(existsSync(missing)).toBe(false);
  });

  it("cleanup removes the scratch tree and is safe to call twice", () => {
    const scratch = createScratch(process.cwd());
    const path = scratch.path;
    expect(existsSync(path)).toBe(true);
    scratch.cleanup();
    expect(existsSync(path)).toBe(false);
    // A second call must be a no-op, not ENOENT: a runner that cleans up in a
    // finally and again on an error path should not have to track which ran.
    expect(() => scratch.cleanup()).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

/**
 * What `evaluateDefect` takes, read off its own declaration rather than restated
 * here, so narrowing the loader's `unknown[]` cannot drift from the contract the
 * module actually publishes.
 */
type EvaluableDefect = Parameters<typeof evaluateDefect>[1];

/**
 * The evaluator, and the three outcomes it keeps apart.
 *
 *   caught       the suite failed on a mutated tree that was green beforehand.
 *   escaped      the suite passed on a mutated tree — a finding about the suite.
 *   corpus-error the defect could not be evaluated at all, which is never an
 *                escape, because an escape claims a check missed something and a
 *                defect that never ran is not evidence.
 *
 * The rule this file exists to pin is the baseline. Every defect is run twice:
 * once with nothing mutated, to prove the scratch tree is green, and once
 * mutated. Without the first run a scratch tree that fails for environmental
 * reasons makes every defect report "caught" — a systematic false positive that
 * looks exactly like the evidence this tool exists to produce.
 */
describe("defect evaluation", () => {
  /**
   * A stand-in for Vitest, for the paths where what is under test is the
   * evaluator's decision rather than the suite's behaviour.
   *
   * `evaluateDefect` spawns a real Vitest twice per defect, so proving "this
   * scratch tree was already red" honestly would cost a full run per assertion.
   * The shim answers from the tree it is started in: `watched.txt` says which
   * world it is in, and `src/sample.ts` holds the text a defect mutates. The
   * outcomes an operator reads — caught and escaped against the real suite — are
   * proved below with real defects and a real Vitest; what this proves is only
   * that the evaluator declines to attribute what it cannot attribute.
   */
  const SHIM_SOURCE = [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { spawn } from "node:child_process";',
    'import { join } from "node:path";',
    'const read = (path) => readFileSync(join(process.cwd(), path), "utf8");',
    'const world = read("watched.txt").trim();',
    'if (process.env.SUITE_ARGV_FILE) {',
    '  writeFileSync(process.env.SUITE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));',
    '}',
    'if (world === "hang") {',
    '  // Outlive the caller: only the evaluator\'s timeout can end this run.',
    '  setTimeout(() => {}, 2 ** 30);',
    "}",
    'if (world === "hang-fork") {',
    "  // A forked grandchild: the evaluator's timeout must take the whole",
    "  // process group, because Vitest's pool is forked the same way and a",
    "  // direct-child kill would leave the grandchild alive.",
    '  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    '  if (process.env.GRANDCHILD_PID_FILE) {',
    '    writeFileSync(process.env.GRANDCHILD_PID_FILE, String(grandchild.pid));',
    '  }',
    '  setTimeout(() => {}, 2 ** 30);',
    "}",
    'const mutated = read("src/sample.ts");',
    'const fails =',
    '  world === "red" ||',
    '  (world === "red-after-mutation" && mutated.includes("const a = 2;"));',
    "if (fails) {",
    '  const file = world === "red" ? "environmental" : "sample";',
    '  console.log(` FAIL  tests/${file}.test.ts > a check noticed something`);',
    '  console.log(" Test Files  1 failed | 1 passed (2)");',
    "  process.exit(1);",
    "}",
    'console.log(" Test Files  1 passed (1)");',
    "",
  ].join("\n");

  /**
   * A repository whose scratch tree answers deterministically.
   *
   * `node_modules` is built here because `createScratch` copies it explicitly, and
   * the evaluator resolves its runner from the scratch tree: a root without one
   * never gets as far as running anything, which is a separate outcome with its
   * own test below.
   */
  function shimRoot(world: "green" | "red" | "red-after-mutation" | "hang" | "hang-fork"): string {
    const root = mkdtempSync(join(tmpdir(), "corpus-shim-"));
    mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "watched.txt"), `${world}\n`);
    writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), SHIM_SOURCE);
    writeFileSync(join(root, "src", "sample.ts"), "const a = 1;\n");
    writeFileSync(join(root, "tests", "sample.test.ts"), "it('sample', () => {});\n");
    return root;
  }

  /**
   * Hands back exactly what `loadCorpus` returned, un-narrowed. The cast is the
   * point: it stands for the caller who skipped the type guard, and the
   * assertions below are about what the evaluator does with the consequence.
   */
  function asUnnarrowed(entry: unknown): EvaluableDefect {
    return entry as EvaluableDefect;
  }

  it("extracts failing test files from vitest output", () => {
    const output = [
      " FAIL  tests/scope.test.ts > reports no gate when paths are undeclared",
      " FAIL  tests/repair.test.ts > escalates at the limit",
      " Test Files  1 failed | 1 passed (2)",
    ].join("\n");
    expect(extractFailingTests(output).sort()).toEqual([
      "tests/repair.test.ts",
      "tests/scope.test.ts",
    ]);
  });

  it("returns an empty list when nothing failed", () => {
    expect(extractFailingTests(" Test Files  22 passed (22)")).toEqual([]);
  });

  it("extracts the same files from coloured output", () => {
    // Vitest colours its output when it decides it has a terminal, so a parser
    // that only understands a plain pipe would find no failed files in a
    // coloured run — which would read as a failure nothing could be credited for.
    const plain = " FAIL  tests/scope.test.ts > reports no gate when paths are undeclared";
    const coloured = `\u001b[31m${plain.slice(0, 6)}\u001b[39m\u001b[2mtests/scope.test.ts\u001b[22m > reports no gate when paths are undeclared`;
    expect(extractFailingTests(coloured)).toEqual(extractFailingTests(plain));
  });

  it("credits a file once however many of its tests failed", () => {
    const output = [
      " FAIL  tests/scope.test.ts > reports no gate when paths are undeclared",
      " FAIL  tests/scope.test.ts > says so in the gate",
    ].join("\n");
    expect(extractFailingTests(output)).toEqual(["tests/scope.test.ts"]);
  });

  it("extracts failing test files at nested paths", () => {
    // Latent today — every test file in this repo is flat — but loadCorpus
    // accepts a nested aimsAt without complaint, so a defect caught only by a
    // nested test would report caught with caughtBy empty: "no check can be
    // credited" for the wrong reason.
    const output = [
      " FAIL  tests/unit/repair.test.ts > escalates at the limit",
      " FAIL  tests/acceptance/scope.test.ts > reports no gate when paths are undeclared",
      " FAIL  tests/scope.test.ts > a flat one still matches",
      " Test Files  3 failed | 2 passed (5)",
    ].join("\n");
    expect(extractFailingTests(output)).toEqual([
      "tests/acceptance/scope.test.ts",
      "tests/scope.test.ts",
      "tests/unit/repair.test.ts",
    ]);
  });

  it("reports an escaped defect when the suite passes on a mutated tree", async () => {
    // A defect that changes nothing observable: the suite passes, so the
    // control has no test watching it.
    const outcome = await evaluateDefect(process.cwd(), {
      id: "no-op",
      aimsAt: "tests/mutation-runner.test.ts",
      why: "a defect that changes nothing, to prove escape detection works",
      file: "src/kernel/repair.ts",
      find: 'export type RepairLoopStatus = "verified" | "escalated";',
      replace: 'export type RepairLoopStatus = "verified" | "escalated" | "still_worse";',
      expected: "caught",
    });
    expect(outcome.outcome).toBe("escaped");
    expect(outcome.caughtBy).toEqual([]);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  }, 300000);

  it("reports a corpus error, never an escape, when the anchor has drifted", async () => {
    const outcome = await evaluateDefect(process.cwd(), {
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
    const outcome = await evaluateDefect(process.cwd(), {
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
  }, 300000);

  it("attributes the failures a mutation added, having proved the tree was green", async () => {
    // The baseline run is what makes "caught" mean something. Here it is green
    // and the mutation is noticed, so the failure can be credited — a claim the
    // single-run design could not make.
    const outcome = await evaluateDefect(shimRoot("red-after-mutation"), validDefect());
    expect(outcome.outcome).toBe("caught");
    expect(outcome.caughtBy).toEqual(["tests/sample.test.ts"]);
  }, 30000);

  it("reports a corpus error, and attributes nothing, when the scratch tree is already red", async () => {
    // The systematic false positive: a check that fails in a scratch environment
    // for reasons of its own fails for every defect applied to it. Reporting
    // "caught" here would mean "the suite failed", not "the mutation was
    // noticed" — and an environment that cannot produce a clean baseline cannot
    // produce an attributable result.
    const outcome = await evaluateDefect(shimRoot("red"), validDefect());
    expect(outcome.outcome).toBe("corpus-error");
    expect(outcome.caughtBy).toEqual([]);
    expect(outcome.reason).toMatch(/already failing/);
    expect(outcome.reason).toMatch(/tests\/environmental\.test\.ts/);
  }, 30000);

  it("reports a corpus error when the suite cannot start at all", async () => {
    // No runner in the scratch tree means no check ran, so there is nothing to
    // catch and nothing to escape. Left uncaught, this would be reported as an
    // escape for every defect in the corpus.
    const outcome = await evaluateDefect(populatedRoot(), validDefect());
    expect(outcome.outcome).toBe("corpus-error");
    expect(outcome.caughtBy).toEqual([]);
    expect(outcome.reason).toMatch(/could not start/);
  }, 30000);

  it("reports a corpus error when the suite does not finish", async () => {
    // A timeout is not evidence in either direction: the run neither passed nor
    // failed, so reporting it as an escape would claim a check missed something
    // on the strength of a process that was still thinking.
    const outcome = await evaluateDefect(shimRoot("hang"), validDefect(), { timeoutMs: 1000 });
    expect(outcome.outcome).toBe("corpus-error");
    expect(outcome.caughtBy).toEqual([]);
    expect(outcome.reason).toMatch(/did not finish within/);
  }, 30000);

  it("reports a corpus error for a corpus entry that is not a defect", async () => {
    // `loadCorpus` hands back whatever the file contained, so narrowing is the
    // caller's job. This is the caller who skipped it: the result must be a
    // corpus-error naming the problem, not a TypeError that takes the run down
    // and is attributed to no defect at all.
    const root = populatedRoot([null]);
    const [entry] = loadCorpus(root).defects;
    expect(entry).toBeNull();

    const outcome = await evaluateDefect(root, asUnnarrowed(entry));
    expect(outcome.outcome).toBe("corpus-error");
    expect(outcome.caughtBy).toEqual([]);
    expect(outcome.id).toBe("<unnamed>");
    expect(outcome.reason).toMatch(/not an object/);
  }, 30000);

  it("leaves no scratch tree behind, whichever outcome it reports", async () => {
    // A corpus run builds one full tree per defect. A tree left behind per
    // outcome would fill the disk on the run that most needed to be believed.
    const worlds = ["green", "red", "red-after-mutation"] as const;
    const roots = worlds.map(shimRoot);
    const scratchTrees = (): string[] =>
      readdirSync(tmpdir())
        .filter((entry) => entry.startsWith("factory-mutation-"))
        .sort();
    const before = scratchTrees();
    for (const root of roots) {
      await evaluateDefect(root, validDefect());
    }
    expect(scratchTrees()).toEqual(before);
  }, 30000);

  it("keeps its own test file out of the suite it evaluates", () => {
    // Running the evaluator inside the suite it evaluates would recurse: the
    // inner run would collect these tests, each of which spawns two full runs of
    // its own, and the cost would grow with every generation. The harness's own
    // checks are not witnesses for a defect in the product either, so they are
    // kept out of the subject suite. Exported so the runner can refuse a corpus
    // defect that aims at an excluded file instead of reporting it as an escape.
    expect(SUITE_EXCLUDE).toContain("tests/mutation-runner.test.ts");
  });

  it("passes the exclusion of its own test file to the suite it spawns", async () => {
    // The constant assertion above cannot observe the wiring: deleting the
    // `--exclude` arguments from the spawned suite leaves the constant
    // untouched, so that test stays green while the runner recurses into its
    // own test file. What matters is the argv the suite is invoked with, so
    // the shim records its arguments and this test reads them back.
    const dir = mkdtempSync(join(tmpdir(), "suite-argv-"));
    const argvFile = join(dir, "argv.json");
    process.env.SUITE_ARGV_FILE = argvFile;
    try {
      const outcome = await evaluateDefect(shimRoot("green"), validDefect());
      expect(outcome.outcome).toBe("escaped");
      const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
      const pairs = argv.map((arg, index) => [arg, argv[index + 1]] as const);
      expect(pairs).toContainEqual(["--exclude", "tests/mutation-runner.test.ts"]);
    } finally {
      delete process.env.SUITE_ARGV_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("reaps the forked grandchild with the rest of the tree on timeout", async () => {
    // A timeout kills nothing less than the whole process group: the suite's
    // pool is forked, so a direct-child SIGKILL leaves a live pool behind.
    // The shim forks a long-lived grandchild and reports its pid; after the
    // evaluator's timeout that pid must not be alive.
    const dir = mkdtempSync(join(tmpdir(), "grandchild-pid-"));
    const pidFile = join(dir, "grandchild.pid");
    process.env.GRANDCHILD_PID_FILE = pidFile;
    try {
      const outcome = await evaluateDefect(shimRoot("hang-fork"), validDefect(), {
        timeoutMs: 1000,
      });
      expect(outcome.outcome).toBe("corpus-error");
      expect(outcome.reason).toMatch(/did not finish within/);

      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isInteger(pid)).toBe(true);

      // Poll briefly: the grandchild must be gone and reaped, not merely on
      // its way down, before this can claim to have observed the kill.
      let alive = true;
      for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      delete process.env.GRANDCHILD_PID_FILE;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

describe("suite exclusion merging", () => {
  /**
   * Proves CLI `--exclude` is merged with the config file's exclude array,
   * not substituted for it. The canary test below fails whenever it runs, so
   * "not collected" and "collected" differ by the exit code alone. Vitest
   * 3.2.7 merges; if a upgrade ever replaced instead, the mutation runner's
   * own hygiene excludes (node_modules, .tmp-test, ...) would silently stop
   * applying the moment an exclusion was passed.
   */
  it("keeps the config file's excludes when a CLI exclude is passed", async () => {
    const scratch = createScratch(process.cwd());
    try {
      mkdirSync(join(scratch.path, "tests", "nested"), { recursive: true });
      writeFileSync(
        join(scratch.path, "tests", "nested", "skipme-canary.test.ts"),
        ['import { expect, it } from "vitest";', 'it("canary", () => { expect(1).toBe(2); });', ""].join("\n"),
      );
      writeFileSync(
        join(scratch.path, "tests", "nested", "keepme.test.ts"),
        ['import { expect, it } from "vitest";', 'it("keeps running", () => { expect(1).toBe(1); });', ""].join("\n"),
      );

      const configBody = (excludes: string[]) =>
        [
          'import { defineConfig } from "vitest/config";',
          "export default defineConfig({",
          "  test: {",
          '    include: ["tests/nested/**/*.test.ts"],',
          `    exclude: ${JSON.stringify(excludes)},`,
          "  },",
          "});",
          "",
        ].join("\n");

      const run = (args: string[]) =>
        new Promise<{ code: number; output: string }>((resolve) => {
          const child = spawn(
            process.execPath,
            [join(scratch.path, "node_modules", "vitest", "vitest.mjs"), "run", ...args],
            {
              cwd: scratch.path,
              env: Object.fromEntries(
                Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
              ),
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output += String(chunk);
          });
          child.stderr.on("data", (chunk: Buffer) => {
            output += String(chunk);
          });
          child.on("error", (error) => {
            resolve({ code: -1, output: `${output}\nspawn failed: ${error.message}` });
          });
          child.on("close", (code) => resolve({ code: code ?? -1, output }));
        });

      // Control: with no exclude anywhere, the canary is collected and fails.
      // Without this, a green second run could mean "never collected" rather
      // than "excluded", and the test would discriminate nothing.
      writeFileSync(join(scratch.path, "vitest.config.ts"), configBody([]));
      const control = await run([]);
      expect(control.code).not.toBe(0);
      expect(control.output).toContain("skipme-canary");

      // The claim under test: a config-only exclude still applies when the
      // command line adds its own. If the CLI argument replaced the config's
      // array, the canary would be collected and this run would fail.
      writeFileSync(
        join(scratch.path, "vitest.config.ts"),
        configBody(["tests/nested/skipme-canary.test.ts"]),
      );
      const merged = await run(["--exclude", "tests/mutation-runner.test.ts"]);
      expect(merged.code, merged.output).toBe(0);
      expect(merged.output).not.toContain("skipme-canary");
    } finally {
      scratch.cleanup();
    }
  }, 120000);
});

import { readFileSync as readSync } from "node:fs";
import { checkRatchet } from "../scripts/mutation/ratchet.mjs";

const checkRatchetTyped = checkRatchet as unknown as (
  ratchet: { defects: number },
  outcomes: { id: string; outcome: string }[],
) => { ok: boolean; problems: string[] };

describe("ratchet", () => {
  const caught = (id: string) => ({
    id,
    outcome: "caught",
    aimsAt: "tests/a.test.ts",
    caughtBy: ["tests/a.test.ts"],
  });

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

describe("ratchet aim floor", () => {
  const checkRatchetLoose = checkRatchet as unknown as (
    ratchet: { defects: number },
    outcomes: Record<string, unknown>[],
  ) => { ok: boolean; problems: string[] };

  it("passes when each defect's aimsAt is inside its caughtBy, extras included", () => {
    const result = checkRatchetLoose({ defects: 1 }, [
      {
        id: "a",
        outcome: "caught",
        aimsAt: "tests/a.test.ts",
        caughtBy: ["tests/a.test.ts", "tests/extra.test.ts"],
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("fails when a defect is caught but its own aimsAt is not among the catchers", () => {
    const result = checkRatchetLoose({ defects: 1 }, [
      {
        id: "a",
        outcome: "caught",
        aimsAt: "tests/a.test.ts",
        caughtBy: ["tests/other.test.ts"],
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/aimsAt/);
  });

  it("fails when a caught defect names no catchers at all", () => {
    const result = checkRatchetLoose({ defects: 1 }, [
      { id: "a", outcome: "caught", aimsAt: "tests/a.test.ts", caughtBy: [] },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("ratchet fail-closed floor and pure arguments", () => {
  const checkRatchetWithIndex = checkRatchet as unknown as (
    ratchet: { defects: number },
    outcomes: Record<string, unknown>[],
    aimsAtById?: Map<string, string> | Record<string, string>,
  ) => { ok: boolean; problems: string[] };

  it("uses a real corpus-shaped entry to prove the floor fails when the aim is omitted by the catchers", () => {
    // A caught outcome whose own aim is absent from caughtBy must fail. This
    // is the path the production evaluator drives (real id, real aimsAt,
    // caughtBy that omits it), so it must be pinned by a committed test.
    const { defects } = loadCorpus(process.cwd());
    const defect = defects[0] as { id: string; aimsAt: string };
    const result = checkRatchetWithIndex({ defects: 1 }, [
      { id: defect.id, outcome: "caught", aimsAt: defect.aimsAt, caughtBy: ["tests/other.test.ts"] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/aimsAt/);
  });

  it("pins the same production path when the aim comes from the explicit index instead of the outcome", () => {
    const { defects } = loadCorpus(process.cwd());
    const defect = defects[0] as { id: string; aimsAt: string };
    const result = checkRatchetWithIndex(
      { defects: 1 },
      [{ id: defect.id, outcome: "caught", caughtBy: ["tests/other.test.ts"] }],
      { [defect.id]: defect.aimsAt },
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/aimsAt/);
  });

  it("accepts the same index as a Map", () => {
    const { defects } = loadCorpus(process.cwd());
    const defect = defects[0] as { id: string; aimsAt: string };
    const result = checkRatchetWithIndex(
      { defects: 1 },
      [{ id: defect.id, outcome: "caught", caughtBy: [defect.aimsAt] }],
      new Map([[defect.id, defect.aimsAt]]),
    );
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("fails closed when a caught defect's aimsAt cannot be resolved at all", () => {
    const result = checkRatchetWithIndex({ defects: 1 }, [
      { id: "a", outcome: "caught", caughtBy: ["tests/a.test.ts"] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/aimsAt could not be checked/);
  });

  it("does not consult the shipped corpus: a real corpus id with no aim anywhere still fails closed", () => {
    // Before purity, this outcome was judged by whatever defects/mutations.json
    // happened to say on disk. checkRatchet must not read that file; the same
    // arguments must now produce the same verdict regardless of the tree.
    const { defects } = loadCorpus(process.cwd());
    const defect = defects[0] as { id: string; aimsAt: string };
    const first = checkRatchetWithIndex({ defects: 1 }, [
      { id: defect.id, outcome: "caught", caughtBy: [defect.aimsAt] },
    ]);
    const second = checkRatchetWithIndex({ defects: 1 }, [
      { id: defect.id, outcome: "caught", caughtBy: [defect.aimsAt] },
    ]);
    expect(first.ok).toBe(false);
    expect(first.problems.join(" ")).toMatch(/aimsAt could not be checked/);
    expect(second).toEqual(first);
  });

  it("flags an outcome string the checker does not recognize instead of passing it", () => {
    const result = checkRatchetWithIndex({ defects: 1 }, [
      { id: "a", outcome: "quarantined" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/unrecognized outcome/);
  });

  it("threads aimsAt from the evaluator onto the outcome", async () => {
    // Fast path: a corpus entry missing the fields narrowDefect requires is a
    // corpus-error with no suite runs, so this proves the threading without
    // spawning a scratch tree.
    const outcome = await evaluateDefect(process.cwd(), {
      id: "no-file",
      aimsAt: "tests/sample.test.ts",
    } as unknown as EvaluableDefect);
    expect(outcome.outcome).toBe("corpus-error");
    expect(outcome.aimsAt).toBe("tests/sample.test.ts");
  });
});
