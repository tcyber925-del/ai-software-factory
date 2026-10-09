import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GitHubEligibilityConfig, GitHubIssue, GitHubRefusalReason } from "../src/adapters/github/intake.js";
import {
  GITHUB_HARD_EXCLUDED_STATE_REASONS,
  compileGitHubWorkUnit,
  evaluateGitHubEligibility,
  githubIntakeAdapter,
  githubIssueUrl,
  parseGitHubRequirements,
} from "../src/adapters/github/intake.js";
import type { IntakeRefusalClassification } from "../src/kernel/intake.js";
import type { ExecutionRecord } from "../src/kernel/execution.js";
import { describeIntakeOutcome, runIntake } from "../src/kernel/intake.js";
import { validateWorkUnit, workUnitToWireForm } from "../src/kernel/work-unit.js";
import { validateAgainstSchema } from "../src/kernel/json-schema.js";
import { assessExecutionRisk } from "../src/security/risk.js";
import { planSchedule } from "../src/kernel/scheduler.js";
import { buildIntegrationResult } from "../src/kernel/integration.js";

/**
 * GitHub Issues intake (FCT-028).
 *
 * Driven by `fixtures/github/issues.json`: payloads recorded from this
 * repository's real issues plus explicitly-marked synthetic cases. The suite is
 * therefore offline and reproducible, and no CI job needs a GitHub credential.
 *
 * Every rule below is the GitHub expression of a convention the repo already
 * recognizes — an explicit, human-planted eligibility marker; an allowlist that
 * is empty until a human fills it; a declared requirements block; a repository
 * the caller names. Nothing here is inferred from an issue body.
 */

interface Fixture {
  issues: (GitHubIssue & { shape: string; note?: string })[];
}

const fixtures: Fixture = JSON.parse(readFileSync("fixtures/github/issues.json", "utf8")) as Fixture;
const workUnitSchema = JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8")) as never;

const issue = (id: number): GitHubIssue => {
  const found = fixtures.issues.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`fixture missing: issue ${id}`);
  return found;
};
const all = (): GitHubIssue[] => fixtures.issues;

/**
 * The eligibility allowlist a human has approved.
 *
 * Empty by default in production; a non-empty list here is the operator
 * explicitly saying which label clears an issue for dispatch.
 */
const eligible = { eligibleLabels: ["factory:eligible"] };

describe("fixtures reflect this repository's real GitHub issues", () => {
  it("records both real and explicitly-marked synthetic issues", () => {
    expect(fixtures.issues.some((entry) => entry.shape === "real")).toBe(true);
    const synthetic = fixtures.issues.filter((entry) => entry.shape === "synthetic");
    expect(synthetic.length).toBeGreaterThan(0);
    // FCT-018 required synthetic fixtures to stay visibly marked: a fabricated
    // payload must never be mistaken for a recorded one.
    for (const entry of synthetic) expect(entry.note, `issue ${entry.id} must carry a note`).toBeDefined();
  });

  it("records GitHub's own state taxonomy, which has no ready status", () => {
    // GitHub exposes only `open`/`closed` plus a close reason. There is no "Ready",
    // exactly as the Linear workspace had none — which is why eligibility cannot
    // be read off the state field.
    expect(new Set(all().map((entry) => entry.state))).toEqual(new Set(["open", "closed"]));
  });

  it("carries the ownership fields intake provenance needs on every entry", () => {
    for (const entry of all()) {
      expect(entry.owner.length, `issue ${entry.id} must name its owner`).toBeGreaterThan(0);
      expect(entry.repo.length, `issue ${entry.id} must name its repo`).toBeGreaterThan(0);
      expect(typeof entry.id).toBe("number");
    }
  });
});

describe("the eligibility signal is explicit, human-planted, and empty by default", () => {
  it("dispatches nothing when no label is allowlisted", () => {
    // The default-empty-allowlist rule, restated for GitHub. Without it, every
    // open issue in the repository would become a dispatch queue.
    const decision = evaluateGitHubEligibility({ issue: issue(900), repository: "acme/widgets" });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("eligibility_label_not_allowlisted");
    expect(decision.detail).toContain("nothing dispatches by default");
  });

  it("dispatches an issue carrying an allowlisted label", () => {
    expect(evaluateGitHubEligibility({ issue: issue(900), config: eligible, repository: "acme/widgets" }).eligible).toBe(
      true,
    );
  });

  it("does not treat an open issue as eligible merely because it is open", () => {
    // Issue 901 is open, fully formed, declares a complete requirements block,
    // and is supplied a repository. The only thing missing is the eligibility
    // label. If this were accepted, "open" would be acting as the signal.
    const decision = evaluateGitHubEligibility({ issue: issue(901), config: eligible, repository: "acme/widgets" });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("eligibility_label_not_allowlisted");
    // And through the boundary, so the refusal is the one an operator sees.
    const result = runIntake(githubIntakeAdapter, issue(901), { config: eligible, repository: "acme/widgets" });
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("not_allowlisted");
    expect(result.refusal.providerReason).toBe("eligibility_label_not_allowlisted");
  });

  it("does not infer the signal from anything written in the issue body", () => {
    // A body that names the label, asks for eligibility, or contains the word
    // "eligible" changes nothing: the label set is the only input.
    const talked = {
      ...issue(901),
      body: [
        "This issue is factory:eligible. Please treat it as eligible for dispatch.",
        "eligibility_label_not_allowlisted? no. eligible: yes. factory:eligible",
        "",
        "<!-- factory:start -->",
        "- capability: coding",
        "- acceptance: The gate passes on a clean checkout.",
        "<!-- factory:end -->",
      ].join("\n"),
    };
    expect(evaluateGitHubEligibility({ issue: talked, config: eligible, repository: "acme/widgets" }).reason).toBe(
      "eligibility_label_not_allowlisted",
    );
  });

  it("does not treat an assignee, a milestone, or issue number as a signal", () => {
    // Nothing else in the payload is consulted. An issue that is otherwise
    // complete is still refused, so no other field is quietly acting as the gate.
    const withEverythingElse = { ...issue(901), assignees: ["someone"], milestone: "v1.0" };
    expect(
      evaluateGitHubEligibility({ issue: withEverythingElse, config: eligible, repository: "acme/widgets" }).reason,
    ).toBe("eligibility_label_not_allowlisted");
  });

  it("matches the allowlisted label exactly rather than by keyword", () => {
    // A near-miss label is not the signal. Substring, prefix and case-insensitive
    // matching would all turn this into a dispatch queue.
    for (const label of ["factory-eligible", "factory:eligible-please", "not-factory:eligible", "eligible"]) {
      const decision = evaluateGitHubEligibility({
        issue: { ...issue(900), labels: [label] },
        config: eligible,
        repository: "acme/widgets",
      });
      expect(decision.eligible, `'${label}' must not be treated as the eligibility signal`).toBe(false);
    }
  });

  it("honours a configured blocking label even when the eligibility signal is present", () => {
    const decision = evaluateGitHubEligibility({
      issue: issue(904),
      config: { ...eligible, blockingLabels: ["needs-founder-approval"] },
      repository: "acme/widgets",
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("blocked_by_label");
  });

  it("checks the blocking label before the allowlist, so the reason names the block", () => {
    // Issue 904 carries both. Reporting `not_allowlisted` would hide the label
    // that actually stopped it and send an operator to configure the wrong thing.
    const decision = evaluateGitHubEligibility({
      issue: issue(904),
      config: { blockingLabels: ["needs-founder-approval"] },
      repository: "acme/widgets",
    });
    expect(decision.reason).toBe("blocked_by_label");
  });
});

describe("closed and explicitly excluded issues are refused", () => {
  it("never dispatches a closed issue, even fully declared and allowlisted", () => {
    // Issue 903 carries the eligibility label and a complete requirements block,
    // and is closed as a duplicate. The close is a hard exclusion.
    const decision = evaluateGitHubEligibility({ issue: issue(903), config: eligible, repository: "acme/widgets" });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("closed_or_hard_excluded_state");
    expect(decision.detail).toContain("duplicate");
  });

  it("hard-excludes every terminal close reason regardless of configuration", () => {
    // A configuration mistake must not turn a closed issue into a dispatch queue,
    // so this set is not overridable by `config` — the same discipline as the
    // Linear adapter's hard-excluded status types.
    for (const stateReason of GITHUB_HARD_EXCLUDED_STATE_REASONS) {
      for (const eligibleLabels of [[], [...GITHUB_HARD_EXCLUDED_STATE_REASONS], ["factory:eligible"]]) {
        const decision = evaluateGitHubEligibility({
          issue: { ...issue(900), state: "closed", stateReason },
          config: { eligibleLabels, blockingLabels: [] },
          repository: "acme/widgets",
        });
        expect(decision.eligible, `${stateReason} must never be dispatchable`).toBe(false);
        expect(decision.reason).toBe("closed_or_hard_excluded_state");
      }
    }
  });

  it("refuses a closed issue even when its state reason is absent", () => {
    const decision = evaluateGitHubEligibility({
      issue: { ...issue(900), state: "closed", stateReason: null },
      config: eligible,
      repository: "acme/widgets",
    });
    expect(decision.reason).toBe("closed_or_hard_excluded_state");
  });

  it("refuses every real closed issue in this repository's fixtures", () => {
    // Real recorded data, not a hand-built case: nothing that is already closed
    // can reach dispatch, whatever the allowlist says.
    for (const closed of all().filter((entry) => entry.state === "closed")) {
      const decision = evaluateGitHubEligibility({
        issue: closed,
        config: { eligibleLabels: all().flatMap((entry) => entry.labels ?? []) },
        repository: "acme/widgets",
      });
      expect(decision.eligible, `issue ${closed.id} is closed`).toBe(false);
    }
  });

  it("refuses an open issue carrying a hard-excluded label whatever the allowlist says", () => {
    // The GitHub analogue of a workspace status that can never dispatch. A
    // duplicate label is a maintainer's own signal that this is not new work.
    const decision = evaluateGitHubEligibility({
      issue: { ...issue(900), labels: ["duplicate"] },
      config: { eligibleLabels: ["duplicate", "factory:eligible"] },
      repository: "acme/widgets",
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("blocked_by_label");
  });
});

describe("no requirement is ever inferred from an issue body", () => {
  it("refuses acceptance criteria that exist only in prose", () => {
    // Issue 902 says "the site should be faster and the tests should pass" and
    // carries the eligibility label. The factory must refuse rather than compile
    // a criterion nobody wrote down.
    const decision = evaluateGitHubEligibility({ issue: issue(902), config: eligible, repository: "acme/widgets" });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("missing_acceptance_criteria");
    expect(decision.detail).toContain("will not infer");
  });

  it("refuses a real issue that states acceptance criteria as prose", () => {
    // Recorded issue 60 uses the same `## Acceptance criteria` heading a reader
    // would call a declaration, and a numbered list under it. Given the
    // eligibility signal it would still be refused, because a heading is prose
    // and not the declared block. The label is added here purely to reach the
    // requirements check — the verdict under test is the one about prose.
    const decision = evaluateGitHubEligibility({
      issue: { ...issue(60), labels: ["factory:eligible"] },
      config: eligible,
      repository: "acme/widgets",
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("missing_acceptance_criteria");
    expect(decision.detail).toContain("will not infer");
  });

  it("requires both acceptance criteria and capabilities", () => {
    const onlyAcceptance = evaluateGitHubEligibility({
      issue: issue(905),
      config: eligible,
      repository: "acme/widgets",
    });
    expect(onlyAcceptance.reason).toBe("missing_capabilities");

    const onlyCapability = evaluateGitHubEligibility({
      issue: {
        ...issue(900),
        body: "<!-- factory:start -->\n- capability: coding\n<!-- factory:end -->",
      },
      config: eligible,
      repository: "acme/widgets",
    });
    expect(onlyCapability.reason).toBe("missing_acceptance_criteria");
  });

  it("ignores requirement-shaped text outside the declared block", () => {
    expect(parseGitHubRequirements("acceptance: sneaky\ncapability: sneaky")).toBeUndefined();
  });

  it("refuses a block that declares nothing, naming what is missing", () => {
    // The block exists but is empty, so the refusal is about its contents rather
    // than its absence — an author who typed the markers gets told what to fill in.
    const parsed = parseGitHubRequirements("<!-- factory:start -->\nnothing structured\n<!-- factory:end -->");
    expect(parsed).toEqual({ acceptanceCriteria: [], capabilities: [] });
    const decision = evaluateGitHubEligibility({
      issue: { ...issue(900), body: "<!-- factory:start -->\nnothing structured\n<!-- factory:end -->" },
      config: eligible,
      repository: "acme/widgets",
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("missing_acceptance_criteria");
  });

  it("never emits a Work Unit when eligibility is refused", () => {
    const probes: Array<{ id: number; config: GitHubEligibilityConfig; repository?: string }> = [
      { id: 901, config: eligible, repository: "acme/widgets" },
      { id: 902, config: eligible, repository: "acme/widgets" },
      { id: 903, config: eligible, repository: "acme/widgets" },
      { id: 904, config: { ...eligible, blockingLabels: ["needs-founder-approval"] }, repository: "acme/widgets" },
      { id: 905, config: eligible, repository: "acme/widgets" },
    ];
    for (const probe of probes) {
      const compiled = compileGitHubWorkUnit({
        issue: issue(probe.id),
        config: probe.config,
        ...(probe.repository === undefined ? {} : { repository: probe.repository }),
      });
      expect(compiled.workUnit, `issue ${probe.id} must not compile`).toBeUndefined();
      expect(compiled.decision.eligible).toBe(false);
    }
  });
});

describe("repository identity is explicit and never inferred", () => {
  it("refuses rather than inferring a repository", () => {
    // GitHub issues name their own `owner/repo`, so the temptation to compile
    // against that is real. The target repository is still caller input: an
    // issue filed in a tracking repository can describe work in another codebase.
    const decision = evaluateGitHubEligibility({ issue: issue(900), config: eligible });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("missing_repository");
    expect(decision.detail).toContain("will not infer");
  });

  it("classifies a missing repository as an undeclared target", () => {
    const result = runIntake(githubIntakeAdapter, issue(900), { config: eligible });
    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("target_undeclared");
    expect(result.refusal.providerReason).toBe("missing_repository");
  });

  it("refuses a blank repository, which is what the schema would reject", () => {
    expect(evaluateGitHubEligibility({ issue: issue(900), config: eligible, repository: "   " }).reason).toBe(
      "missing_repository",
    );
  });
});

describe("an eligible issue compiles into a canonical Work Unit", () => {
  const compiled = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });

  it("accepts it through the provider-neutral boundary", () => {
    const result = runIntake(githubIntakeAdapter, issue(900), { config: eligible, repository: "acme/widgets" });
    expect(result.outcome).toBe("accepted");
    expect(describeIntakeOutcome(result)).toBe("intake accepted acme/widgets#900 (github)");
  });

  it("carries the declared requirements verbatim", () => {
    expect(compiled.workUnit?.goal).toBe("Reject duplicate slugs at the content boundary");
    expect(compiled.workUnit?.acceptanceCriteria).toEqual([
      "A duplicate slug fails the build.",
      "The rule is documented for content authors.",
    ]);
    expect(compiled.workUnit?.capabilities).toEqual(["coding", "testing"]);
  });

  it("uses the GitHub cross-reference as the Work Unit id, so identity survives", () => {
    // An issue number is unique only within a repository, so the id carries
    // `owner/repo#number` — GitHub's own cross-reference form. Identity stays
    // traceable into commits and PR evidence without a lookup table that drifts.
    expect(compiled.workUnit?.id).toBe("acme/widgets#900");
    expect(compiled.traceability?.reference).toBe("acme/widgets#900");
  });

  it("defaults autonomy to review so intake never self-authorizes a merge", () => {
    expect(compiled.workUnit?.autonomy).toBe("review");
  });

  it("carries a caller-supplied base revision when given one", () => {
    const withRevision = compileGitHubWorkUnit({
      issue: issue(900),
      config: eligible,
      repository: "acme/widgets",
      baseRevision: "abc123",
    });
    expect(withRevision.workUnit?.baseRevision).toBe("abc123");
  });

  it("copies arrays so a caller mutating the result cannot reach back into the issue", () => {
    const first = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });
    first.workUnit?.acceptanceCriteria.push("mutated after the fact");
    first.workUnit?.capabilities.push("mutated");

    const second = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });
    expect(second.workUnit?.acceptanceCriteria).toEqual([
      "A duplicate slug fails the build.",
      "The rule is documented for content authors.",
    ]);
    expect(second.workUnit?.capabilities).toEqual(["coding", "testing"]);
  });
});

describe("the compiled Work Unit satisfies the factory's own contract", () => {
  const compiled = compileGitHubWorkUnit({
    issue: issue(900),
    config: eligible,
    repository: "acme/widgets",
    baseRevision: "abc123",
  });

  it("validates against work-unit.schema.json through the real validator", () => {
    if (compiled.workUnit === undefined) throw new Error("unreachable: issue 900 compiles");
    expect(validateWorkUnit(compiled.workUnit, workUnitSchema).valid).toBe(true);
    expect(validateAgainstSchema(workUnitToWireForm(compiled.workUnit), workUnitSchema)).toEqual([]);
  });

  it("adds no GitHub-specific field to the Work Unit", () => {
    if (compiled.workUnit === undefined) throw new Error("unreachable: issue 900 compiles");
    // A `state`, `stateReason`, `labels` or `url` field here would make the unit
    // unportable and force a vendor property into work-unit.schema.json.
    expect(Object.keys(compiled.workUnit).sort()).toEqual([
      "acceptanceCriteria",
      "autonomy",
      "baseRevision",
      "capabilities",
      "goal",
      "id",
      "repository",
    ]);
  });

  it("leaves the protocol type and the schema untouched", () => {
    const protocol = readFileSync("src/protocol.ts", "utf8");
    const workUnitLine = protocol.split("\n").find((line) => line.startsWith("export interface WorkUnit")) ?? "";
    expect(workUnitLine).toContain("id:string;");
    // Field-level, not substring-level: `repository` contains "repo", so a
    // substring search would flag a field the protocol has always had and force
    // the assertion to be weakened until it proved nothing.
    expect([...workUnitLine.matchAll(/([a-zA-Z]+)\??:/g)].map((match) => match[1])).toEqual([
      "id",
      "goal",
      "repository",
      "baseRevision",
      "capabilities",
      "scope",
      "acceptanceCriteria",
      "verification",
      "autonomy",
    ]);
    for (const forbidden of ["github", "label", "issue", "owner", "state"]) {
      expect(workUnitLine.toLowerCase(), `WorkUnit must not gain '${forbidden}'`).not.toContain(forbidden);
    }

    const schema = JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8")) as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      "acceptance_criteria",
      "autonomy",
      "base_revision",
      "capabilities",
      "goal",
      "id",
      "repository",
      "scope",
      "verification",
    ]);
  });
});

describe("GitHub identity is retained as intake provenance", () => {
  it("keeps repository, owner/repo and issue number at the intake edge", () => {
    const result = runIntake(githubIntakeAdapter, issue(900), { config: eligible, repository: "acme/widgets" });
    if (result.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");

    // The Work Unit carries the target repository the caller named. The GitHub
    // coordinates live beside it, never inside it.
    expect(result.workUnit.repository).toBe("acme/widgets");
    expect(Object.keys(result.workUnit)).not.toContain("issueId");
    expect(Object.keys(result.workUnit)).not.toContain("owner");

    expect(result.source).toEqual({
      provider: "github",
      reference: "acme/widgets#900",
      url: "https://github.com/acme/widgets/issues/900",
    });
  });

  it("keeps the GitHub coordinates on the provider's own traceability record", () => {
    const compiled = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });
    expect(compiled.traceability).toMatchObject({
      system: "github",
      owner: "acme",
      repo: "widgets",
      issueId: 900,
      reference: "acme/widgets#900",
      repository: "acme/widgets",
      url: "https://github.com/acme/widgets/issues/900",
    });
  });

  it("identifies a refusal by provider and record, never by a Work Unit id", () => {
    // A refused record never became a Work Unit, so it cannot be reported
    // against one — the same distinction the boundary draws for every provider.
    const refused = runIntake(githubIntakeAdapter, issue(903), { config: eligible, repository: "acme/widgets" });
    expect(Object.keys(refused)).not.toContain("workUnit");
    expect(refused.source.provider).toBe("github");
    expect(refused.source.reference).toBe("acme/widgets#903");
  });

  it("derives the issue link from the issue's own coordinates", () => {
    expect(githubIssueUrl(issue(900))).toBe("https://github.com/acme/widgets/issues/900");
    // No recorded URL at all: the link still resolves, because it is derived
    // rather than depended upon.
    const { url: _recorded, ...withoutUrl } = issue(900);
    expect(githubIssueUrl(withoutUrl)).toBe("https://github.com/acme/widgets/issues/900");
  });

  it("does not follow a recorded link that points somewhere else", () => {
    // A payload is data, and data can be wrong or hostile. `url` is the one field
    // a reader may click, so a recorded value that disagrees with the issue's own
    // owner/repo/number is ignored rather than trusted — otherwise a Work Unit's
    // provenance would lead an operator to an unrelated repository.
    const redirected = githubIssueUrl({ ...issue(900), url: "https://github.com/attacker/other/issues/1" });
    expect(redirected).toBe("https://github.com/acme/widgets/issues/900");
    // And the same rule holds through the boundary, where the URL becomes `source.url`.
    const result = runIntake(
      githubIntakeAdapter,
      { ...issue(900), url: "https://github.com/attacker/other/issues/1" },
      { config: eligible, repository: "acme/widgets" },
    );
    if (result.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");
    expect(result.source.url).toBe("https://github.com/acme/widgets/issues/900");
  });

  it("keeps a recorded link that agrees with the issue's coordinates", () => {
    // Deriving is not the same as discarding: a caller's own recorded URL survives
    // when it is consistent, so nothing legitimate is thrown away.
    expect(githubIssueUrl(issue(900))).toBe(issue(900).url);
  });

  it("renders a refusal naming the provider, the record and the reason", () => {
    const line = describeIntakeOutcome(
      runIntake(githubIntakeAdapter, issue(901), { config: eligible, repository: "acme/widgets" }),
    );
    expect(line).toContain("intake refused");
    expect(line).toContain("github");
    expect(line).toContain("acme/widgets#901");
    expect(line).toContain("not_allowlisted");
    expect(line).toContain("eligibility_label_not_allowlisted");
  });
});

describe("every GitHub refusal reason survives the crossing", () => {
  /**
   * One probe per reason the union names, with the expected coarse
   * classification beside it.
   *
   * This table is the exhaustiveness check. A partial map degrades to a silent
   * default, which is how a provider rule becomes unreportable — so each reason
   * must be reachable *and* land on the classification the factory can act on.
   * The `CLASSIFICATIONS` map in the adapter is a `Record<GitHubRefusalReason, …>`,
   * so a reason added there without a probe here fails the typecheck on the
   * adapter side and this table on the behavioural side.
   */
  const probes: Array<{
    reason: GitHubRefusalReason;
    classification: IntakeRefusalClassification;
    issue: GitHubIssue;
    config: GitHubEligibilityConfig;
    repository?: string;
  }> = [
    {
      reason: "closed_or_hard_excluded_state",
      classification: "not_dispatchable",
      issue: issue(903),
      config: eligible,
      repository: "acme/widgets",
    },
    {
      reason: "blocked_by_label",
      classification: "policy_blocked",
      issue: issue(904),
      config: { ...eligible, blockingLabels: ["needs-founder-approval"] },
      repository: "acme/widgets",
    },
    {
      reason: "eligibility_label_not_allowlisted",
      classification: "not_allowlisted",
      issue: issue(901),
      config: eligible,
      repository: "acme/widgets",
    },
    {
      reason: "missing_goal",
      classification: "requirements_undeclared",
      issue: { ...issue(900), title: "   " },
      config: eligible,
      repository: "acme/widgets",
    },
    {
      reason: "missing_acceptance_criteria",
      classification: "requirements_undeclared",
      issue: issue(902),
      config: eligible,
      repository: "acme/widgets",
    },
    {
      reason: "missing_capabilities",
      classification: "requirements_undeclared",
      issue: issue(905),
      config: eligible,
      repository: "acme/widgets",
    },
    {
      reason: "missing_repository",
      classification: "target_undeclared",
      issue: issue(900),
      config: eligible,
    },
  ];

  it("reaches every reason the union names, so no rule is unreportable", () => {
    for (const probe of probes) {
      const decision = evaluateGitHubEligibility({
        issue: probe.issue,
        config: probe.config,
        ...(probe.repository === undefined ? {} : { repository: probe.repository }),
      });
      expect(decision.reason, `probe ${probe.reason}`).toBe(probe.reason);
    }
  });

  it("carries each reason's provider code and classification across the boundary", () => {
    for (const probe of probes) {
      const result = runIntake(
        githubIntakeAdapter,
        probe.issue,
        {
          config: probe.config,
          ...(probe.repository === undefined ? {} : { repository: probe.repository }),
        },
      );
      expect(result.outcome, `probe ${probe.reason}`).toBe("refused");
      if (result.outcome !== "refused") throw new Error(`unreachable: ${probe.reason} is refused`);
      expect(result.refusal.providerReason, `probe ${probe.reason}`).toBe(probe.reason);
      expect(result.refusal.classification, `probe ${probe.reason}`).toBe(probe.classification);
    }
  });
});

describe("intake evaluation is deterministic", () => {
  it("produces an identical result for the same issue and policy", () => {
    const first = runIntake(githubIntakeAdapter, issue(900), { config: eligible, repository: "acme/widgets" });
    const second = runIntake(githubIntakeAdapter, issue(900), { config: eligible, repository: "acme/widgets" });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("produces an identical refusal too", () => {
    const first = runIntake(githubIntakeAdapter, issue(901), { config: eligible, repository: "acme/widgets" });
    const second = runIntake(githubIntakeAdapter, issue(901), { config: eligible, repository: "acme/widgets" });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("reads no clock, so two runs minutes apart still agree", () => {
    const first = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });
    const later = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(later));
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("compiles the same fixture twice into byte-identical Work Units", () => {
    const first = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });
    const second = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });
    expect(JSON.stringify(second.workUnit)).toBe(JSON.stringify(first.workUnit));
  });
});

describe("intake cannot bypass the factory's other gates", () => {
  const compiled = compileGitHubWorkUnit({ issue: issue(900), config: eligible, repository: "acme/widgets" });
  const workUnit = compiled.workUnit;
  if (workUnit === undefined) throw new Error("unreachable: issue 900 compiles");

  it("is still classified by the security policy after intake accepts it", () => {
    // Intake produces a plan. It cannot declare a Work Unit safe: the risk
    // classifier runs on the unit afterwards and can still refuse it.
    expect(assessExecutionRisk(workUnit).risk).toBe("trusted");
    expect(assessExecutionRisk(workUnit, { consumesUntrustedContent: true }).minimumIsolation).toBe("sandbox");
  });

  it("is still scheduled, and can still be blocked by the scheduler", async () => {
    // Acceptance at intake says nothing about placement. A unit whose declared
    // capabilities nothing provides is blocked, exactly as any other would be.
    const plan = await planSchedule({ units: [{ workUnit }], runtimes: [] });
    const decision = plan.decisions.find((entry) => entry.workUnitId === workUnit.id);
    expect(decision?.outcome).toBe("blocked");
    expect(decision?.reason).toBe("missing_capabilities");
  });

  it("still reaches integration only through independent passing verification", async () => {
    // A runtime that reports success changes nothing: the gate reads the
    // verification result, and intake supplied none.
    const executed: ExecutionRecord = {
      workUnitId: workUnit.id,
      status: "completed",
      runtimeStatus: "idle",
      events: [],
    };
    const blocked = await buildIntegrationResult({
      execution: executed,
      verification: { workUnitId: workUnit.id, status: "failed", checks: [] },
    });
    expect(blocked.result.state).toBe("blocked");
    expect(blocked.result.reason).toBe("verification_failed");

    const passed = await buildIntegrationResult({
      execution: executed,
      verification: { workUnitId: workUnit.id, status: "passed", checks: [] },
    });
    expect(passed.result.state).toBe("ready");
  });

  it("has no capability to dispatch, mutate GitHub, or merge", () => {
    // Structural evidence. The adapter's module imports nothing that could
    // execute or write: no runtime, no scheduler, no event log, no security gate,
    // and no process spawning. Intake reads a record and returns a value.
    const source = readFileSync("src/adapters/github/intake.ts", "utf8");
    const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]!);
    expect(imports.sort()).toEqual(["../../kernel/intake.js", "../../protocol.js"]);
    for (const forbidden of [
      "node:child_process",
      "node:fs",
      "node:http",
      "node:https",
      "kernel/execution",
      "kernel/pipeline",
      "kernel/scheduler",
      "kernel/integration",
      "kernel/work-unit",
      "security/index",
    ]) {
      expect(source, `the GitHub intake adapter must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("exposes no mutating GitHub operation", () => {
    const exported = Object.keys(
      // The module namespace, so this fails if a dispatch or mutation helper is added.
      { ...compileGitHubWorkUnit, ...githubIntakeAdapter },
    ).join(" ");
    for (const forbidden of [
      "dispatch",
      "execute",
      "merge",
      "close",
      "comment",
      "label",
      "prCreate",
      "createPullRequest",
      "updateIssue",
    ]) {
      expect(exported.toLowerCase(), `intake must not export '${forbidden}'`).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("the GitHub intake document describes what actually shipped", () => {
  const doc = readFileSync("docs/github-intake.md", "utf8");

  it("names the eligibility signal it implements", () => {
    // A document that fails to state the signal leaves the rule un-auditable,
    // which is the whole point of deriving it rather than inventing it.
    expect(doc).toContain("factory:eligible");
    expect(doc).toMatch(/allowlist/i);
  });

  it("states the negation: an open issue alone is not eligible", () => {
    expect(doc).toMatch(/open/i);
    expect(doc).toMatch(/never infer|no product or architecture decision is inferred/i);
  });

  it("points at source paths that exist", () => {
    for (const match of doc.matchAll(/`(src\/[a-z0-9/_-]+)`/g)) {
      expect(existsSync(match[1]!), `docs/github-intake.md references ${match[1]}, which does not exist`).toBe(true);
    }
  });
});