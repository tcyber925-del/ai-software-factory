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
