import { describe, expect, it } from "vitest";
import type { IsolationAttestation, WorkUnit } from "../src/protocol.js";
import type { RiskClass } from "../src/security/risk.js";
import {
  DANGEROUS_OPERATION_SCREEN_IS_BEST_EFFORT,
  PROTECTED_BRANCHES,
  admitExecution,
  assessExecutionRisk,
  detectDangerousOperations,
  evaluateBranchWrite,
  evaluateCredentialAccess,
  isProtectedBranch,
  isolationStrength,
  minimumIsolationFor,
} from "../src/security/risk.js";
import { evaluateSecurityGate, recordSecurityDecision } from "../src/security/index.js";
import { InMemoryEventLog } from "../src/state/event-log.js";

const workUnit: WorkUnit = {
  id: "FCT-014",
  goal: "assess risk",
  repository: "example/repo",
  capabilities: ["coding"],
  acceptanceCriteria: ["risk is classified"],
};

function clock() {
  let n = 0;
  return { id: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
}

const observedAt = "2026-01-01T00:00:00.000Z";
const worktreePath = "/repo/.factory/ws-1/worktree";

function attestation(overrides: Partial<IsolationAttestation> = {}): IsolationAttestation {
  return {
    runtime: "opencode",
    level: "git_worktree",
    workUnitId: workUnit.id,
    workspaceId: "ws-1",
    repositoryRoot: "/repo",
    worktreePath,
    agentCwd: worktreePath,
    observedAt,
    ...overrides,
  };
}

function isolationExpected() {
  return {
    runtime: "opencode",
    workUnitId: workUnit.id,
    workspaceId: "ws-1",
    worktreePath,
    repositoryRoot: "/repo",
    now: observedAt,
  };
}

describe("risk classification", () => {
  it("classifies first-party work as trusted", () => {
    const assessment = assessExecutionRisk(workUnit);
    expect(assessment.risk).toBe("trusted");
    expect(assessment.minimumIsolation).toBe("git_worktree");
  });

  it("classifies untrusted content consumption as untrusted", () => {
    const assessment = assessExecutionRisk(workUnit, { consumesUntrustedContent: true });
    expect(assessment.risk).toBe("untrusted");
    expect(assessment.minimumIsolation).toBe("sandbox");
    expect(assessment.reasons).toContain("consumes content the factory did not author");
  });

  it("classifies arbitrary command execution as untrusted", () => {
    expect(assessExecutionRisk(workUnit, { executesArbitraryCommands: true }).risk).toBe("untrusted");
  });

  it("classifies production touch as destructive, the highest severity", () => {
    const assessment = assessExecutionRisk(workUnit, { touchesProduction: true, consumesUntrustedContent: true });
    expect(assessment.risk).toBe("destructive");
    expect(assessment.minimumIsolation).toBe("sandbox");
  });

  it("never lets a declared risk downgrade the assessment", () => {
    // An author asserting "trusted" must not be able to downgrade genuinely
    // untrusted or destructive work.
    const downgraded = assessExecutionRisk(workUnit, {
      consumesUntrustedContent: true,
      declaredRisk: "trusted",
    });
    expect(downgraded.risk).toBe("untrusted");
    expect(downgraded.reasons.some((reason) => reason.includes("downgrade refused"))).toBe(true);
  });

  it("allows a declared risk to raise the assessment", () => {
    const raised = assessExecutionRisk(workUnit, { declaredRisk: "destructive" });
    expect(raised.risk).toBe("destructive");
  });

  it("produces the same classification for the same input", () => {
    const input = { consumesUntrustedContent: true, executesArbitraryCommands: true };
    expect(JSON.stringify(assessExecutionRisk(workUnit, input))).toBe(
      JSON.stringify(assessExecutionRisk(workUnit, input)),
    );
  });

  it("orders isolation strength so sandbox exceeds worktree", () => {
    expect(isolationStrength("sandbox")).toBeGreaterThan(isolationStrength("git_worktree"));
    expect(isolationStrength("git_worktree")).toBeGreaterThan(isolationStrength("none"));
  });
});

describe("higher-risk work is refused before dispatch", () => {
  it("blocks untrusted work because no sandbox runtime is configured", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: { consumesUntrustedContent: true },
      targetBranch: "feature/x",
      writeMode: "pull_request",
    });
    expect(gate.admitted).toBe(false);
    const blocker = gate.blockers.find((entry) => entry.kind === "execution_blocked");
    expect(blocker?.reason).toContain("a git worktree isolates files, not privileges");
    expect(blocker?.detail).toMatchObject({
      requiredIsolation: "sandbox",
      providedIsolation: null,
      attestation: "not_attempted",
      stage: "pre_dispatch",
    });
  });

  it("blocks destructive work before dispatch", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: { touchesProduction: true },
      targetBranch: "feature/x",
      writeMode: "pull_request",
    });
    expect(gate.admitted).toBe(false);
    expect(gate.assessment.risk).toBe("destructive");
  });

  it("does not downgrade risk to fit the isolation available", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: { touchesProduction: true },
      targetBranch: "feature/x",
      writeMode: "pull_request",
    });
    // Still destructive, not quietly downgraded to trusted.
    expect(gate.assessment.risk).toBe("destructive");
    expect(gate.assessment.minimumIsolation).toBe("sandbox");
  });

  it("screens trusted work but does not admit it before attestation", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: {},
      targetBranch: "feature/x",
      writeMode: "pull_request",
    });
    expect(gate.admitted).toBe(true);
    const screen = gate.decisions.find((entry) => entry.kind === "dispatch_screened");
    expect(screen?.detail).toMatchObject({
      requiredIsolation: "git_worktree",
      providedIsolation: null,
      attestation: "pending",
      stage: "pre_dispatch",
    });
  });
});

describe("admission consumes runtime-bound evidence, not labels", () => {
  it("refuses the literal git_worktree label", () => {
    const admission = admitExecution(workUnit, {}, "git_worktree", isolationExpected());
    expect(admission.admitted).toBe(false);
    expect(admission.attestation.outcome).toBe("malformed");
    expect(admission.reason).toMatch(/not evidence|malformed/i);
  });

  it("admits trusted work with a valid attestation", () => {
    const admission = admitExecution(workUnit, {}, attestation(), isolationExpected());
    expect(admission.admitted).toBe(true);
    expect(admission.attestation.outcome).toBe("verified");
    expect(admission.reason).toMatch(/git_worktree attested by opencode/);
  });

  it("refuses an attestation from a different runtime", () => {
    const admission = admitExecution(
      workUnit,
      {},
      attestation({ runtime: "hermes" }),
      isolationExpected(),
    );
    expect(admission.admitted).toBe(false);
    expect(admission.attestation.outcome).toBe("mismatched");
  });

  it("refuses stale evidence", () => {
    const admission = admitExecution(
      workUnit,
      {},
      attestation({ observedAt: "2025-12-31T00:00:00.000Z" }),
      isolationExpected(),
    );
    expect(admission.admitted).toBe(false);
    expect(admission.attestation.outcome).toBe("stale");
  });

  it("refuses an insufficient level for trusted work", () => {
    const none: IsolationAttestation = {
      runtime: "opencode",
      level: "none",
      workUnitId: workUnit.id,
      workspaceId: "ws-1",
      repositoryRoot: "/repo",
      agentCwd: "/repo",
      observedAt,
    };
    const admission = admitExecution(workUnit, {}, none, isolationExpected());
    expect(admission.admitted).toBe(false);
    expect(admission.attestation.outcome).toBe("insufficient");
    expect(admission.reason).toMatch(/isolates files, not privileges/i);
  });

  it("would admit a sandbox attestation for untrusted work, but no adapter offers one", () => {
    // This proves the contract compares levels rather than hard-coding a
    // provider. It does not claim a sandbox adapter exists; the pre-dispatch
    // screen refuses untrusted work today because none does.
    const sandbox = attestation({ level: "sandbox" });
    const admission = admitExecution(
      workUnit,
      { consumesUntrustedContent: true },
      sandbox,
      isolationExpected(),
    );
    expect(admission.admitted).toBe(true);
    expect(admission.assessment.minimumIsolation).toBe("sandbox");
  });
});

describe("protected branches cannot be modified directly", () => {
  it("refuses a direct push to a protected branch", () => {
    for (const branch of PROTECTED_BRANCHES) {
      const decision = evaluateBranchWrite(branch, "direct_push");
      expect(decision.allowed, `${branch} must reject a direct push`).toBe(false);
    }
  });

  it("allows a protected branch through a pull request", () => {
    expect(evaluateBranchWrite("main", "pull_request").allowed).toBe(true);
  });

  it("allows non-protected branches either way", () => {
    expect(evaluateBranchWrite("feature/x", "direct_push").allowed).toBe(true);
    expect(evaluateBranchWrite("feature/x", "pull_request").allowed).toBe(true);
  });

  it("recognises protected branches regardless of case or padding", () => {
    expect(isProtectedBranch("MAIN")).toBe(true);
    expect(isProtectedBranch("  main  ")).toBe(true);
    expect(isProtectedBranch("mainline")).toBe(false);
  });

  it("blocks the whole gate when a direct push targets a protected branch", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: {},
      targetBranch: "main",
      writeMode: "direct_push",
    });
    expect(gate.admitted).toBe(false);
    expect(gate.blockers.some((entry) => entry.kind === "branch_write")).toBe(true);
  });
});

describe("no production credentials by default", () => {
  it("never grants production credentials", () => {
    const decision = evaluateCredentialAccess({ scope: "production", explicitlyRequired: true });
    expect(decision.granted).toBe(false);
    expect(decision.reason).toContain("never granted");
  });

  it("requires an explicit requirement for lower scopes", () => {
    expect(evaluateCredentialAccess({ scope: "staging", explicitlyRequired: false }).granted).toBe(false);
    expect(evaluateCredentialAccess({ scope: "staging", explicitlyRequired: true }).granted).toBe(true);
  });

  it("grants nothing when no scope is requested", () => {
    expect(evaluateCredentialAccess({ scope: "none", explicitlyRequired: false }).granted).toBe(false);
  });

  it("blocks the gate when production credentials are requested", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: {},
      targetBranch: "feature/x",
      writeMode: "pull_request",
      credentials: { scope: "production", explicitlyRequired: true },
    });
    expect(gate.admitted).toBe(false);
    expect(gate.blockers.some((entry) => entry.kind === "credential_access")).toBe(true);
  });
});

describe("dangerous operation detection", () => {
  it("detects destructive commands", () => {
    expect(detectDangerousOperations("rm -rf /tmp/build")).toContain("recursive_delete");
    expect(detectDangerousOperations("git push --force origin main")).toContain("force_push");
    expect(detectDangerousOperations("git reset --hard HEAD~1")).toContain("hard_reset");
    expect(detectDangerousOperations("docker run --privileged ubuntu")).toContain("privileged_container");
    expect(detectDangerousOperations("chmod 777 /var/data")).toContain("permission_chmod_777");
    expect(detectDangerousOperations("cat ~/.aws/credentials")).toContain("credential_dump");
  });

  it("does not fire on benign commands", () => {
    for (const command of ["npm run build", "git status", "ls -la", "rm file.txt", "git push origin feature/x"]) {
      expect(detectDangerousOperations(command), `${command} must not be flagged`).toEqual([]);
    }
  });

  it("records findings without silently dropping them", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: {},
      targetBranch: "feature/x",
      writeMode: "pull_request",
      commands: ["rm -rf build"],
    });
    expect(gate.dangerousOperations).toEqual(["recursive_delete"]);
    expect(gate.decisions.some((entry) => entry.kind === "dangerous_operation")).toBe(true);
  });

  it("documents itself as a screen rather than a security boundary", () => {
    // The honest framing matters more than the flag: a regex cannot contain a
    // determined command, so this must never be presented as a guarantee.
    expect(DANGEROUS_OPERATION_SCREEN_IS_BEST_EFFORT).toBe(true);
  });
});

describe("security decisions are explicit and auditable", () => {
  it("emits a factory event for every decision", () => {
    const { events } = recordSecurityDecision(
      { kind: "execution_blocked", workUnitId: "FCT-014", allowed: false, reason: "needs a sandbox" },
      { workUnitId: "FCT-014", ...clock() },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("security.blocked");
    expect(events[0]?.workUnitId).toBe("FCT-014");
  });

  it("distinguishes allowed from blocked", () => {
    const allowed = recordSecurityDecision(
      { kind: "execution_admitted", workUnitId: "w", allowed: true, reason: "ok" },
      { workUnitId: "w", ...clock() },
    );
    expect(allowed.events[0]?.type).toBe("security.allowed");
  });

  it("persists decisions durably as factory events", async () => {
    const log = new InMemoryEventLog();
    const { persistSecurityDecision } = await import("../src/security/index.js");
    await persistSecurityDecision(
      { kind: "branch_write", workUnitId: "FCT-014", allowed: false, reason: "protected" },
      { workUnitId: "FCT-014", eventLog: log, runId: "r1", ...clock() },
    );
    const stored = log.stored();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.source).toBe("factory");
    expect(stored[0]?.type).toBe("security.blocked");
  });

  it("returns one decision per applied control, including when admitted", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: {},
      targetBranch: "feature/x",
      writeMode: "pull_request",
      credentials: { scope: "development", explicitlyRequired: true },
    });
    expect(gate.admitted).toBe(true);
    expect(gate.blockers).toEqual([]);
    // execution + branch + credential, and nothing was silently skipped.
    expect(gate.decisions).toHaveLength(3);
  });
});

describe("the factory does not claim a worktree is a sandbox", () => {
  it("states the boundary in every refusal", () => {
    const gate = evaluateSecurityGate({
      workUnitId: "FCT-014",
      risk: { consumesUntrustedContent: true },
      targetBranch: "feature/x",
      writeMode: "pull_request",
    });
    expect(gate.blockers[0]?.reason).toContain("isolates files, not privileges");
  });

  it("requires a sandbox for every non-trusted class", () => {
    const classes: RiskClass[] = ["trusted", "untrusted", "destructive"];
    expect(minimumIsolationFor("trusted")).toBe("git_worktree");
    expect(minimumIsolationFor("untrusted")).toBe("sandbox");
    expect(minimumIsolationFor("destructive")).toBe("sandbox");
    expect(classes).toHaveLength(3);
  });
});