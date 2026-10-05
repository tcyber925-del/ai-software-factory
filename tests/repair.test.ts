import { describe, expect, it } from "vitest";
import type { VerificationResult, WorkUnit, Worker } from "../src/protocol.js";
import type { ExecutionRecord } from "../src/kernel/execution.js";
import { buildRepairContext, DEFAULT_MAX_REPAIR_ATTEMPTS, renderRepairPrompt, runRepairLoop } from "../src/kernel/repair.js";
import { InMemoryEventLog } from "../src/state/event-log.js";

const workUnit: WorkUnit = {
  id: "FCT-012",
  goal: "keep verification green",
  repository: "example/repo",
  capabilities: ["testing"],
  acceptanceCriteria: ["build passes", "tests pass"],
  scope: ["src/kernel"],
};

const worker: Worker = { id: "w1", capabilities: ["testing"], runtime: "fake" };

function verification(status: "passed" | "failed" | "blocked", failed = ["tests"]): VerificationResult {
  return {
    workUnitId: workUnit.id,
    status,
    checks: [
      { name: "build", status: "passed", evidence: "exit=0" },
      ...(status === "passed"
        ? []
        : [{ name: "tests", status: "failed" as const, evidence: "1 test failed" }]),
    ],
  };
}

function execution(runtimeStatus = "idle"): ExecutionRecord {
  return {
    workUnitId: workUnit.id,
    status: "completed",
    events: [],
    runtime: "fake",
    runtimeStatus,
  };
}

function clock() {
  let n = 0;
  return { id: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
}

/** A worker that always claims success, regardless of reality. */
const lyingExecute = async (): Promise<ExecutionRecord> => execution("idle");

describe("repair is triggered by verification failure", () => {
  it("does not repair when verification already passed", async () => {
    let executed = 0;
    const result = await runRepairLoop({
      workUnit,
      initialVerification: verification("passed"),
      execute: async () => {
        executed += 1;
        return execution();
      },
      verify: async () => verification("passed"),
      ...clock(),
    });

    expect(result.status).toBe("verified");
    expect(result.attempts).toHaveLength(0);
    expect(executed).toBe(0);
    expect(result.reason).toBe("verification_already_passed");
  });

  it("repairs after a failing verification and reports success", async () => {
    const result = await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      execute: lyingExecute,
      verify: async () => verification("passed"),
      ...clock(),
    });

    expect(result.status).toBe("verified");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toBe("repaired");
    expect(result.finalVerification.status).toBe("passed");
  });
});

describe("a worker cannot self-authorize its own repair", () => {
  it("ignores a successful runtime when checks still fail", async () => {
    const result = await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      // Runtime reports success on every attempt.
      execute: lyingExecute,
      verify: async () => verification("failed"),
      ...clock(),
    });

    expect(result.status).toBe("escalated");
    expect(result.attempts.every((attempt) => attempt.outcome === "still_failing")).toBe(true);
  });

  it("fails the loop when verification is blocked, not merely failed", async () => {
    const result = await runRepairLoop({
      workUnit,
      initialVerification: verification("blocked"),
      execute: lyingExecute,
      verify: async () => verification("blocked"),
      ...clock(),
    });
    expect(result.status).toBe("escalated");
  });
});

describe("the repair limit is enforced by the loop", () => {
  it("defaults to two attempts", async () => {
    let attempts = 0;
    const result = await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      execute: async () => {
        attempts += 1;
        return execution();
      },
      verify: async () => verification("failed"),
      ...clock(),
    });

    expect(attempts).toBe(DEFAULT_MAX_REPAIR_ATTEMPTS);
    expect(DEFAULT_MAX_REPAIR_ATTEMPTS).toBe(2);
    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(2);
  });

  it("cannot be exceeded even if a policy requests more", async () => {
    let attempts = 0;
    const result = await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      execute: async () => {
        attempts += 1;
        return execution();
      },
      verify: async () => verification("failed"),
      policy: { maxAttempts: 3 },
      ...clock(),
    });
    expect(attempts).toBe(3);
    expect(result.attempts).toHaveLength(3);
    expect(result.status).toBe("escalated");
  });

  it("honours a lower limit", async () => {
    let attempts = 0;
    await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      execute: async () => {
        attempts += 1;
        return execution();
      },
      verify: async () => verification("failed"),
      policy: { maxAttempts: 1 },
      ...clock(),
    });
    expect(attempts).toBe(1);
  });

  it("treats a zero limit as no repair at all", async () => {
    let attempts = 0;
    const result = await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      execute: async () => {
        attempts += 1;
        return execution();
      },
      verify: async () => verification("failed"),
      policy: { maxAttempts: 0 },
      ...clock(),
    });
    expect(attempts).toBe(0);
    expect(result.status).toBe("escalated");
    expect(result.attempts).toHaveLength(0);
  });

  it("stops immediately when a repair succeeds before the limit", async () => {
    let attempts = 0;
    const result = await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      execute: async () => {
        attempts += 1;
        return execution();
      },
      verify: async () => verification("passed"),
      ...clock(),
    });
    expect(attempts).toBe(1);
    expect(result.status).toBe("verified");
  });
});

describe("repair context stays within original scope", () => {
  it("restates the original goal, criteria and scope", () => {
    const context = buildRepairContext(workUnit, verification("failed"), 1, 2);
    expect(context.goal).toBe("keep verification green");
    expect(context.acceptanceCriteria).toEqual(["build passes", "tests pass"]);
    expect(context.scope).toEqual(["src/kernel"]);
    expect(context.attempt).toBe(1);
    expect(context.maxAttempts).toBe(2);
  });

  it("carries only the failing checks forward", () => {
    const context = buildRepairContext(workUnit, verification("failed"), 1, 2);
    expect(context.failedChecks.map((check) => check.name)).toEqual(["tests"]);
  });

  it("forbids scope and requirement changes in the prompt", () => {
    const prompt = renderRepairPrompt(buildRepairContext(workUnit, verification("failed"), 1, 2));
    expect(prompt).toContain("Do not modify tests to make them pass");
    expect(prompt).toContain("without changing requirements, architecture, or scope");
    expect(prompt).toContain("Stay within this scope: src/kernel");
    expect(prompt).toContain("1 test failed");
  });

  it("does not mutate the Work Unit it is given", () => {
    const before = JSON.stringify(workUnit);
    const context = buildRepairContext(workUnit, verification("failed"), 1, 2);
    context.acceptanceCriteria.push("new requirement");
    context.failedChecks.push({ name: "injected", status: "failed" });
    expect(JSON.stringify(workUnit)).toBe(before);
  });
});

describe("every attempt is traceable", () => {
  it("records each attempt and outcome as durable factory events", async () => {
    const log = new InMemoryEventLog();
    await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      execute: lyingExecute,
      verify: async () => verification("failed"),
      eventLog: log,
      runId: "r1",
      ...clock(),
    });

    const types = log.stored().map((event) => event.type);
    expect(types).toEqual([
      "repair.started",
      "repair.failed",
      "repair.started",
      "repair.failed",
      "repair.escalated",
    ]);
    expect(log.stored().every((event) => event.source === "factory")).toBe(true);
  });

  it("links repair attempts to the run that triggered them", async () => {
    const log = new InMemoryEventLog();
    await runRepairLoop({
      workUnit,
      initialVerification: verification("failed"),
      execute: lyingExecute,
      verify: async () => verification("failed"),
      eventLog: log,
      runId: "repair-1",
      parentRunId: "original-run",
      ...clock(),
    });

    expect(log.stored().every((event) => event.parentRunId === "original-run")).toBe(true);
    expect(log.stored().every((event) => event.runId === "repair-1")).toBe(true);
  });

  it("counts attempts so the limit is auditable after the fact", async () => {
    const log = new InMemoryEventLog();
    await runShellLikeRepair(log);
    const started = log.stored().filter((event) => event.type === "repair.started");
    expect(started.map((event) => event.payload["attempt"])).toEqual([1, 2]);
  });
});

async function runShellLikeRepair(log: InMemoryEventLog) {
  await runRepairLoop({
    workUnit,
    initialVerification: verification("failed"),
    execute: lyingExecute,
    verify: async () => verification("failed"),
    eventLog: log,
    runId: "r1",
    ...clock(),
  });
}