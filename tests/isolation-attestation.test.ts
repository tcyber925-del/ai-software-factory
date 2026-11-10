import { describe, expect, it } from "vitest";
import type { IsolationAttestation } from "../src/protocol.js";
import { verifyIsolationAttestation } from "../src/security/attestation.js";
import type { AttestationExpectation } from "../src/security/attestation.js";

/**
 * Attestation is evidence, not a label.
 *
 * These tests are deliberately written against `unknown` inputs, because the
 * adapter is outside the kernel's trust boundary: a runtime can return a
 * string, a partial object, or stale evidence. Every one of those must refuse
 * rather than be coerced into an admission.
 */

const observedAt = "2026-11-09T12:00:00.000Z";
const worktreePath = "/repo/.factory/ws-1/worktree";

const expected: AttestationExpectation = {
  runtime: "opencode",
  workUnitId: "W-1",
  workspaceId: "ws-1",
  worktreePath,
  repositoryRoot: "/repo",
  now: observedAt,
  requiredLevel: "git_worktree",
};

function valid(overrides: Partial<IsolationAttestation> = {}): IsolationAttestation {
  return {
    runtime: "opencode",
    level: "git_worktree",
    workUnitId: "W-1",
    workspaceId: "ws-1",
    repositoryRoot: "/repo",
    worktreePath,
    agentCwd: worktreePath,
    observedAt,
    ...overrides,
  };
}

describe("isolation attestation verification", () => {
  it("accepts a complete, fresh, runtime-bound worktree attestation", () => {
    const decision = verifyIsolationAttestation(valid(), expected);
    expect(decision.ok).toBe(true);
    expect(decision.outcome).toBe("verified");
    expect(decision.providedLevel).toBe("git_worktree");
    expect(decision.evidence).toMatchObject({
      runtime: "opencode",
      workUnitId: "W-1",
      workspaceId: "ws-1",
      worktreePath,
      agentCwd: worktreePath,
    });
  });

  it("refuses the literal label a caller could pass instead of evidence", () => {
    const decision = verifyIsolationAttestation("git_worktree", expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("malformed");
    expect(decision.problems).toContain("attestation_malformed");
    expect(decision.reason).toMatch(/not evidence|malformed/i);
  });

  it("refuses a missing attestation", () => {
    const decision = verifyIsolationAttestation(undefined, expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("missing");
    expect(decision.problems).toContain("attestation_missing");
  });

  it("refuses a partial attestation rather than filling in defaults", () => {
    const partial = { runtime: "opencode", level: "git_worktree", workUnitId: "W-1" };
    const decision = verifyIsolationAttestation(partial, expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("malformed");
    expect(decision.problems).toContain("attestation_malformed");
  });

  it("refuses an attestation whose declared level is not a known isolation level", () => {
    const decision = verifyIsolationAttestation(valid({ level: "trust-me" as never }), expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("malformed");
  });

  it("refuses stale evidence", () => {
    const stale = { ...valid(), observedAt: "2026-11-09T10:00:00.000Z" };
    const decision = verifyIsolationAttestation(stale, expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("stale");
    expect(decision.problems).toContain("attestation_stale");
  });

  it("refuses evidence dated beyond the admitted clock", () => {
    const future = { ...valid(), observedAt: "2026-11-09T12:10:00.000Z" };
    const decision = verifyIsolationAttestation(future, expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("stale");
  });

  it("refuses evidence produced by a different runtime", () => {
    const decision = verifyIsolationAttestation(valid({ runtime: "hermes" }), expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("mismatched");
    expect(decision.problems).toContain("runtime_mismatch");
  });

  it("refuses evidence bound to a different Work Unit", () => {
    const decision = verifyIsolationAttestation(valid({ workUnitId: "W-2" }), expected);
    expect(decision.ok).toBe(false);
    expect(decision.problems).toContain("work_unit_mismatch");
  });

  it("refuses evidence bound to a different workspace", () => {
    const decision = verifyIsolationAttestation(valid({ workspaceId: "ws-2" }), expected);
    expect(decision.ok).toBe(false);
    expect(decision.problems).toContain("workspace_mismatch");
  });

  it("refuses evidence about a different repository root", () => {
    const decision = verifyIsolationAttestation(valid({ repositoryRoot: "/other" }), expected);
    expect(decision.ok).toBe(false);
    expect(decision.problems).toContain("repository_mismatch");
  });

  it("refuses a workspace identity check that points at a different worktree", () => {
    const decision = verifyIsolationAttestation(valid({ worktreePath: "/repo/.factory/ws-2/worktree" }), expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("mismatched");
    expect(decision.problems).toContain("worktree_mismatch");
  });

  it("refuses a worktree claim when the agent would run somewhere else", () => {
    const decision = verifyIsolationAttestation(valid({ agentCwd: "/repo" }), expected);
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("mismatched");
    expect(decision.problems).toContain("agent_cwd_mismatch");
  });

  it("refuses an attestation that claims a worktree when none was created", () => {
    const { worktreePath: _omitted, ...withoutWorktree } = expected;
    const decision = verifyIsolationAttestation(valid(), withoutWorktree);
    expect(decision.ok).toBe(false);
    expect(decision.problems).toContain("worktree_mismatch");
  });

  it("refuses an insufficient level even when every identity field matches", () => {
    const { worktreePath: _omitted, ...noWorktree } = valid();
    const decision = verifyIsolationAttestation(
      { ...noWorktree, level: "none", agentCwd: "/repo" },
      expected,
    );
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("insufficient");
    expect(decision.problems).toContain("isolation_insufficient");
    expect(decision.reason).toMatch(/isolates files, not privileges/i);
  });

  it("reports the runtime's observation failure instead of inventing evidence", () => {
    const decision = verifyIsolationAttestation(undefined, {
      ...expected,
      observationError: "attestation command failed",
    });
    expect(decision.ok).toBe(false);
    expect(decision.outcome).toBe("missing");
    expect(decision.reason).toContain("attestation command failed");
  });
});
