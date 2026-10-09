import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LinearEligibilityConfig, LinearIntakePolicy, LinearIssue } from "../src/adapters/linear/intake.js";
import {
  compileWorkUnit,
  HARD_EXCLUDED_STATUS_TYPES,
  LINEAR_REFUSAL_CLASSIFICATIONS,
  linearIntakeAdapter,
} from "../src/adapters/linear/intake.js";
import type { LinearPlanUnitExtras } from "../src/adapters/linear/plan.js";
import { buildLinearIntakePlan } from "../src/adapters/linear/plan.js";
import { readWorkUnitFile } from "../src/cli/args.js";
import type { IntakeRefusalClassification } from "../src/kernel/intake.js";
import { describeIntakeOutcome, runIntake } from "../src/kernel/intake.js";
import { validateAgainstSchema } from "../src/kernel/json-schema.js";
import { workUnitToWireForm } from "../src/kernel/work-unit.js";

/**
 * The shipped Linear adapter as a consumer of the provider-neutral intake
 * boundary (FCT-027).
 *
 * FCT-026 defined the boundary and proved it neutral by driving a deliberately
 * non-Linear provider through it. What it deliberately did not do is bind the
 * Linear rules to the boundary inside the Linear adapter — these tests cover
 * that binding, and the plan it makes inspectable.
 *
 * The FCT-018 semantics stay exactly where they were: `evaluateEligibility` and
 * `compileWorkUnit` are unchanged, and this file reaches them only through the
 * boundary. `tests/linear-intake.test.ts` remains the regression net for the
 * rules themselves.
 *
 * Everything here runs from `fixtures/linear/`, which holds recorded and
 * explicitly-marked synthetic payloads. No Linear credential is read, because
 * nothing here reads an environment variable at all.
 */

interface Fixture {
  issues: (LinearIssue & { shape: string; note?: string })[];
}

const fixtures: Fixture = JSON.parse(readFileSync("fixtures/linear/issues.json", "utf8")) as Fixture;
const schema = JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8")) as never;

const issue = (id: string): LinearIssue => {
  const found = fixtures.issues.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`fixture missing: ${id}`);
  return found;
};
const all = (): LinearIssue[] => fixtures.issues;

const eligible: LinearEligibilityConfig = { eligibleStatusTypes: ["started"], eligibleStatusNames: ["In Progress"] };

/** ENG-902's blocker, finished, so ENG-902 stops being dependency-gated. */
const blockerComplete = (): LinearIssue[] =>
  all().map((candidate) =>
    candidate.id === "ENG-903" ? { ...candidate, completedAt: "2026-10-05T10:00:00.000Z" } : candidate,
  );

/** The policy that accepts ENG-902 and refuses everything else it meets. */
const acceptingPolicy: LinearIntakePolicy = {
  config: eligible,
  knownIssues: blockerComplete(),
  repository: "acme/widgets",
};

describe("the Linear adapter conforms to the intake boundary", () => {
  it("compiles an eligible issue into a canonical Work Unit through the boundary", () => {
    const result = runIntake(linearIntakeAdapter, issue("ENG-902"), acceptingPolicy);

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");
    expect(result.workUnit.id).toBe("ENG-902");
    expect(result.workUnit.goal).toBe(issue("ENG-902").title);
    expect(result.workUnit.repository).toBe("acme/widgets");
  });

  it("records the Linear source beside the Work Unit, never inside it", () => {
    const result = runIntake(linearIntakeAdapter, issue("ENG-902"), acceptingPolicy);

    // Provider identity lives on `source`. A Linear field on the Work Unit would
    // make the unit unportable and would need a vendor field in the schema.
    expect(result.source.provider).toBe("linear");
    expect(result.source.reference).toBe("ENG-902");
    expect(result.source.url).toContain("ENG-902");
    if (result.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");
    expect(Object.keys(result.workUnit).sort()).toEqual([
      "acceptanceCriteria",
      "autonomy",
      "capabilities",
      "goal",
      "id",
      "repository",
    ]);
  });

  it("produces a schema-valid Work Unit through the factory's own validator", () => {
    const result = runIntake(linearIntakeAdapter, issue("ENG-902"), acceptingPolicy);
    if (result.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");

    // Projected to wire form first, the same way every other consumer does it, and
    // `work-unit.schema.json` has `additionalProperties: false` — so this is also
    // the check that no provider field leaked into the compiled unit.
    expect(validateAgainstSchema(workUnitToWireForm(result.workUnit), schema)).toEqual([]);
  });

  it("keeps autonomy at review, so crossing the boundary never authorizes a merge", () => {
    const result = runIntake(linearIntakeAdapter, issue("ENG-902"), acceptingPolicy);
    if (result.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");

    expect(result.workUnit.autonomy).toBe("review");
  });

  it("agrees with compileWorkUnit on the unit it produces, so there is one compiler", () => {
    const subject = issue("ENG-902");
    const { workUnit: direct } = compileWorkUnit({ ...acceptingPolicy, issue: subject });
    const result = runIntake(linearIntakeAdapter, subject, acceptingPolicy);
    if (result.outcome !== "accepted" || direct === undefined) {
      throw new Error("unreachable: ENG-902 is accepted by both paths");
    }

    // The binding must delegate rather than re-express compilation. A second
    // implementation would be free to drift from the rules `tests/linear-intake.test.ts`
    // pins down, and the two would then disagree about the same issue.
    expect(result.workUnit).toEqual(direct);
  });

  it("is deterministic for the same issue and policy", () => {
    const first = runIntake(linearIntakeAdapter, issue("ENG-902"), acceptingPolicy);
    const second = runIntake(linearIntakeAdapter, issue("ENG-902"), acceptingPolicy);

    // No clock, no randomness. A decision that changed between two identical runs
    // could not be reproduced to explain it.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("every FCT-018 refusal survives the crossing, named", () => {
  const refuse = (id: string, policy: LinearIntakePolicy): { classification: string; providerReason: string } => {
    const result = runIntake(linearIntakeAdapter, issue(id), policy);
    if (result.outcome !== "refused") throw new Error(`unreachable: ${id} is refused`);
    return { classification: result.refusal.classification, providerReason: result.refusal.providerReason };
  };

  it("dispatches nothing until a human allowlists a status", () => {
    // The default-empty allowlist, unchanged: ENG-905 is eligible, fully declared
    // and unblocked, and still refuses because no status was cleared for dispatch.
    expect(refuse("ENG-905", { repository: "acme/widgets" })).toEqual({
      classification: "not_allowlisted",
      providerReason: "status_not_eligible",
    });
  });

  it("still refuses a Backlog issue that declares everything", () => {
    // ENG-900 is Backlog *and* fully declared, so the refusal can only be the
    // status. This is what proves the hard exclusion is not the missing block.
    expect(refuse("ENG-900", { config: eligible })).toEqual({
      classification: "not_dispatchable",
      providerReason: "backlog_or_hard_excluded_status",
    });
  });

  it("still refuses prose acceptance criteria rather than inferring them", () => {
    // ENG-901 says the site "should be faster" in plain prose. That must never
    // become an acceptance criterion.
    expect(refuse("ENG-901", { config: eligible, repository: "acme/widgets" })).toEqual({
      classification: "requirements_undeclared",
      providerReason: "missing_acceptance_criteria",
    });
  });

  it("still refuses rather than inferring a repository", () => {
    // Linear carries no repository field, so a missing one is an input the
    // factory will not guess at.
    expect(refuse("ENG-902", { config: eligible, knownIssues: blockerComplete() })).toEqual({
      classification: "target_undeclared",
      providerReason: "missing_repository",
    });
  });

  it("still refuses an unfinished dependency and an unresolvable one", () => {
    expect(refuse("ENG-902", { ...acceptingPolicy, knownIssues: all() })).toEqual({
      classification: "dependency_incomplete",
      providerReason: "blocked_by_incomplete_issue",
    });
    expect(refuse("ENG-902", { ...acceptingPolicy, knownIssues: [] })).toEqual({
      classification: "dependency_unresolved",
      providerReason: "blocked_by_unknown_issue",
    });
  });

  it("still honours a blocking label over an eligible status", () => {
    expect(
      refuse("ENG-905", {
        config: { ...eligible, blockingLabels: ["needs-founder-approval"] },
        repository: "acme/widgets",
      }),
    ).toEqual({ classification: "policy_blocked", providerReason: "blocked_by_label" });
  });

  it("still refuses finished and canceled work", () => {
    const result = runIntake(
      linearIntakeAdapter,
      { ...issue("ENG-905"), canceledAt: "2026-10-05T09:00:00.000Z" },
      { config: eligible, repository: "acme/widgets" },
    );
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.providerReason).toBe("already_completed_or_canceled");
  });

  it("never dispatches a hard-excluded status, through the boundary", () => {
    for (const statusType of HARD_EXCLUDED_STATUS_TYPES) {
      const result = runIntake(
        linearIntakeAdapter,
        {
          id: "X-1",
          title: "probe",
          statusType,
          statusName: "Backlog",
          description: "<!-- factory:start -->\n- capability: coding\n- acceptance: a\n<!-- factory:end -->",
        },
        // The most permissive configuration a caller could possibly write.
        { config: { eligibleStatusTypes: [...HARD_EXCLUDED_STATUS_TYPES], eligibleStatusNames: ["Backlog"] }, repository: "acme/widgets" },
      );
      expect(result.outcome, `${statusType} must never be accepted`).toBe("refused");
    }
  });

  it("classifies every Linear refusal reason, so no rule becomes unreportable", () => {
    // Typed as `Record<RefusalReason, ...>` so adding a reason to the adapter
    // fails the build until it is classified here. A partial map would degrade to
    // a silent default, which is how a provider rule stops explaining itself.
    const classified: Record<string, IntakeRefusalClassification> = LINEAR_REFUSAL_CLASSIFICATIONS;
    expect(Object.keys(classified).sort()).toEqual([
      "already_completed_or_canceled",
      "backlog_or_hard_excluded_status",
      "blocked_by_incomplete_issue",
      "blocked_by_label",
      "blocked_by_unknown_issue",
      "missing_acceptance_criteria",
      "missing_capabilities",
      "missing_goal",
      "missing_repository",
      "status_not_eligible",
    ]);
  });
});

describe("intake refusal stays distinct from scheduler refusal", () => {
  /**
   * `work run` once printed "intake refused" while reading `planSchedule`
   * decisions. The two are about different subjects: the scheduler judges a Work
   * Unit that already exists, intake judges a provider record that may never
   * become one. So an intake refusal is keyed by provider and reference and
   * carries no `workUnitId` — the field a scheduling decision is keyed by.
   */
  it("identifies an intake refusal by provider and record, never by Work Unit id", () => {
    const plan = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy });
    const refusal = plan.refusals.find((entry) => entry.source.reference === "ENG-900");
    if (refusal === undefined) throw new Error("unreachable: ENG-900 is refused");

    expect(Object.keys(refusal)).not.toContain("workUnitId");
    expect(refusal.source.provider).toBe("linear");
    expect(refusal.source.reference).toBe("ENG-900");
    expect(refusal.refusal.providerReason).toBe("backlog_or_hard_excluded_status");
  });

  it("renders an intake refusal with the intake prefix, never as a scheduler block", () => {
    const plan = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy });
    const refusal = plan.refusals.find((entry) => entry.source.reference === "ENG-900");
    if (refusal === undefined) throw new Error("unreachable: ENG-900 is refused");

    const line = refusal.message;
    expect(line).toBe(describeIntakeOutcome(runIntake(linearIntakeAdapter, issue("ENG-900"), acceptingPolicy)));
    expect(line).toContain("intake refused");
    expect(line).toContain("ENG-900");
    expect(line).toContain("linear");
    // The scheduler's wording, so the two can never be read as one report.
    expect(line).not.toContain("blocked");
  });

  it("never carries a refusal's classification in the scheduler's vocabulary", () => {
    // `DecisionOutcome` in `src/kernel/scheduler.ts` is "scheduled" | "blocked".
    // The plan reports "accepted" | "refused" and adds no third state, so a
    // consumer cannot be handed an intake outcome by reading a scheduling field.
    const plan = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy });
    expect(Object.keys(plan).sort()).toEqual(["refusals", "units"]);
    for (const entry of plan.refusals) expect(entry.outcome).toBe("refused");
    for (const unit of plan.units) expect(Object.keys(unit)).toContain("workUnit");
  });
});

describe("intake produces an inspectable plan and never dispatches", () => {
  it("plans only the accepted issues and refuses the rest", () => {
    const plan = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy });

    // ENG-903 is planned as itself, not as the blocker of ENG-902: `knownIssues`
    // carries a finished copy to resolve `blockedBy` against, while the record
    // under evaluation is the one the caller supplied. ENG-905 is eligible,
    // fully declared and unblocked. Everything else is refused for a reason of
    // its own — ENG-904 and ENG-91 because they are finished, ENG-89 and ENG-900
    // because they are Backlog, ENG-901 because its criteria are prose, ENG-95
    // because it declares nothing.
    expect(plan.units.map((unit) => unit.workUnit["id"])).toEqual(["ENG-902", "ENG-903", "ENG-905"]);
    expect(plan.refusals.map((entry) => entry.source.reference).sort()).toEqual([
      "ENG-89",
      "ENG-900",
      "ENG-901",
      "ENG-904",
      "ENG-91",
      "ENG-95",
    ]);
  });

  it("emits the exact plan shape `factory work run --work-units` already parses", () => {
    // Round-tripped through the real reader rather than a local copy of it: if
    // the plan shape drifted from `readWorkUnitFile`, this read would throw.
    const plan = buildLinearIntakePlan({
      issues: all(),
      policy: acceptingPolicy,
      extras: { "ENG-902": { paths: ["src/slug"], contracts: ["content-schema"] } },
    });
    const file = join(mkdtempSync(join(tmpdir(), "factory-intake-")), "plan.json");
    writeFileSync(file, JSON.stringify(plan.units, null, 2));

    const parsed = readWorkUnitFile(file);
    expect(parsed.map((unit) => unit.workUnit.id)).toEqual(["ENG-902", "ENG-903", "ENG-905"]);
    expect(parsed[0]?.paths).toEqual(["src/slug"]);
    expect(parsed[0]?.contracts).toEqual(["content-schema"]);
    // Scheduling facts travel beside the Work Unit, not inside it.
    expect(parsed[0]?.workUnit.repository).toBe("acme/widgets");
  });

  it("declares no dependency the issue did not state", () => {
    // ENG-902 is `blockedBy: ["ENG-903"]`. That relation gated eligibility, but
    // the blocker is finished, so turning it into a plan `dependsOn` would ask
    // the scheduler for work that is already done. Intake states what it was
    // told; it does not add scheduling structure.
    const plan = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy });

    expect(plan.units[0]).toEqual({ workUnit: expect.objectContaining({ id: "ENG-902" }) });
    expect(plan.units[0]?.dependsOn).toBeUndefined();
    expect(plan.units[0]?.paths).toBeUndefined();
  });

  it("carries caller-declared plan facts verbatim", () => {
    const extras: LinearPlanUnitExtras = {
      dependsOn: ["ENG-904"],
      paths: ["src/slug", "tests/slug.test.ts"],
      contracts: ["content-schema"],
      runtimes: ["opencode"],
      protectedResources: ["main"],
    };
    const plan = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy, extras: { "ENG-902": extras } });

    expect(plan.units[0]?.dependsOn).toEqual(["ENG-904"]);
    expect(plan.units[0]?.paths).toEqual(["src/slug", "tests/slug.test.ts"]);
    expect(plan.units[0]?.contracts).toEqual(["content-schema"]);
    expect(plan.units[0]?.runtimes).toEqual(["opencode"]);
    expect(plan.units[0]?.protectedResources).toEqual(["main"]);
  });

  it("produces an identical plan for the same issues and policy", () => {
    const first = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy });
    const second = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy });

    // The plan is a document a human reviews before anything runs, so it has to
    // be reproducible: re-running intake must not rewrite what a reviewer agreed to.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("plans nothing at all when no status is allowlisted", () => {
    const plan = buildLinearIntakePlan({ issues: all(), policy: { repository: "acme/widgets" } });

    expect(plan.units).toEqual([]);
    expect(plan.refusals.length).toBe(all().length);
    // The hard exclusions still report as hard exclusions: removing the
    // allowlist does not promote Backlog into a dispatch queue.
    const byReason = new Map(plan.refusals.map((entry) => [entry.source.reference, entry.refusal.classification]));
    expect(byReason.get("ENG-905")).toBe("not_allowlisted");
    expect(byReason.get("ENG-900")).toBe("not_dispatchable");
    expect(byReason.get("ENG-904")).toBe("not_dispatchable");
  });

  it("never proposes a Linear status transition, so no issue can be moved to done", () => {
    const plan = buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy });

    // Status reflection is a separate, human-acknowledged path in `status.ts`,
    // where `done` needs an explicit human. A plan that could carry a transition
    // would be a route to marking an issue done without anyone asking — so the
    // whole plan is checked for one rather than a single field.
    expect(JSON.stringify(plan)).not.toContain("integration.status_proposed");
    expect(JSON.stringify(plan)).not.toContain('"to":"done"');
    for (const entry of plan.refusals) expect(Object.keys(entry).sort()).toEqual(["message", "outcome", "refusal", "source"]);
    for (const unit of plan.units) expect(unit.workUnit).not.toHaveProperty("status");
  });
});

describe("intake runs with no Linear credentials", () => {
  it("produces the same plan whether or not a Linear credential is present", () => {
    const names = ["LINEAR_API_KEY", "LINEAR_TOKEN", "LINEAR_TEAM_ID"];
    const saved = names.map((name) => process.env[name]);
    for (const name of names) delete process.env[name];
    let withoutCredential: string;
    try {
      withoutCredential = JSON.stringify(buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy }));
    } finally {
      for (const [index, name] of names.entries()) {
        const value = saved[index];
        if (value !== undefined) process.env[name] = value;
      }
    }

    process.env["LINEAR_API_KEY"] = "lin_api_synthetic_not_a_real_credential";
    let withCredential: string;
    try {
      withCredential = JSON.stringify(buildLinearIntakePlan({ issues: all(), policy: acceptingPolicy }));
    } finally {
      delete process.env["LINEAR_API_KEY"];
    }

    // Intake reads fixtures and the caller's policy, nothing else. If it ever
    // started consulting a credential, this comparison would be the first thing
    // to fail in CI, which has no Linear auth.
    expect(withCredential).toBe(withoutCredential);
  });

  it("keeps synthetic fixtures explicitly marked", () => {
    const synthetic = fixtures.issues.filter((entry) => entry.shape === "synthetic");

    expect(synthetic.length).toBeGreaterThan(0);
    for (const entry of synthetic) expect(entry.note, `${entry.id} must carry a note`).toBeDefined();
  });
});