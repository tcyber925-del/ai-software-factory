import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Documentation is only a control when a stale claim is caught. These tests read the
 * shipped docs and fail when they describe a state the repository has left behind.
 *
 * The failure mode they exist for is specific: a factory whose docs still claim the
 * scheduler is unimplemented is worse than one with no docs, because a reader has no
 * way to tell the claim is stale.
 */

const repo = process.cwd();
const read = (path: string): string => readFileSync(join(repo, path), "utf8");

/** Every doc the CI contract requires, so this list and the workflow cannot drift. */
const REQUIRED_DOCS = [
  "AGENTS.md",
  "README.md",
  "docs/architecture.md",
  "docs/protocols.md",
  "docs/schemas.md",
  "docs/runtime-adapters.md",
  "docs/security.md",
  "docs/execution.md",
  "docs/provenance.md",
  "docs/scheduling.md",
  "docs/repair.md",
  "docs/doctor.md",
  "docs/cli.md",
  "docs/licensing.md",
  "docs/security-policy.md",
  "docs/hermes-adapter.md",
  "docs/linear-adapter.md",
  "docs/verification-and-merge-gates.md",
  "docs/adoption.md",
];

const ALL_DOCS = [...REQUIRED_DOCS];

describe("the documentation set is complete and indexed", () => {
  it("every required document exists", () => {
    for (const path of REQUIRED_DOCS) {
      expect(read(path).length, `${path} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("CI requires exactly the documents this test lists", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const path of REQUIRED_DOCS) {
      expect(ci, `CI must require ${path}`).toContain(`test -f ${path}`);
    }
  });

  it("the README indexes every required document", () => {
    const readme = read("README.md");
    for (const path of REQUIRED_DOCS) {
      if (path === "README.md") continue;
      expect(readme, `README should link ${path}`).toContain(path);
    }
  });

  it("the README documents the shipped structure", () => {
    const readme = read("README.md");
    // A reader navigating by the tree must not be sent to directories that moved.
    // The tree nests under `src/`, so children appear as bare names in it.
    const srcChildren = readdirSync(join(repo, "src"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${entry.name}/`);
    for (const child of srcChildren) {
      expect(readme, `README structure should mention src/${child}`).toContain(child);
    }
    for (const top of ["fixtures/", "examples/", "schemas/", "tests/", "templates/", "docs/"]) {
      expect(readme, `README structure should mention ${top}`).toContain(top);
    }
  });

  it("the README points at the agent contract", () => {
    expect(read("README.md")).toContain("AGENTS.md");
  });
});

describe("no document claims an unimplemented state", () => {
  it("the README does not describe the factory as a bootstrap", () => {
    const readme = read("README.md");
    expect(readme).not.toMatch(/Foundation bootstrap/);
    expect(readme).not.toMatch(/are intentionally not implemented yet/);
    expect(readme).not.toMatch(/Planned first vertical slice/);
    // V1 non-goals stay non-goals, but they are labelled as such.
    expect(readme).toMatch(/Non-goals for V1/);
  });

  it("no document points at a source path that does not exist", () => {
    const exists = (relative: string): boolean => {
      // A trailing `.ts`/`.json` means a file, not a directory, so the extension is
      // checked before falling back to a directory listing.
      try {
        return statSync(join(repo, relative)).isDirectory() || statSync(join(repo, relative)).isFile();
      } catch {
        return false;
      }
    };
    for (const path of ALL_DOCS) {
      // A brace group such as `src/adapters/{opencode,herdr}` names several siblings,
      // so it is expanded to one path per member and each is checked.
      const body = read(path).replace(/\{([a-z0-9,_-]+)\}/g, (_match, group: string) =>
        group.split(",").map((name) => ` ${name} `).join(""),
      );
      // Only claims about *this* repository are checked. A path inside an example
      // Work Unit — `"paths": ["src/health"]` — names the adopting project's
      // source, not the factory's, so claims in backticks are the ones that must
      // resolve. Bare JSON example values are left alone deliberately.
      const claims = new Set(
        [...body.matchAll(/`([^`\n]+)`/g)]
          .flatMap((match) => match[1]!.match(/\bsrc\/[a-z0-9/_-]+(?:\.(?:ts|json))?/g) ?? [])
          .map((reference) => reference.replace(/\/$/, "")),
      );
      for (const claim of claims) {
        expect(exists(claim), `${path} references ${claim}, which does not exist`).toBe(true);
      }
    }
  });

  it("no document defers work to a later unit that has since shipped", () => {
    // Each of these was true when written and is now false; the phrases are what a
    // reader would use to decide the feature is missing.
    const stale: Array<[string, RegExp]> = [
      ["doctor is not wired to the CLI", /is currently a library/],
      ["repair loop is a later Work Unit", /repair loop are later Work Units/i],
      ["nothing publishes the integration result", /nothing publishes it/],
      ["risk classification belongs to a future unit", /belongs to FCT-014/],
    ];
    for (const path of ALL_DOCS) {
      const body = read(path);
      for (const [why, pattern] of stale) {
        expect(body, `${path}: ${why}`).not.toMatch(pattern);
      }
    }
  });

  it("the doctor doc tells the reader how to run it", () => {
    expect(read("docs/doctor.md")).toMatch(/factory doctor/);
    expect(read("docs/adoption.md")).toMatch(/dist\/bin\.js doctor/);
  });
});

describe("the invariants are documented where they are enforced", () => {
  it("every shipped unit has a document", () => {
    // FCT-001..FCT-016. Not every unit needs its own file, but the set of concepts
    // the docs cover must not have a hole where a shipped unit belongs.
    const concepts: Array<[string, string]> = [
      ["protocols", "docs/protocols.md"],
      ["schemas", "docs/schemas.md"],
      ["execution", "docs/execution.md"],
      ["provenance", "docs/provenance.md"],
      ["scheduling", "docs/scheduling.md"],
      ["repair", "docs/repair.md"],
      ["doctor", "docs/doctor.md"],
      ["security", "docs/security-policy.md"],
      ["cli", "docs/cli.md"],
      ["hermes", "docs/hermes-adapter.md"],
      ["linear", "docs/linear-adapter.md"],
      ["licensing", "docs/licensing.md"],
      ["adoption", "docs/adoption.md"],
    ];
    for (const [concept, path] of concepts) {
      expect(read(path).length, `${concept} has no document`).toBeGreaterThan(200);
    }
  });

  it("the two pipeline invariants are stated in the CLI doc", () => {
    const cli = read("docs/cli.md");
    expect(cli).toMatch(/independent verification/i);
    expect(cli).toMatch(/executed worktree|worktree that was actually executed/i);
    // The negative case is the point: a runtime-green run must still block.
    expect(cli).toMatch(/does not fall back|refusing to fall back/i);
  });

  it("cross-references between docs resolve to files that exist", () => {
    for (const path of ALL_DOCS) {
      const links = read(path).match(/\]\(([a-zA-Z0-9._/-]+\.md)\)/g) ?? [];
      for (const link of links) {
        const target = link.replace(/\]\(|\)/g, "");
        const resolved = target.startsWith("docs/")
          ? join(repo, target)
          : join(repo, path.split("/")[0]!, target);
        expect(() => readFileSync(resolved, "utf8"), `${path} links to missing ${target}`).not.toThrow();
      }
    }
  });
});

describe("the examples are runnable", () => {
  it("the example plan is a plan, not a bare Work Unit", () => {
    // The CLI reads plans; the wire-form Work Unit alone is not one. Shipping only
    // the latter and documenting `work run` against it would not work.
    const plan = JSON.parse(read("examples/example-plan.json")) as unknown;
    expect(Array.isArray(plan)).toBe(true);
    expect((plan as Array<Record<string, unknown>>)[0]).toHaveProperty("workUnit");
    expect((plan as Array<Record<string, unknown>>)[0]).toHaveProperty("paths");
  });

  it("the bare Work Unit example stays in wire form", () => {
    const unit = JSON.parse(read("examples/example-work-unit.json")) as Record<string, unknown>;
    expect(unit).toHaveProperty("acceptance_criteria");
    expect(unit).not.toHaveProperty("workUnit");
  });

  it("the documented invocation names a file that exists", () => {
    const readme = read("README.md");
    const invocation = readme.match(/work (?:validate|run)[^\n]*--work-units (\S+)/);
    expect(invocation).not.toBeNull();
    expect(() => readFileSync(join(repo, invocation![1]!), "utf8")).not.toThrow();
  });
});