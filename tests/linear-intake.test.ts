import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LinearIssue } from "../src/adapters/linear/intake.js";
import {
  HARD_EXCLUDED_STATUS_TYPES,
  compileWorkUnit,
  evaluateEligibility,
  parseDeclaredRequirements,
} from "../src/adapters/linear/intake.js";
import {
  buildTransition,
  deriveOutcome,
  requiresHumanAcknowledgement,
  transitionEvent,
} from "../src/adapters/linear/status.js";
import { validateAgainstSchema } from "../src/kernel/json-schema.js";
import { workUnitToWireForm } from "../src/kernel/work-unit.js";

/**
 * Driven by fixtures/linear/*, which hold payloads recorded from the live
 * Linear workspace plus explicitly-marked synthetic cases. Tests therefore run
 * offline and reproducibly, and no CI job needs Linear credentials.
 */

interface Fixture {
  issues: (LinearIssue & { shape: string; note?: string })[];
}

const fixtures: Fixture = JSON.parse(readFileSync("fixtures/linear/issues.json", "utf8")) as Fixture;
const statuses = JSON.parse(readFileSync("fixtures/linear/statuses.json", "utf8")) as {
  statuses: { type: string; name: string }[];
};

const issue = (id: string): LinearIssue => {
  const found = fixtures.issues.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`fixture missing: ${id}`);
  return found;
};
const all = (): LinearIssue[] => fixtures.issues;

const eligible = { eligibleStatusTypes: ["started"], eligibleStatusNames: ["In Progress"] };

describe("fixtures reflect the real Linear workspace", () => {
  it("records the workspace's actual status taxonomy", () => {
    const types = statuses.statuses.map((status) => status.type);
    // The workspace has no "Ready" status — which is exactly why eligibility
    // cannot be inferred from a status name.
    expect(types).toContain("backlog");
    expect(types).toContain("triage");
    expect(types).toContain("unstarted");
    expect(types).toContain("started");
    expect(types).not.toContain("ready");
  });

  it("records both real and explicitly-marked synthetic issues", () => {
    expect(fixtures.issues.some((entry) => entry.shape === "real")).toBe(true);
    const synthetic = fixtures.issues.filter((entry) => entry.shape === "synthetic");
    expect(synthetic.length).toBeGreaterThan(0);
    // Every synthetic entry must declare itself, so no fabricated payload can be
    // mistaken for a recorded one.
    for (const entry of synthetic) expect(entry.note, `${entry.id} must carry a note`).toBeDefined();
  });
});

describe("only explicitly eligible work dispatches", () => {
  it("dispatches nothing by default", () => {
    // An eligible-status, fully-declared, unfinished issue must still not run
    // until a human allowlists the status.
    const decision = evaluateEligibility({ issue: issue("ENG-905"), repository: "o/r" });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("status_not_eligible");
    expect(decision.detail).toContain("nothing dispatches by default");
  });

  it("never dispatches Backlog work, even with full requirements declared", () => {
    // ENG-900 is Backlog AND declares everything. Without this case the rule
    // would look covered by "missing requirements" and be untested.
    const decision = evaluateEligibility({ issue: issue("ENG-900"), config: eligible });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("backlog_or_hard_excluded_status");
  });

  it("hard-excludes every non-dispatchable status type regardless of config", () => {
    for (const statusType of HARD_EXCLUDED_STATUS_TYPES) {
      const permissive = {
        config: { eligibleStatusTypes: [...HARD_EXCLUDED_STATUS_TYPES], eligibleStatusNames: ["Backlog"] },
        issue: {
          id: "X-1",
          title: "t",
          statusType,
          statusName: "Backlog",
          description: "<!-- factory:start -->\n- capability: coding\n- acceptance: a\n<!-- factory:end -->",
        },
      };
      expect(evaluateEligibility(permissive).eligible, `${statusType} must never be eligible`).toBe(false);
    }
  });

  it("refuses completed and canceled work", () => {
    // A finished issue whose status type is still dispatchable — the terminal
    // check must catch it independently of the hard-excluded status list.
    const finished = { ...issue("ENG-905"), completedAt: "2026-10-05T09:00:00.000Z" };
    expect(evaluateEligibility({ issue: finished, config: eligible, repository: "o/r" }).reason).toBe(
      "already_completed_or_canceled",
    );
    const canceled = { ...issue("ENG-905"), canceledAt: "2026-10-05T09:00:00.000Z" };
    expect(evaluateEligibility({ issue: canceled, config: eligible, repository: "o/r" }).reason).toBe(
      "already_completed_or_canceled",
    );
  });

  it("dispatches eligible, fully-declared, unblocked work", () => {
    const known = all().map((candidate) =>
      candidate.id === "ENG-903" ? { ...candidate, completedAt: "2026-10-05T10:00:00.000Z" } : candidate,
    );
    const decision = evaluateEligibility({ issue: issue("ENG-902"), config: eligible, knownIssues: known, repository: "o/r" });
    expect(decision.eligible).toBe(true);
  });

  it("refuses when no repository is supplied rather than inferring one", () => {
    const known = all().map((candidate) =>
      candidate.id === "ENG-903" ? { ...candidate, completedAt: "2026-10-05T10:00:00.000Z" } : candidate,
    );
    const decision = evaluateEligibility({ issue: issue("ENG-902"), config: eligible, knownIssues: known });
    expect(decision.reason).toBe("missing_repository");
    expect(decision.detail).toContain("will not infer");
  });
});

describe("no product or architecture decision is inferred", () => {
  it("refuses an issue whose acceptance criteria exist only in prose", () => {
    // ENG-901 says "the site should be faster and the tests should pass" — a real
    // temptation to compile. The factory must refuse instead.
    const decision = evaluateEligibility({ issue: issue("ENG-901"), config: eligible });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("missing_acceptance_criteria");
    expect(decision.detail).toContain("will not infer");
  });

  it("never emits a Work Unit when eligibility is refused", () => {
    const compiled = compileWorkUnit({ issue: issue("ENG-901"), config: eligible });
    expect(compiled.workUnit).toBeUndefined();
    expect(compiled.decision.eligible).toBe(false);
  });

  it("requires both acceptance criteria and capabilities", () => {
    const onlyAcceptance = evaluateEligibility({
      issue: { id: "X-2", title: "t", statusType: "started", description: "<!-- factory:start -->\n- acceptance: a\n<!-- factory:end -->" },
      config: eligible,
    });
    expect(onlyAcceptance.reason).toBe("missing_acceptance_criteria");

    const onlyCapability = evaluateEligibility({
      issue: { id: "X-3", title: "t", statusType: "started", description: "<!-- factory:start -->\n- capability: coding\n<!-- factory:end -->" },
      config: eligible,
    });
    expect(onlyCapability.reason).toBe("missing_acceptance_criteria");
  });

  it("ignores text that merely mentions requirements outside the block", () => {
    const parsed = parseDeclaredRequirements("acceptance: sneaky\ncapability: sneaky");
    expect(parsed).toBeUndefined();
  });
});

describe("dependency and readiness semantics are respected", () => {
  it("refuses work blocked by an incomplete issue", () => {
    const decision = evaluateEligibility({
      issue: issue("ENG-902"),
      config: eligible,
      knownIssues: all(),
      repository: "o/r",
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("blocked_by_incomplete_issue");
    expect(decision.detail).toContain("ENG-903");
  });

  it("dispatches once the blocker is complete", () => {
    // Same issue, with ENG-903 now complete.
    const known = all().map((candidate) =>
      candidate.id === "ENG-903"
        ? { ...candidate, statusType: "started", completedAt: "2026-10-05T10:00:00.000Z" }
        : candidate,
    );
    const compiled = compileWorkUnit({ issue: issue("ENG-902"), config: eligible, knownIssues: known, repository: "o/r" });
    expect(compiled.decision.eligible).toBe(true);
    expect(compiled.workUnit).toBeDefined();
  });

  it("refuses when a blocker cannot be resolved at all", () => {
    const decision = evaluateEligibility({
      issue: issue("ENG-902"),
      config: eligible,
      knownIssues: [],
      repository: "o/r",
    });
    expect(decision.reason).toBe("blocked_by_unknown_issue");
  });

  it("refuses work carrying a blocking label", () => {
    const decision = evaluateEligibility({
      issue: issue("ENG-905"),
      config: { ...eligible, blockingLabels: ["needs-founder-approval"] },
      repository: "o/r",
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("blocked_by_label");
  });
});

describe("issue identity is preserved and compilation is deterministic", () => {
  const knownIssues = all().map((candidate) =>
    candidate.id === "ENG-903" ? { ...candidate, completedAt: "2026-10-05T10:00:00.000Z" } : candidate,
  );

  it("uses the Linear identifier as the Work Unit id", () => {
    const compiled = compileWorkUnit({ issue: issue("ENG-902"), config: eligible, knownIssues, repository: "o/r" });
    expect(compiled.workUnit?.id).toBe("ENG-902");
    expect(compiled.issueId).toBe("ENG-902");
    expect(compiled.url).toContain("ENG-902");
  });

  it("carries the issue's declared requirements verbatim", () => {
    const compiled = compileWorkUnit({ issue: issue("ENG-902"), config: eligible, knownIssues, repository: "o/r" });
    expect(compiled.workUnit?.goal).toBe(issue("ENG-902").title);
    expect(compiled.workUnit?.acceptanceCriteria).toEqual([
      "Duplicate slugs fail the build.",
      "The rule is documented for content authors.",
    ]);
    expect(compiled.workUnit?.capabilities).toEqual(["coding", "testing"]);
  });

  it("defaults autonomy to review so intake never self-authorizes a merge", () => {
    const compiled = compileWorkUnit({ issue: issue("ENG-902"), config: eligible, knownIssues, repository: "o/r" });
    expect(compiled.workUnit?.autonomy).toBe("review");
  });

  it("produces an identical Work Unit for the same input", () => {
    const first = compileWorkUnit({ issue: issue("ENG-902"), config: eligible, knownIssues, repository: "o/r" });
    const second = compileWorkUnit({ issue: issue("ENG-902"), config: eligible, knownIssues, repository: "o/r" });
    expect(JSON.stringify(second.workUnit)).toBe(JSON.stringify(first.workUnit));
  });

  it("keeps Linear out of the factory protocol", () => {
    const compiled = compileWorkUnit({ issue: issue("ENG-902"), config: eligible, knownIssues, repository: "o/r" });
    // The Work Unit is provider-neutral: no Linear field, no status, no url.
    expect(Object.keys(compiled.workUnit ?? {}).sort()).toEqual([
      "acceptanceCriteria",
      "autonomy",
      "capabilities",
      "goal",
      "id",
      "repository",
    ]);
  });
});

describe("the compiled Work Unit satisfies the factory's own schema", () => {
  it("validates against work-unit.schema.json through the real validator", () => {
    const schema = JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8"));
    const knownIssues = all().map((candidate) =>
      candidate.id === "ENG-903" ? { ...candidate, completedAt: "2026-10-05T10:00:00.000Z" } : candidate,
    );
    const compiled = compileWorkUnit({
      issue: issue("ENG-902"),
      config: eligible,
      knownIssues,
      repository: "o/r",
      baseRevision: "abc123",
    });
    const wire = workUnitToWireForm(compiled.workUnit!);
    expect(validateAgainstSchema(wire, schema as never)).toEqual([]);
  });
});

describe("status transitions are traceable and never overstate success", () => {
  const traceability = { system: "linear" as const, issueId: "ENG-902", statusType: "started" };

  it("keeps completed work in progress while verification is absent", () => {
    expect(deriveOutcome({ traceability, execution: { status: "completed", runtimeStatus: "idle" } })).toBe(
      "in_progress",
    );
  });

  it("does not treat a passing runtime as verification", () => {
    const outcome = deriveOutcome({
      traceability,
      execution: { status: "completed", runtimeStatus: "idle" },
      verification: { status: "failed" },
    });
    expect(outcome).toBe("in_progress");
  });

  it("reports ready for review only on independent verification plus the gate", () => {
    expect(
      deriveOutcome({
        traceability,
        execution: { status: "completed" },
        verification: { status: "passed" },
        integration: { state: "ready" },
        prUrl: "https://github.com/o/r/pull/1",
      }),
    ).toBe("ready_for_review");
  });

  it("does not report ready when the integration gate blocked", () => {
    expect(
      deriveOutcome({
        traceability,
        execution: { status: "completed" },
        verification: { status: "passed" },
        integration: { state: "blocked", reason: "verification_failed" },
      }),
    ).toBe("in_progress");
  });

  it("reports blocked and failed work accurately", () => {
    expect(deriveOutcome({ traceability, execution: { status: "blocked" } })).toBe("blocked");
    expect(deriveOutcome({ traceability, execution: { status: "failed" } })).toBe("failed");
  });

  it("records a reason and evidence with every transition", () => {
    const withNoVerification = buildTransition({
      traceability,
      execution: { status: "completed", runtimeStatus: "idle" },
    });
    expect(withNoVerification.reason).toContain("runtime completion is not correctness");

    const failedVerification = buildTransition({
      traceability,
      execution: { status: "completed", runtimeStatus: "idle" },
      verification: { status: "failed" },
    });
    expect(failedVerification.reason).toContain("not integration-ready");
    expect(failedVerification.evidence).toMatchObject({ workUnitId: "ENG-902", runtimeStatus: "idle", verificationStatus: "failed" });
    expect(failedVerification.from).toBe("started");
  });

  it("emits transitions as factory events, never as runtime output", () => {
    const event = transitionEvent(
      buildTransition({ traceability, execution: { status: "blocked" } }),
      "2026-01-01T00:00:00.000Z",
    );
    expect(event.workUnitId).toBe("ENG-902");
    expect(event.payload?.["to"]).toBe("blocked");
    // Never confused with worker completion.
    expect(event.type).not.toContain("worker");
  });

  it("requires human acknowledgement before reporting done", () => {
    expect(requiresHumanAcknowledgement("done")).toBe(true);
    expect(requiresHumanAcknowledgement("ready_for_review")).toBe(false);
  });
});
