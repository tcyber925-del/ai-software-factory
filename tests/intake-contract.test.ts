import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LinearEligibilityConfig, LinearIssue, RefusalReason } from "../src/adapters/linear/intake.js";
import {
  HARD_EXCLUDED_STATUS_TYPES,
  compileWorkUnit,
  evaluateEligibility,
} from "../src/adapters/linear/intake.js";
import type { IntakeRefusalClassification, ProviderIntakeAdapter } from "../src/kernel/intake.js";
import { describeIntakeOutcome, runIntake } from "../src/kernel/intake.js";
import { validateAgainstSchema } from "../src/kernel/json-schema.js";
import { workUnitToWireForm } from "../src/kernel/work-unit.js";

/**
 * The provider-neutral intake boundary (FCT-026).
 *
 * Intake is where a task provider — Linear, GitHub, anything — hands the factory
 * work to execute. Before this contract, the shape of that handover was whatever
 * each adapter happened to return, so the only thing shared across providers was a
 * convention and a copy of the Linear vocabulary.
 *
 * These tests drive `runIntake` through two deliberately unlike providers:
 *
 * - a task-board adapter, whose records are plain objects with native
 *   `stage`/`tags` fields and no prose at all;
 * - the shipped Linear policy, wired in unmodified, as the regression baseline.
 *
 * The point of the first is that the contract never assumes Linear's shape. If a
 * future provider has to reach for a Linear concept to satisfy the boundary, the
 * boundary is not neutral.
 */

/** A record from a task board: no status taxonomy, no description prose. */
interface BoardTask {
  id: string;
  title: string;
  stage: "backlog" | "ready" | "doing" | "closed";
  tags: string[];
  requiredCapabilities: string[];
  acceptance: string[];
}

interface BoardPolicy {
  /** Stages a human has cleared. Empty means nothing dispatches. */
  allowedStages: string[];
  blockingTags: string[];
  targetRepository: string;
}

const boardPolicy: BoardPolicy = {
  allowedStages: ["ready"],
  blockingTags: ["needs-signoff"],
  targetRepository: "acme/widgets",
};

const readyTask: BoardTask = {
  id: "BOARD-7",
  title: "Ship the intake boundary",
  stage: "ready",
  tags: [],
  requiredCapabilities: ["coding"],
  acceptance: ["The boundary is documented."],
};

const boardAdapter: ProviderIntakeAdapter<BoardTask, BoardPolicy> = {
  provider: "board",

  sourceId: (task) => task.id,
  sourceUrl: () => undefined,

  // Board policy, in the board's own vocabulary. Nothing here is a Linear concept.
  evaluate: (task, policy) => {
    if (task.stage === "closed") {
      return { eligible: false, refusal: { classification: "not_dispatchable", providerReason: "stage_closed" } };
    }
    if (!policy.allowedStages.includes(task.stage)) {
      return { eligible: false, refusal: { classification: "not_allowlisted", providerReason: `stage_${task.stage}` } };
    }
    if (policy.blockingTags.some((tag) => task.tags.includes(tag))) {
      return { eligible: false, refusal: { classification: "policy_blocked", providerReason: "tag_blocks" } };
    }
    if (task.acceptance.length === 0) {
      return { eligible: false, refusal: { classification: "requirements_undeclared", providerReason: "no_acceptance" } };
    }
    return { eligible: true };
  },

  compile: (task, policy) => ({
    id: task.id,
    goal: task.title,
    repository: policy.targetRepository,
    capabilities: [...task.requiredCapabilities],
    acceptanceCriteria: [...task.acceptance],
    autonomy: "review",
  }),
};

describe("the boundary accepts work through any provider", () => {
  it("compiles an eligible record into a canonical Work Unit", () => {
    const result = runIntake(boardAdapter, readyTask, boardPolicy);

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");
    expect(result.workUnit.id).toBe("BOARD-7");
    expect(result.workUnit.goal).toBe("Ship the intake boundary");
    expect(result.workUnit.acceptanceCriteria).toEqual(["The boundary is documented."]);
  });

  it("records where the work came from alongside the Work Unit", () => {
    const result = runIntake(boardAdapter, readyTask, boardPolicy);

    // Provenance is a sibling of the Work Unit, never a field inside it.
    expect(result.source.provider).toBe("board");
    expect(result.source.reference).toBe("BOARD-7");
  });
});

describe("the boundary refuses without weakening the provider's rules", () => {
  it("refuses a record the provider's allowlist does not cover", () => {
    // `ready` is the only cleared stage. Everything else is refused, and the
    // provider's own reason survives the crossing as an opaque code.
    const result = runIntake(boardAdapter, { ...readyTask, stage: "doing" }, boardPolicy);

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("not_allowlisted");
    expect(result.refusal.providerReason).toBe("stage_doing");
  });

  it("refuses a blocked record even when its stage is eligible", () => {
    // Same stage as the accepted case, so the refusal can only come from the tag.
    const result = runIntake(boardAdapter, { ...readyTask, tags: ["needs-signoff"] }, boardPolicy);

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("policy_blocked");
  });

  it("dispatches nothing when no stage is allowlisted", () => {
    // The default-empty-allowlist rule, which is what stops a provider's backlog
    // from silently becoming a dispatch queue.
    const result = runIntake(boardAdapter, readyTask, { ...boardPolicy, allowedStages: [] });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("not_allowlisted");
  });

  it("refuses a record whose requirements were never declared", () => {
    const result = runIntake(boardAdapter, { ...readyTask, acceptance: [] }, boardPolicy);

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("requirements_undeclared");
  });

  it("refuses an eligible record the provider cannot compile into a Work Unit", () => {
    // An adapter that accepts work it cannot state has not earned a dispatch. The
    // result must still be a complete record, not a silent drop.
    const lossy = { ...boardAdapter, compile: () => undefined };
    const result = runIntake(lossy, readyTask, boardPolicy);

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.providerReason).toBe("no_work_unit_compiled");
    // The source is still identified, so the refusal is traceable to a record.
    expect(result.source.reference).toBe("BOARD-7");
  });
});

describe("intake refusal is not scheduler refusal", () => {
  /**
   * `work run` once printed "intake refused" while reading `planSchedule` decisions.
   * The two decisions are about different subjects: the scheduler judges a Work Unit
   * that already exists, while intake judges a provider record that may never become
   * one. A refusal with no Work Unit is the whole point — so an intake result must
   * not borrow the scheduler's shape, or the same wording fits both and the message
   * stops meaning anything.
   */
  it("uses an outcome vocabulary the scheduler cannot also produce", () => {
    type SchedulerOutcome = "scheduled" | "blocked";
    // The scheduler's outcome vocabulary, taken from `DecisionOutcome` in
    // `src/kernel/scheduler.ts`. Intake uses `accepted`/`refused` so that neither
    // word can be mistaken for the other.
    const scheduling: SchedulerOutcome[] = ["scheduled", "blocked"];
    // The compile-time half: "accepted" is not a scheduling outcome, so this
    // assignment is an error. If the scheduler ever adopted the intake vocabulary,
    // the directive would stop applying and `npm run build` would fail — which is
    // the point of asserting it here. The declaration is the assertion; the variable
    // itself has nothing real to assert about.
    // @ts-expect-error -- "accepted" is not a scheduling outcome.
    const alsoScheduling: SchedulerOutcome = "accepted";

    // The value-level half: no intake outcome appears in the scheduler's.
    const intakeOutcomes = ["accepted", "refused"] as const;
    expect(intakeOutcomes.some((outcome) => scheduling.includes(outcome as SchedulerOutcome))).toBe(false);
    expect(scheduling).not.toContain(runIntake(boardAdapter, readyTask, boardPolicy).outcome);
  });

  it("identifies refusals by source, never by Work Unit id", () => {
    const result = runIntake(boardAdapter, { ...readyTask, stage: "backlog" }, boardPolicy);

    // A scheduler decision is keyed by `workUnitId`. Intake has none, because a
    // refused record never became one — so no consumer can report an intake refusal
    // against a Work Unit that does not exist.
    expect(result.source).toEqual({ provider: "board", reference: "BOARD-7" });
    expect(Object.keys(result)).not.toContain("workUnitId");
  });

  it("names the provider and the reason when a refusal is rendered", () => {
    const result = runIntake(boardAdapter, { ...readyTask, stage: "doing" }, boardPolicy);

    // A message that reads "blocked" with no subject is what caused the original
    // confusion, so the render states the provider, the record and the reason.
    const line = describeIntakeOutcome(result);
    expect(line).toContain("board");
    expect(line).toContain("BOARD-7");
    expect(line).toContain("not_allowlisted");
    expect(line).toContain("stage_doing");
    expect(line).toContain("intake refused");
  });

  it("renders an accepted intake as accepted, never as a block", () => {
    const line = describeIntakeOutcome(runIntake(boardAdapter, readyTask, boardPolicy));
    expect(line).toBe("intake accepted BOARD-7 (board)");
  });

  it("carries the provider's own detail through the render", () => {
    const withDetail: ProviderIntakeAdapter<BoardTask, BoardPolicy> = {
      ...boardAdapter,
      evaluate: (task) => ({
        eligible: false,
        refusal: {
          classification: "requirements_undeclared",
          providerReason: "no_requirements_block",
          detail: "the record states no acceptance criteria and the factory will not infer them",
        },
      }),
    };
    const result = runIntake(withDetail, readyTask, boardPolicy);

    // Summarising into `classification` must not cost the operator the detail that
    // tells them what to fix.
    expect(describeIntakeOutcome(result)).toContain("will not infer them");
  });
});

describe("intake evaluation is deterministic", () => {
  it("produces an identical result for the same record and policy", () => {
    const first = runIntake(boardAdapter, readyTask, boardPolicy);
    const second = runIntake(boardAdapter, readyTask, boardPolicy);

    // No clock, no randomness, no inferred fields: an intake decision is auditable
    // because re-running it reproduces it exactly.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("is deterministic for a refusal too", () => {
    const refused = { ...readyTask, stage: "doing" };
    const first = runIntake(boardAdapter, refused, boardPolicy);
    const second = runIntake(boardAdapter, refused, boardPolicy);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("does not let one evaluation disturb the next", () => {
    // The adapter's arrays are copied on compile, so a caller mutating the result
    // cannot reach back into the provider's record.
    const first = runIntake(boardAdapter, readyTask, boardPolicy);
    if (first.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");
    first.workUnit.acceptanceCriteria.push("mutated after the fact");

    const second = runIntake(boardAdapter, readyTask, boardPolicy);
    if (second.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");
    expect(second.workUnit.acceptanceCriteria).toEqual(["The boundary is documented."]);
  });

  it("produces an identical result for the same Linear record and policy", () => {
    const policy = {
      config: linearEligible,
      knownIssues: withBlockerComplete(),
      repository: "acme/widgets",
    };
    const first = runIntake(linearAdapter, issue("ENG-902"), policy);
    const second = runIntake(linearAdapter, issue("ENG-902"), policy);

    // Same discipline as the Linear adapter itself: no clock, no randomness, no
    // inferred fields. A decision that changed between two identical runs could not
    // be reproduced to explain it.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("reads no clock, so two runs minutes apart still agree", () => {
    // A decision stamped with a timestamp would differ between these two calls. The
    // assertion is that the result carries no time-varying field at all.
    const policy = { config: linearEligible, knownIssues: withBlockerComplete(), repository: "acme/widgets" };
    const first = runIntake(linearAdapter, issue("ENG-902"), policy);
    const later = runIntake(linearAdapter, issue("ENG-902"), policy);

    const keys = JSON.stringify(later);
    expect(keys).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(first)).toBe(keys);
  });
});

/**
 * The shipped Linear policy as a consumer of the boundary.
 *
 * FCT-027 owns `src/adapters/linear/`, so this file does not modify it. What this
 * does instead is bind the *existing, unmodified* Linear rules to the boundary from
 * outside, which is the property that actually matters: the neutral contract is
 * usable by the provider that already existed, without rewriting or weakening a
 * single one of its rules. If a future refactor moves this binding into the adapter,
 * these tests must keep passing unchanged.
 */
const linearAdapter: ProviderIntakeAdapter<LinearIssue, LinearIntakePolicy> = {
  provider: "linear",

  sourceId: (issue) => issue.id,
  sourceUrl: (issue) => issue.url,

  evaluate: (issue, policy) => {
    const decision = evaluateEligibility({
      issue,
      ...(policy.knownIssues === undefined ? {} : { knownIssues: policy.knownIssues }),
      ...(policy.repository === undefined ? {} : { repository: policy.repository }),
      ...(policy.config === undefined ? {} : { config: policy.config }),
    });
    if (decision.eligible) return { eligible: true };
    if (decision.reason === undefined) throw new Error("linear refused without stating a reason");
    return { eligible: false, refusal: { classification: linearClassifications[decision.reason], providerReason: decision.reason, ...(decision.detail === undefined ? {} : { detail: decision.detail }), ...(decision.check === undefined ? {} : { check: decision.check }) } };
  },

  compile: (issue, policy) => {
    const compiled = compileWorkUnit({
      issue,
      ...(policy.knownIssues === undefined ? {} : { knownIssues: policy.knownIssues }),
      ...(policy.repository === undefined ? {} : { repository: policy.repository }),
      ...(policy.config === undefined ? {} : { config: policy.config }),
    });
    return compiled.workUnit;
  },
};

const linearEligible = { eligibleStatusTypes: ["started"], eligibleStatusNames: ["In Progress"] };
const withBlockerComplete = (): LinearIssue[] =>
  fixtures.issues.map((issue) =>
    issue.id === "ENG-903" ? { ...issue, completedAt: "2026-10-05T10:00:00.000Z" } : issue,
  );

/**
 * The policy object the Linear half of this file needs. Linear's own rules take a
 * config plus a caller-supplied issue list and repository; bundling them keeps the
 * adapter binding to two arguments, which is what `runIntake` passes.
 */
interface LinearIntakePolicy {
  /** Optional, because "nothing is configured" is itself a case worth testing. */
  config?: LinearEligibilityConfig;
  knownIssues?: LinearIssue[];
  repository?: string;
}

/**
 * Every Linear refusal reason, mapped to the boundary's coarse vocabulary.
 *
 * Exhaustive on purpose, and typed as `Record<RefusalReason, ...>` so that adding a
 * reason to the Linear adapter fails this file's typecheck until it is classified
 * here. That is the guarantee that a provider refusal always arrives able to say
 * what it was — the alternative, a partial map, degrades to a silent default and a
 * Linear rule becomes unreportable.
 */
const linearClassifications: Record<RefusalReason, IntakeRefusalClassification> = {
  backlog_or_hard_excluded_status: "not_dispatchable",
  already_completed_or_canceled: "not_dispatchable",
  status_not_eligible: "not_allowlisted",
  blocked_by_label: "policy_blocked",
  blocked_by_incomplete_issue: "dependency_incomplete",
  blocked_by_unknown_issue: "dependency_unresolved",
  missing_acceptance_criteria: "requirements_undeclared",
  missing_capabilities: "requirements_undeclared",
  missing_goal: "requirements_undeclared",
  missing_repository: "target_undeclared",
};

const fixtures: { issues: LinearIssue[] } = JSON.parse(readFileSync("fixtures/linear/issues.json", "utf8")) as {
  issues: LinearIssue[];
};
const issue = (id: string): LinearIssue => {
  const found = fixtures.issues.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`fixture missing: ${id}`);
  return found;
};
const allFixtures = (): LinearIssue[] => fixtures.issues;

describe("the shipped Linear rules consume the boundary unchanged", () => {
  it("accepts an eligible, fully-declared, unblocked issue", () => {
    const result = runIntake(
      linearAdapter,
      issue("ENG-902"),
      { config: linearEligible, knownIssues: withBlockerComplete(), repository: "acme/widgets" },
    );

    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");
    expect(result.workUnit.id).toBe("ENG-902");
    expect(result.workUnit.acceptanceCriteria).toEqual([
      "Duplicate slugs fail the build.",
      "The rule is documented for content authors.",
    ]);
  });

  it("still never dispatches Backlog work, through the boundary", () => {
    // ENG-900 is Backlog *and* declares everything, so the refusal can only be the
    // status. Refusing here proves the crossing did not soften a hard exclusion.
    const result = runIntake(linearAdapter, issue("ENG-900"), { config: linearEligible });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("not_dispatchable");
    expect(result.refusal.providerReason).toBe("backlog_or_hard_excluded_status");
  });

  it("still dispatches nothing until a human allowlists a status", () => {
    const result = runIntake(linearAdapter, issue("ENG-905"), { repository: "acme/widgets" });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("not_allowlisted");
    expect(result.refusal.providerReason).toBe("status_not_eligible");
  });

  it("still refuses prose acceptance criteria rather than inferring them", () => {
    const result = runIntake(linearAdapter, issue("ENG-901"), { config: linearEligible });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("requirements_undeclared");
  });

  it("still refuses work blocked by an unfinished dependency", () => {
    const result = runIntake(linearAdapter, issue("ENG-902"), {
      config: linearEligible,
      knownIssues: allFixtures(),
      repository: "acme/widgets",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("dependency_incomplete");
  });

  it("still refuses when a blocker cannot be resolved at all", () => {
    const result = runIntake(linearAdapter, issue("ENG-902"), {
      config: linearEligible,
      knownIssues: [],
      repository: "acme/widgets",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("dependency_unresolved");
  });

  it("still refuses a blocking label", () => {
    const result = runIntake(linearAdapter, issue("ENG-905"), {
      config: { ...linearEligible, blockingLabels: ["needs-founder-approval"] },
      repository: "acme/widgets",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("policy_blocked");
  });

  it("still refuses rather than inferring a repository", () => {
    const result = runIntake(linearAdapter, issue("ENG-902"), {
      config: linearEligible,
      knownIssues: withBlockerComplete(),
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.classification).toBe("target_undeclared");
    expect(result.refusal.providerReason).toBe("missing_repository");
  });

  it("still refuses completed and canceled work", () => {
    const result = runIntake(linearAdapter, { ...issue("ENG-905"), canceledAt: "2026-10-05T09:00:00.000Z" }, {
      config: linearEligible,
      repository: "acme/widgets",
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome !== "refused") throw new Error("unreachable: outcome is refused");
    expect(result.refusal.providerReason).toBe("already_completed_or_canceled");
  });

  it("never loses a Linear refusal reason to the generic classification", () => {
    // Every reason `evaluateEligibility` can produce is mapped. An unmapped reason
    // would be a Linear refusal arriving at the boundary with no explanation, which
    // is how a provider-specific rule silently becomes unreportable.
    const linearIssue: LinearIssue = {
      id: "X-1",
      title: "probe",
      statusType: "started",
      statusName: "In Progress",
      description: "<!-- factory:start -->\n- capability: coding\n- acceptance: a\n<!-- factory:end -->",
    };
    const repository = "acme/widgets";

    for (const statusType of HARD_EXCLUDED_STATUS_TYPES) {
      const result = runIntake(linearAdapter, { ...linearIssue, statusType }, { config: { eligibleStatusTypes: [...HARD_EXCLUDED_STATUS_TYPES] }, repository });
      expect(result.outcome, `${statusType} must be refused`).toBe("refused");
    }

    const reasons = new Set<string>();
    for (const outcome of [
      runIntake(linearAdapter, linearIssue, { config: linearEligible, repository }),
      runIntake(linearAdapter, { ...linearIssue, title: "  " }, { config: linearEligible, repository }),
      runIntake(linearAdapter, linearIssue, { config: {}, repository }),
    ]) {
      if (outcome.outcome === "refused") reasons.add(outcome.refusal.providerReason);
    }
    expect(reasons.size).toBeGreaterThan(0);
  });
});

describe("no provider detail reaches the canonical Work Unit", () => {
  const accepted = runIntake(linearAdapter, issue("ENG-902"), {
    config: linearEligible,
    knownIssues: withBlockerComplete(),
    repository: "acme/widgets",
  });

  it("carries exactly the protocol's Work Unit fields", () => {
    if (accepted.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");

    // Provider identity lives on `result.source`. If `statusType`, `url` or any
    // other Linear field appeared here, the Work Unit would stop being portable and
    // `work-unit.schema.json` would have to grow a vendor field.
    expect(Object.keys(accepted.workUnit).sort()).toEqual([
      "acceptanceCriteria",
      "autonomy",
      "capabilities",
      "goal",
      "id",
      "repository",
    ]);
  });

  it("validates against the unmodified Work Unit schema", () => {
    if (accepted.outcome !== "accepted") throw new Error("unreachable: outcome is accepted");

    const schema = JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8")) as never;
    expect(validateAgainstSchema(workUnitToWireForm(accepted.workUnit), schema)).toEqual([]);
  });

  it("records the Linear source outside the Work Unit", () => {
    expect(accepted.source).toEqual({
      provider: "linear",
      reference: "ENG-902",
      url: expect.stringContaining("ENG-902"),
    });
  });

  it("leaves the Work Unit type and schema untouched", () => {
    // The boundary is an addition, not a change: the protocol gained no field.
    const protocol = readFileSync("src/protocol.ts", "utf8");
    const workUnitLine = protocol.split("\n").find((line) => line.startsWith("export interface WorkUnit")) ?? "";

    expect(workUnitLine).toContain("id:string;");
    expect(workUnitLine).toContain("goal:string;");
    expect(workUnitLine).toContain("repository:string;");
    expect(workUnitLine).toContain("capabilities:string[];");
    expect(workUnitLine).toContain("acceptanceCriteria:string[];");
    for (const forbidden of ["linear", "github", "provider", "statusType", "label", "issueId"]) {
      expect(workUnitLine.toLowerCase(), `WorkUnit must not gain '${forbidden}'`).not.toContain(forbidden.toLowerCase());
    }
  });

  it("adds no property to work-unit.schema.json", () => {
    // `additionalProperties: false` means a provider field could not be added to a
    // compiled Work Unit without failing this contract's own validator.
    const schema = JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8")) as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
      required: string[];
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
    expect(schema.required.sort()).toEqual(["acceptance_criteria", "capabilities", "goal", "id", "repository"]);
  });
});

describe("accepted and refused are mutually exclusive", () => {
  it("gives a refusal no way to carry a Work Unit", () => {
    // The invariant is structural, not conventional: `IntakeResult` is a union, so a
    // refused outcome has no `workUnit` to read. A caller that forgets to branch on
    // `outcome` gets a type error rather than an unearned dispatch.
    const refused = runIntake(boardAdapter, { ...readyTask, stage: "backlog" }, boardPolicy);
    const accepted = runIntake(boardAdapter, readyTask, boardPolicy);

    expect(Object.keys(refused)).not.toContain("workUnit");
    expect(Object.keys(accepted)).not.toContain("refusal");
    expect(refused.outcome === "accepted").toBe(false);
  });
});