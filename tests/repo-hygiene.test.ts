import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The repository previously shipped no `.gitignore`, so `node_modules/` and the
 * `.tmp-test/` residue created by the OpenCode adapter test could be committed by
 * accident. For a repository meant to be adopted as a template, that is a real
 * adoption hazard.
 *
 * These checks delegate to `git check-ignore` rather than reimplementing
 * gitignore matching, so they assert Git's actual behaviour instead of a
 * hand-rolled approximation of it.
 */

const execFileAsync = promisify(execFile);

async function ignored(path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--no-index", path]);
    return true;
  } catch {
    return false;
  }
}

describe(".gitignore covers build and test residue", () => {
  it("excludes dependencies", async () => {
    expect(await ignored("node_modules/")).toBe(true);
  });

  it("excludes the OpenCode adapter test residue", async () => {
    expect(await ignored(".tmp-test/opencode-ws-1234")).toBe(true);
  });

  it("excludes factory event logs", async () => {
    expect(await ignored(".factory/events.jsonl")).toBe(true);
    expect(await ignored(".factory/runs/run-1/events.jsonl")).toBe(true);
  });

  it("excludes local environment files but keeps the example", async () => {
    expect(await ignored(".env")).toBe(true);
    expect(await ignored(".env.production")).toBe(true);
    expect(await ignored(".env.example")).toBe(false);
  });

  it("excludes build output, editor noise and worktrees", async () => {
    for (const path of ["dist/", "build/", "coverage/", ".DS_Store", ".idea/", ".vscode/", ".worktrees/"]) {
      expect(await ignored(path), `${path} should be ignored`).toBe(true);
    }
  });

  it("excludes logs and build info", async () => {
    for (const path of ["npm-debug.log", "app.log", "tsconfig.tsbuildinfo"]) {
      expect(await ignored(path), `${path} should be ignored`).toBe(true);
    }
  });

  it("never ignores anything the factory ships", async () => {
    for (const path of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "LICENSE",
      "AGENTS.md",
      "README.md",
      "src/protocol.ts",
      "src/kernel/scheduler.ts",
      "schemas/work-unit.schema.json",
      "docs/architecture.md",
      "docs/cli.md",
      "src/kernel/pipeline.ts",
      "src/cli/index.ts",
      ".agents/skills/factory/work-unit/SKILL.md",
      ".agents/skills/runtime/herdr/SKILL.md",
      ".github/workflows/ci.yml",
      ".factory/policies/autonomy.md",
      ".factory/workflows/implementation.md",
      "tests/fake-runtime.test.ts",
    ]) {
      expect(await ignored(path), `${path} must remain trackable`).toBe(false);
    }
  });
});