import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeRuntime } from "../src/fake-runtime.js";
import type { RuntimeHealth, Worker, WorkerRuntime, WorkUnit, WorkspaceRef, AgentRef } from "../src/protocol.js";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { executeWorkUnit } from "../src/kernel/execution.js";
import type { ExecutionRecord } from "../src/kernel/execution.js";
import { buildIntegrationResult } from "../src/kernel/integration.js";
import type { ShellCommandResult, ShellRunner } from "../src/adapters/verification/shell.js";
import { runShellVerification } from "../src/adapters/verification/shell.js";
import { validateWorkUnit, workUnitToWireForm, selectRuntime } from "../src/kernel/work-unit.js";

const workUnitSchema = JSON.parse(readFileSync("schemas/work-unit.schema.json", "utf8")) as JsonSchema;

const workUnit: WorkUnit = {
  id: "FCT-006",
  goal: "execute one bounded Work Unit end to end",
  repository: "tcyber925-del/ai-software-factory",
  capabilities: ["testing"],
  acceptanceCriteria: ["execution is traceable"],
  baseRevision: "HEAD",
};

const worker: Worker = { id: "worker-fake", capabilities: ["testing"], runtime: "fake" };

/**
 * A fully-formed runtime built from an object literal. Class instances cannot be
 * used for this: spreading one copies only own properties, not prototype methods.
 */
function stubRuntime(overrides: Partial<WorkerRuntime> = {}): WorkerRuntime {
  return {
    capabilities: () => Promise.resolve(["testing"]),
    health: (): Promise<RuntimeHealth> => Promise.resolve({ available: true, runtime: "stub" }),
    createWorkspace: (): Promise<WorkspaceRef> => Promise.resolve({ id: "ws-1", path: "/tmp/ws-1" }),
    createWorktree: (workspace: WorkspaceRef): Promise<WorkspaceRef> =>
      Promise.resolve({ ...workspace, worktreePath: "/tmp/ws-1/wt" }),
    startAgent: (): Promise<AgentRef> => Promise.resolve({ id: "agent-1", runtimeId: "agent-1" }),
    promptAgent: (): Promise<void> => Promise.resolve(),
    waitAgent: () => Promise.resolve("idle"),
    inspectAgent: () => Promise.resolve({ status: "idle" }),
    collectRuntimeEvidence: () =>
      Promise.resolve({ runtime: "stub", workspaceId: "ws-1", agentId: "agent-1", events: [] }),
    cleanupWorkspace: (): Promise<void> => Promise.resolve(),
    ...overrides,
  };
}

/** Deterministic ids and clock so event sequences are exactly assertable. */
function deterministic() {
  let counter = 0;
  return { id: () => `evt-${++counter}`, now: () => "2026-01-01T00:00:00.000Z" };
}

function eventTypes(record: ExecutionRecord): string[] {
  return record.events.map((event) => event.type);
}

const passingRunner: ShellRunner = {
  async run(): Promise<ShellCommandResult> {
    return { stdout: "ok", stderr: "", exitCode: 0 };
  },
};

const failingRunner: ShellRunner = {
  async run(): Promise<ShellCommandResult> {
    return { stdout: "", stderr: "1 test failed", exitCode: 1 };
  },
};

async function verify(
  runner: ShellRunner,
  workUnitId = workUnit.id,
): Promise<ReturnType<typeof runShellVerification> extends Promise<infer T> ? T : never> {
  const clock = deterministic();
  return runShellVerification({
    workUnitId,
    checks: [{ name: "unit-tests", command: "npm", args: ["test"] }],
    cwd: ".",
    runner,
    ...clock,
  });
}

describe("Work Unit validation", () => {
  it("accepts a well-formed Work Unit expressed as capabilities", () => {
    const validation = validateWorkUnit(workUnit, workUnitSchema);
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("rejects a Work Unit missing required fields without dispatching a runtime", async () => {
    const invalid = { ...workUnit, goal: "", capabilities: [] as string[] };
    expect(validateWorkUnit(invalid, workUnitSchema).valid).toBe(false);

    const runtime = new FakeRuntime();
    const clock = deterministic();
    const record = await executeWorkUnit({
      workUnit: invalid,
      worker,
      runtimes: [{ name: "fake", runtime }],
      prompt: "implement",
      schema: workUnitSchema,
      ...clock,
    });

    expect(record.status).toBe("blocked");
    expect(record.failure).toBe("work_unit_invalid");
    expect(eventTypes(record)).toEqual(["work.rejected"]);
    // Proof the runtime was never touched.
    expect(await runtime.collectRuntimeEvidence({ id: "agent-1", runtimeId: "agent-1" })).toEqual({
      runtime: "fake",
      workspaceId: "unknown",
      agentId: "agent-1",
      events: [],
    });
  });

  it("projects camelCase Work Units onto the snake_case wire contract", () => {
    expect(workUnitToWireForm(workUnit)).toMatchObject({
      id: "FCT-006",
      base_revision: "HEAD",
      acceptance_criteria: ["execution is traceable"],
    });
  });
});

describe("runtime selection", () => {
  it("blocks dispatch when no runtime declares every required capability", async () => {
    const selection = await selectRuntime(
      { ...workUnit, capabilities: ["testing", "rust"] },
      [{ name: "fake", runtime: new FakeRuntime() }],
    );
    expect(selection.selected).toBeUndefined();
    expect(selection.missingCapabilities).toEqual(["rust"]);
  });

  it("blocks dispatch when the runtime cannot report capabilities", async () => {
    const broken = stubRuntime({ capabilities: () => Promise.reject(new Error("runtime unavailable")) });
    const selection = await selectRuntime(workUnit, [{ name: "broken", runtime: broken }]);
    expect(selection.selected).toBeUndefined();
    expect(selection.missingCapabilities).toEqual(["testing"]);
  });

  it("blocks an execution whose capabilities are unmet and records why", async () => {
    const clock = deterministic();
    const record = await executeWorkUnit({
      workUnit: { ...workUnit, capabilities: ["testing", "rust"] },
      worker,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      prompt: "implement",
      schema: workUnitSchema,
      ...clock,
    });
    expect(record.status).toBe("blocked");
    expect(record.failure).toBe("no_capable_runtime");
    expect(record.events.at(-1)?.payload).toMatchObject({ missingCapabilities: ["rust"] });
  });
});

describe("end-to-end execution", () => {
  it("executes a valid Work Unit and captures runtime evidence and isolation", async () => {
    const clock = deterministic();
    const record = await executeWorkUnit({
      workUnit,
      worker,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      prompt: "implement the bounded task",
      schema: workUnitSchema,
      ...clock,
    });

    expect(record.status).toBe("completed");
    expect(record.runtime).toBe("fake");
    expect(record.runtimeStatus).toBe("idle");

    // Worktree isolation is real, not nominal.
    expect(record.worktreePath).toBeDefined();
    expect(record.worktreePath).not.toBe(record.workspaceId);

    // Runtime evidence was captured.
    expect(record.runtimeEvidence?.runtime).toBe("fake");
    expect(record.runtimeEvidence?.events.map((event) => event.type)).toContain("worker.finished");

    // Traceable.
    expect(eventTypes(record)).toEqual([
      "work.validated",
      "workspace.created",
      "worktree.created",
      "worker.started",
      "worker.prompted",
      "worker.finished",
      "workspace.cleaned",
    ]);
    expect(record.events.every((event) => event.workUnitId === "FCT-006")).toBe(true);
  });

  it("preserves factory state when the runtime fails mid-execution", async () => {
    const broken = stubRuntime({
      createWorkspace: () => Promise.reject(new Error("worktree path is missing on disk")),
    });
    const clock = deterministic();
    const record = await executeWorkUnit({
      workUnit,
      worker,
      runtimes: [{ name: "stub", runtime: broken }],
      prompt: "implement",
      schema: workUnitSchema,
      ...clock,
    });

    expect(record.status).toBe("failed");
    expect(record.failure).toBe("workspace_failed");
    // Runtime failure does not erase the trace.
    expect(eventTypes(record)).toEqual(["work.validated", "runtime.failure"]);
    expect(record.events.at(-1)?.payload).toMatchObject({ failure: "workspace_failed" });
  });
});

describe("verification stays independent of worker completion", () => {
  it("blocks integration when the worker succeeded but verification failed", async () => {
    const clock = deterministic();
    const record = await executeWorkUnit({
      workUnit,
      worker,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      prompt: "implement",
      schema: workUnitSchema,
      ...clock,
    });
    expect(record.status).toBe("completed");

    const { result: verification } = await verify(failingRunner);
    expect(verification.status).toBe("failed");

    const { result } = await buildIntegrationResult({ execution: record, verification });
    expect(result.state).toBe("blocked");
    expect(result.reason).toBe("verification_failed");
  });

  it("does not let an exited worker forge verification success", async () => {
    const clock = deterministic();
    const record = await executeWorkUnit({
      workUnit,
      worker,
      runtimes: [{ name: "fake", runtime: new FakeRuntime(true) }],
      prompt: "implement",
      schema: workUnitSchema,
      ...clock,
    });
    expect(record.runtimeStatus).toBe("exited");
    expect(record.status).toBe("completed");

    // A crashed worker carries no verification evidence of its own.
    expect(
      record.runtimeEvidence?.events.every(
        (event: { type: string }) => event.type !== "verification.passed",
      ),
    ).toBe(true);

    const { result: verification } = await verify(failingRunner);
    const { result } = await buildIntegrationResult({ execution: record, verification });
    expect(result.state).toBe("blocked");
  });

  it("reaches ready only on independent passing verification", async () => {
    const clock = deterministic();
    const record = await executeWorkUnit({
      workUnit,
      worker,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      prompt: "implement",
      schema: workUnitSchema,
      ...clock,
    });

    const { result: verification, events } = await verify(passingRunner);
    expect(verification.status).toBe("passed");
    expect(events.map((event) => event.type)).toEqual(["verification.started", "verification.passed"]);

    const { result } = await buildIntegrationResult({ execution: record, verification, commit: "abc123" });
    expect(result.state).toBe("ready");
    expect(result.commit).toBe("abc123");
    expect(result.verification).toBe(verification);
    expect(result.events.map((event) => event.type)).toEqual(["integration.ready"]);
  });

  it("refuses to integrate verification evidence belonging to another Work Unit", async () => {
    const clock = deterministic();
    const record = await executeWorkUnit({
      workUnit,
      worker,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      prompt: "implement",
      schema: workUnitSchema,
      ...clock,
    });
    const { result: verification } = await verify(passingRunner, "FCT-999");
    const { result } = await buildIntegrationResult({ execution: record, verification });
    expect(result.state).toBe("blocked");
    expect(result.reason).toBe("verification_work_unit_mismatch");
  });
});

describe("shell verification", () => {
  it("reports per-check evidence and an overall failure", async () => {
    const { result } = await verify(failingRunner);
    expect(result.checks).toEqual([
      {
        name: "unit-tests",
        status: "failed",
        evidence: expect.stringContaining("exit=1"),
      },
    ]);
    expect(result.checks[0]?.evidence).toContain("1 test failed");
  });

  it("always numbers its attempt so repair limits are enforceable", async () => {
    const clock = deterministic();
    const { result } = await runShellVerification({
      workUnitId: workUnit.id,
      checks: [{ name: "unit-tests", command: "npm", args: ["test"] }],
      cwd: ".",
      runner: passingRunner,
      attempt: 2,
      ...clock,
    });
    expect(result.attempt).toBe(2);
    expect(result.status).toBe("passed");

    // Unnumbered verification still reports attempt 1, so counting is total.
    const first = await runShellVerification({
      workUnitId: workUnit.id,
      checks: [{ name: "unit-tests", command: "npm", args: ["test"] }],
      cwd: ".",
      runner: passingRunner,
      ...deterministic(),
    });
    expect(first.result.attempt).toBe(1);
  });
});