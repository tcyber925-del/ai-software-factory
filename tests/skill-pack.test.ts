import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The skill pack is part of the factory's operating model, so its shape is
 * verified rather than assumed. These tests fail if a skill is malformed,
 * missing, or starts carrying factory registry metadata that belongs in the
 * policy layer.
 */

interface Skill {
  dir: string;
  slug: string;
  name: string;
  description: string;
  frontmatter: Record<string, string>;
  body: string;
}

function parseSkill(group: string, dir: string): Skill {
  const raw = readFileSync(`.agents/skills/${group}/${dir}/SKILL.md`, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (match === null) throw new Error(`malformed frontmatter in ${group}/${dir}`);
  const [, frontmatterBlock = "", body = ""] = match;

  const frontmatter: Record<string, string> = {};
  for (const line of frontmatterBlock.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }

  return {
    dir,
    slug: `${group}/${dir}`,
    name: frontmatter["name"] ?? "",
    description: frontmatter["description"] ?? "",
    frontmatter,
    body,
  };
}

function allSkills(): Skill[] {
  const skills: Skill[] = [];
  for (const group of readdirSync(".agents/skills")) {
    for (const dir of readdirSync(`.agents/skills/${group}`)) {
      skills.push(parseSkill(group, dir));
    }
  }
  return skills;
}

/** The pack the approved plan specifies, plus documented extras. */
const FACTORY_PACK = ["work-unit", "git-workflow", "worktree", "scope-review", "verification", "pr-review", "visual-verify", "release"];
/**
 * `integration` predates the plan's flat list and complements `pr-review`: review
 * judges the change, integration prepares the verified result for the gate. It is
 * a recorded divergence, not an omission.
 */
const FACTORY_EXTRAS = ["integration"];
const RUNTIME_PACK = ["herdr", "opencode"];

/**
 * Factory registry metadata belongs to the policy layer, not a portable
 * SKILL.md. Exported as a pure function so the guard can be tested against a
 * skill that actually carries such metadata, rather than against a pack where
 * nothing does (which would pass no matter what the rule said).
 */
const FORBIDDEN_METADATA_KEYS = ["trust", "owner", "ownership", "permission", "provenance", "version"];

export function registryMetadataViolations(skill: Pick<Skill, "slug" | "frontmatter">): string[] {
  return Object.keys(skill.frontmatter).filter((key) => FORBIDDEN_METADATA_KEYS.includes(key.toLowerCase()));
}

describe("factory skill pack", () => {
  it("ships every skill the approved plan requires", () => {
    for (const name of FACTORY_PACK) {
      expect(() => readFileSync(`.agents/skills/factory/${name}/SKILL.md`, "utf8")).not.toThrow();
    }
  });

  it("ships both runtime adapter skills", () => {
    for (const name of RUNTIME_PACK) {
      expect(() => readFileSync(`.agents/skills/runtime/${name}/SKILL.md`, "utf8")).not.toThrow();
    }
  });

  it("has no unexpected or undocumented skills", () => {
    const expected = [...FACTORY_PACK, ...FACTORY_EXTRAS, ...RUNTIME_PACK].sort();
    expect(allSkills().map((skill) => skill.dir).sort()).toEqual(expected);
  });

  it("gives every skill a name, description and body", () => {
    for (const skill of allSkills()) {
      expect(skill.name.length, `${skill.slug} name`).toBeGreaterThan(0);
      expect(skill.description.length, `${skill.slug} description`).toBeGreaterThan(0);
      expect(skill.body.trim().length, `${skill.slug} body`).toBeGreaterThan(0);
    }
  });

  it("keeps frontmatter keys portable and predictable", () => {
    const allowed = new Set(["name", "description", "category", "provider"]);
    for (const skill of allSkills()) {
      for (const key of Object.keys(skill.frontmatter)) {
        expect(allowed.has(key), `${skill.slug} has unexpected frontmatter '${key}'`).toBe(true);
      }
    }
  });

  it("does not embed factory registry metadata in a skill", () => {
    for (const skill of allSkills()) {
      expect(registryMetadataViolations(skill), `${skill.slug} must not carry registry metadata`).toEqual([]);
    }
  });

  it("actually rejects registry metadata when a skill does carry it", () => {
    // Guards against the check becoming vacuous: a pack where nothing violates the
    // rule would pass even if the rule were removed.
    const offending: Pick<Skill, "slug" | "frontmatter"> = {
      slug: "factory/example",
      frontmatter: { name: "example", description: "x", trust: "high", owner: "platform", provenance: "internal" },
    };
    expect(registryMetadataViolations(offending)).toEqual(["trust", "owner", "provenance"]);
  });

  it("keeps a matching name for each runtime adapter skill", () => {
    const herdr = allSkills().find((skill) => skill.dir === "herdr");
    expect(herdr?.name).toBe("runtime-herdr");
    expect(herdr?.frontmatter["provider"]).toBe("herdr");
    const opencode = allSkills().find((skill) => skill.dir === "opencode");
    expect(opencode?.name).toBe("runtime-opencode");
    expect(opencode?.frontmatter["provider"]).toBe("opencode");
  });

  it("gives factory skills a plain name matching their directory", () => {
    for (const name of [...FACTORY_PACK, ...FACTORY_EXTRAS]) {
      expect(parseSkill("factory", name).name).toBe(name);
    }
  });
});

describe("skills state the invariants they enforce", () => {
  it("git-workflow forbids direct protected-branch writes", () => {
    const body = parseSkill("factory", "git-workflow").body.toLowerCase();
    expect(body).toContain("protected");
    expect(body).toContain("pull request");
    expect(body).toContain("force-push");
  });

  it("worktree states that a worktree is not a security sandbox", () => {
    const body = parseSkill("factory", "worktree").body.toLowerCase();
    expect(body).toContain("not a security boundary");
    expect(body).toContain("serialize");
  });

  it("pr-review forbids treating a green run as proof of correctness", () => {
    const body = parseSkill("factory", "pr-review").body.toLowerCase();
    expect(body).toContain("necessary, not sufficient");
    expect(body).toContain("scope");
  });

  it("visual-verify requires observing behaviour rather than inferring it", () => {
    const body = parseSkill("factory", "visual-verify").body.toLowerCase();
    expect(body).toContain("accessibility");
    expect(body).toContain("evidence");
  });

  it("release requires verification before shipping and forbids autonomous deployment", () => {
    const body = parseSkill("factory", "release").body.toLowerCase();
    expect(body).toContain("no autonomous production deployment");
    expect(body).toContain("verified, not merely complete");
  });

  it("every factory skill references the protocol or policy docs", () => {
    for (const name of FACTORY_PACK) {
      const body = parseSkill("factory", name).body;
      expect(/docs\/[a-z-]+\.md/.test(body), `${name} should cite an authoritative doc`).toBe(true);
    }
  });
});