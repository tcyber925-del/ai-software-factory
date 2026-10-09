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
  "docs/using-the-factory.md",
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

describe("the adoption guide cannot ship a broken starting point", () => {
  /**
   * A fresh clone has the factory's own 362-test suite at `tests/`. An adopter who
   * keeps it gets a verify gate that collects those tests instead of their own, so
   * the guide must say to remove them. This failed silently until simulated.
   */
  it("tells the adopter to delete the factory's own test suite", () => {
    const adoption = read("docs/adoption.md");
    expect(adoption).toMatch(/rm -rf tests fixtures/);
    expect(adoption.replace(/\s+/g, " ")).toMatch(/instead of yours/);
  });

  it("warns that copying package.json clobbers an existing project", () => {
    const adoption = read("docs/adoption.md");
    expect(adoption).toMatch(/[Mm]erge these into your existing files rather than copying/);
  });

  it("tells the adopter the shipped CI workflow tests the factory, not their project", () => {
    expect(read("docs/adoption.md")).toMatch(/tests \*\*the factory\*\*/);
  });

  it("records why the factory is not installable from npm", () => {
    // `"private": true` plus a `bin` entry looks like an oversight unless the
    // decision is written down. It is the difference between a template and a
    // half-finished package.
    const licensing = read("docs/licensing.md");
    expect(licensing).toMatch(/Distribution: a template, not a package/);
    expect(licensing).toMatch(/private/);
  });

  it("says the same thing in the template's own README", () => {
    // The README is what an adopter reads after cloning, before the guide.
    const template = read("templates/project/README.md");
    expect(template).toMatch(/rm -rf tests fixtures/);
    expect(template).toMatch(/not a drop-in replacement/i);
  });

  it("keeps the factory's own suite at tests/ while CI still requires it", () => {
    // Guard the guard: if the suite ever moves, this test must be revisited rather
    // than silently passing because the path no longer exists.
    expect(() => read("tests/pipeline.test.ts")).not.toThrow();
  });
});

describe("documentation cannot rot into inaccuracy", () => {
  /**
   * Three of these assertions exist because a claim in these docs was *wrong* at
   * some point and nothing noticed.
   */

  it("states no test count, because a count in prose rots", () => {
    // This project has published three different suite sizes across its history,
    // including one inflated 80% by a stale worktree that looked like real coverage.
    // The count is available by running the suite; a number in prose is stale the
    // moment a test is added and nobody can tell which figure is current.
    for (const path of ALL_DOCS) {
      const match = read(path).match(/\b\d{3,4} tests\b/);
      expect(match, `${path} states a test count ("${match?.[0] ?? ""}") — point readers at \`npm run verify\` instead`).toBeNull();
    }
  });

  it("does not claim the repository is untagged when a release exists", () => {
    for (const path of ALL_DOCS) {
      expect(read(path), `${path} claims there are no release tags`).not.toMatch(/no release tags/i);
    }
  });

  it("describes the security gate as composed, not library-only", () => {
    // The security gate was library-only for several merges while other docs
    // described it as enforced. The mismatch is worse than either state alone.
    //
    // Every phrasing below is one this project has actually used while the gate was
    // unwired, so each is checked individually. A first version of this test matched
    // only one of them and passed while `security.md` and `runtime-adapters.md` were
    // both still claiming "no caller" — a guard written for one phrasing is not a
    // guard. Note what is deliberately absent: a bare `/has no caller/`, because
    // `adoption.md` legitimately teaches that a green run proves nothing about a
    // control that is not called.
    const unwired = [
      /library only, not composed/i,
      /not composed into/i,
      /has no caller in the composed pipeline/i,
      /not called by [`']?factory work run/i,
      /the gate is not called/i,
      /reachable only through a caller/i,
      /the library's behaviour, not the/i,
    ];
    for (const path of ALL_DOCS) {
      const body = read(path);
      for (const pattern of unwired) {
        expect(body, `${path} still describes the security gate as unwired (${pattern})`).not.toMatch(pattern);
      }
    }
  });

  it("points at security-policy anchors that exist", () => {
    // Both docs linked to `security-policy.md#not-enforced-at-dispatch`, an anchor
    // that stopped existing when the section was renamed. A broken cross-reference is
    // the reader arriving at a page and finding nothing.
    const anchors = new Set(
      (read("docs/security-policy.md").match(/^#{2,3} .*$/gm) ?? [])
        .map((heading) => heading.replace(/^#+\s*/, "").toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-"))
    );
    expect(anchors.size).toBeGreaterThan(0);
    for (const path of ALL_DOCS) {
      for (const match of read(path).matchAll(/security-policy\.md#([a-z0-9-]+)/g)) {
        expect(anchors, `${path} links to security-policy.md#${match[1]}, which does not exist`).toContain(match[1]!);
      }
    }
  });

  it("does not describe `paths` as advisory now that it is enforced", () => {
    for (const path of ALL_DOCS) {
      expect(read(path), `${path} still calls scope advisory`).not.toMatch(
        /scope is advisory|paths is advisory|declared but never enforced/i,
      );
    }
  });

  it("does not claim factory verify is broken", () => {
    // Fixed when it learned to read the project's own scripts. The stale claim
    // outlived the bug by several merges.
    //
    // The first version of this guard matched two literal phrasings, neither of
    // which any document used — so it passed vacuously while the claim sat in
    // two docs for several merges. A staleness guard is a control only if it
    // fails on the real wording, so these patterns are asserted against the
    // sentence that actually shipped, below, before they are trusted.
    const stale = [
      /factory verify`? is (?:currently )?non-functional/i,
      /factory verify`? is \*\*not\*\* the same gate and does not currently pass/i,
      /`?factory verify`? (?:shells out to|invokes) `?(?:npm run )?(?:five )?(?:format:check|`npm run`)/i,
      /`?npm run verify`? is the working equivalent/i,
      /`?factory verify`? is not\b/i,
    ];
    for (const path of ALL_DOCS) {
      for (const pattern of stale) {
        expect(read(path), `${path} still says factory verify is unusable (${pattern})`).not.toMatch(pattern);
      }
    }
  });

  it("the factory-verify staleness guard fails on the claim it was written for", () => {
    // A guard that matches nothing is worse than no guard: it reads as evidence
    // in review while checking nothing. The sentences below are the ones that
    // shipped in docs/cli.md and docs/verification-and-merge-gates.md. If a
    // future edit weakens a pattern, this fails instead of the guard going
    // quietly vacuous a second time.
    const shipped = [
      "### `factory verify` is currently non-functional",
      "`factory verify` shells out to `npm run` for `format:check`, `lint`, `typecheck`,",
      "`npm run verify` is the working equivalent.",
      "`factory verify` is **not** the same gate and does not currently pass",
      "which is why `npm run verify` is the working equivalent there and `factory verify` is not",
    ];
    const stale = [
      /factory verify`? is (?:currently )?non-functional/i,
      /factory verify`? is \*\*not\*\* the same gate and does not currently pass/i,
      /`?factory verify`? (?:shells out to|invokes) `?(?:npm run )?(?:five )?(?:format:check|`npm run`)/i,
      /`?npm run verify`? is the working equivalent/i,
      /`?factory verify`? is not\b/i,
    ];
    for (const sentence of shipped) {
      expect(stale.some((pattern) => pattern.test(sentence)), `the guard no longer catches: ${sentence}`).toBe(true);
    }
  });

  it("documents factory verify the way it actually behaves", () => {
    // The behaviour, asserted against the shipped command rather than a comment:
    // `factory verify` reads the target project's own `verify` script and runs
    // it alone. A doc claiming otherwise sends a reader to debug a bug that was
    // fixed, and — worse — teaches them that verification is unavailable.
    // Prose is hard-wrapped, so a phrase can straddle a newline. Matching the raw
    // text would couple the assertion to the wrapping, and a later re-wrap would
    // fail the suite for no real reason. Collapse whitespace first.
    const flat = (text: string): string => text.replace(/\s+/g, " ");
    const docs = flat(read("docs/cli.md"));
    expect(docs, "docs/cli.md must not claim the command is non-functional").not.toMatch(
      /factory verify` is currently non-functional/i,
    );
    expect(docs, "docs/cli.md must state that it runs the project's own verify script").toMatch(
      /runs the (?:target )?project'?s own `?verify`? script/i,
    );
  });

  it("names the release somewhere a reader will find it", () => {
    expect(read("README.md")).toMatch(/v0\.1\.0/);
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