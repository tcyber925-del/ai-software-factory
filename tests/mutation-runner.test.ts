import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error -- corpus.mjs is plain ESM with no type declaration; the shapes
// it exposes are asserted by the casts immediately below this import.
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
