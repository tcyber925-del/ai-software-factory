import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { validateAgainstSchema } from "../src/kernel/json-schema.js";
import { validateWorkUnit, workUnitToWireForm } from "../src/kernel/work-unit.js";
import type { WorkUnit } from "../src/protocol.js";

/**
 * FCT-015 acceptance requires that a fresh repository can adopt the template
 * and that the example execution actually works. Both are verified here by
 * building the template in a scratch directory and validating the example Work
 * Unit against the real schema and the real validator.
 */

const execFileAsync = promisify(execFile);
const workUnitSchema = JSON.parse(await readFile("schemas/work-unit.schema.json", "utf8")) as JsonSchema;

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "factory-adopt-"));
});

afterAll(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
});

describe("template project scaffolding", () => {
  it("ships a package.json whose scripts match the factory contract", async () => {
    const pkg = JSON.parse(await readFile("templates/project/package.json", "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
      private: boolean;
    };
    expect(pkg.scripts["build"]).toBe("tsc --noEmit");
    expect(pkg.scripts["verify"]).toContain("npm run build");
    expect(pkg.private).toBe(true);
    // `--passWithNoTests` because a fresh project has no tests yet, and an empty
    // suite exiting non-zero would fail CI on a repository that has done nothing
    // wrong. Without it, `vitest run` on an empty directory exits 1.
    expect(pkg.scripts["test"]).toBe("vitest run --passWithNoTests");
    for (const dependency of ["typescript", "vitest", "@types/node"]) {
      expect(pkg.devDependencies[dependency]).toBeDefined();
    }
  });

  it("ships a strict tsconfig matching the factory baseline", async () => {
    const tsconfig = JSON.parse(await readFile("templates/project/tsconfig.json", "utf8")) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions["strict"]).toBe(true);
    expect(tsconfig.compilerOptions["noUncheckedIndexedAccess"]).toBe(true);
    expect(tsconfig.compilerOptions["exactOptionalPropertyTypes"]).toBe(true);
    expect(tsconfig.compilerOptions["noEmit"]).toBe(true);
  });

  it("carries the project policy template", async () => {
    const policy = await readFile("templates/project/.factory/policies/project-policy.md", "utf8");
    // The guarantees must survive adoption.
    expect(policy).toContain("Verification is independent");
    expect(policy).toContain("No direct protected-branch writes");
    expect(policy).toContain("not a security boundary");
    expect(policy).toContain("Bounded repair");
    expect(policy).toContain("No autonomous merge or release");
    // And the optional-runtime distinction must survive too.
    expect(policy).toContain("not a mandatory dependency");
  });

  it("ships an adoption-ready skill template", async () => {
    const skill = await readFile("templates/skills/project-verification/SKILL.md", "utf8");
    expect(skill.startsWith("---\n")).toBe(true);
    expect(skill).toContain("name: project-verification");
    expect(skill).toContain("description:");
    // Skills must remain portable: no factory registry metadata.
    for (const forbidden of ["trust:", "owner:", "provenance:", "permissions:"]) {
      expect(skill).not.toContain(forbidden);
    }
  });

  it("documents the full adoption path", async () => {
    const adoption = await readFile("docs/adoption.md", "utf8");
    for (const section of ["Adoption steps", "Adoption checklist", "Requirements", "What you get"]) {
      expect(adoption).toContain(section);
    }
    // The step that actually makes the gate real must be documented.
    expect(adoption).toContain("Branch protection");
    expect(adoption).toContain("contract");
    // Optional vs required runtime must be explicit for adopters.
    const flat = adoption.replace(/[*_`>]/g, "").replace(/\s+/g, " ");
    expect(flat).toContain("not a mandatory dependency");
  });
});

describe("example Work Unit", () => {
  it("validates against the real work-unit schema and kernel validator", async () => {
    const wire = JSON.parse(await readFile("examples/example-work-unit.json", "utf8"));
    expect(validateAgainstSchema(wire, workUnitSchema)).toEqual([]);

    const workUnit: WorkUnit = {
      id: wire.id as string,
      goal: wire.goal as string,
      repository: wire.repository as string,
      capabilities: wire.capabilities as string[],
      acceptanceCriteria: wire.acceptance_criteria as string[],
      ...(wire.base_revision === undefined ? {} : { baseRevision: wire.base_revision as string }),
      ...(wire.scope === undefined ? {} : { scope: wire.scope as string[] }),
      ...(wire.verification === undefined ? {} : { verification: wire.verification as string[] }),
      ...(wire.autonomy === undefined ? {} : { autonomy: wire.autonomy as "automatic" | "review" | "approval" }),
    };

    // The example must survive the same validation the kernel performs.
    const validation = validateWorkUnit(workUnit, workUnitSchema);
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("round-trips through the kernel's camelCase wire projection", async () => {
    const wire = JSON.parse(await readFile("examples/example-work-unit.json", "utf8"));
    const workUnit: WorkUnit = {
      id: wire.id as string,
      goal: wire.goal as string,
      repository: wire.repository as string,
      capabilities: wire.capabilities as string[],
      acceptanceCriteria: wire.acceptance_criteria as string[],
      baseRevision: wire.base_revision as string,
    };
    const projected = workUnitToWireForm(workUnit);
    expect(projected["base_revision"]).toBe(wire.base_revision);
    expect(projected["acceptance_criteria"]).toEqual(wire.acceptance_criteria);
    expect(validateAgainstSchema(projected, workUnitSchema)).toEqual([]);
  });

  it("declares capabilities rather than providers", async () => {
    const wire = JSON.parse(await readFile("examples/example-work-unit.json", "utf8"));
    const capabilities = wire.capabilities as string[];
    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) {
      // A provider or command is not a requirement.
      expect(capability, `"${capability}" must not name a provider`).not.toMatch(/opencode|herdr|hermes|claude|codex|npm|git/);
    }
  });

  it("pairs the human-readable and wire forms", async () => {
    const markdown = await readFile("examples/example-work-unit.md", "utf8");
    for (const heading of ["Goal", "Repository", "Capabilities", "Scope", "Acceptance criteria", "Non-goals"]) {
      expect(markdown).toContain(`## ${heading}`);
    }
    // The guidance about providers must survive into the example.
    expect(markdown.toLowerCase()).toContain("never name a provider");
  });
});

describe("reusable core carries no project-specific assumptions", () => {
  it("references no concrete project or owner in src, tests, or schemas", async () => {
    for (const dir of ["src", "tests", "schemas"]) {
      const files = await readdir(dir, { recursive: true });
      for (const entry of files) {
        if (typeof entry !== "string" || !entry.endsWith(".ts") && !entry.endsWith(".json")) continue;
        const path = join(dir, entry);
        // This file names the patterns it forbids, so exclude itself.
        if (path.endsWith("adoption.test.ts")) continue;
        const contents = await readFile(path, "utf8");
        expect(contents, `${path} must not name a concrete project`).not.toMatch(
          /tcyber925|ethioai|ethio-?ai/i,
        );
      }
    }
  });

  it("keeps schema $id values host-neutral", async () => {
    for (const file of await readdir("schemas")) {
      const parsed = JSON.parse(await readFile(join("schemas", file), "utf8")) as { $id: string };
      // Schema identifiers must not point at one deployment's hostname.
      expect(parsed.$id, `${file} $id must not be host-specific`).not.toMatch(/github\.com|tcyber925/i);
    }
  });
});

describe("a fresh repository can adopt the template", () => {
  it("builds an adopting project from the template scaffolding", async () => {
    // Materialise the template the way the adoption guide instructs.
    const project = join(scratch, "adopting-project");
    await execFileAsync("mkdir", ["-p", join(project, "src"), join(project, "tests"), join(project, ".factory", "policies")]);
    await writeFile(join(project, "package.json"), await readFile("templates/project/package.json", "utf8"));
    await writeFile(join(project, "tsconfig.json"), await readFile("templates/project/tsconfig.json", "utf8"));
    await writeFile(
      join(project, ".factory", "policies", "project-policy.md"),
      await readFile("templates/project/.factory/policies/project-policy.md", "utf8"),
    );
    // A minimal source file so `include` matches something real.
    await writeFile(join(project, "src", "index.ts"), "export const adopted = true;\n");

    const root = new URL("../", import.meta.url).pathname;
    const installed = join(root, "node_modules");
    await execFileAsync("ln", ["-s", installed, join(project, "node_modules")]);

    // The adopted project must satisfy the factory's own build contract.
    await execFileAsync("npm", ["run", "build"], { cwd: project, env: { ...process.env, PATH: `${join(root, "node_modules", ".bin")}:${process.env["PATH"] ?? ""}` } });

    for (const file of ["package.json", "tsconfig.json", ".factory/policies/project-policy.md", "src/index.ts"]) {
      await expect(readFile(join(project, file), "utf8")).resolves.toBeDefined();
    }
  }, 120_000);
});