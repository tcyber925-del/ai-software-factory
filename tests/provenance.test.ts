import { mkdtemp, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeRuntime } from "../src/fake-runtime.js";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { executeWorkUnit } from "../src/kernel/execution.js";
import { buildIntegrationResult } from "../src/kernel/integration.js";
import type { ShellRunner } from "../src/adapters/verification/shell.js";
import { runShellVerification } from "../src/adapters/verification/shell.js";
import type { EventLog } from "../src/state/event-log.js";
import { InMemoryEventLog, JsonlEventLog } from "../src/state/event-log.js";
import { countAttempts, reconstructExecution } from "../src/state/provenance.js";
import type { WorkUnit, Worker } from "../src/protocol.js";

const workUnitSchema: JsonSchema = {
  type: "object",
  required: ["id", "goal", "repository", "capabilities", "acceptance_criteria"],
  properties: {
    id: { type: "string", minLength: 1 },
    goal: { type: "string", minLength: 1 },
    repository: { type: "string", minLength: 1 },
    capabilities: { type: "array", minItems: 1, items: { type: "string" } },
    acceptance_criteria: { type: "array", minItems: 1, items: { type: "string" } },
  },
};

const workUnit: WorkUnit = {
  id: "FCT-011",
  goal: "record durable provenance",
  repository: "example/project",
  capabilities: ["testing"],
  acceptanceCriteria: ["execution is reconstructable"],
  baseRevision: "abc123",
};

const worker: Worker = { id: "worker-fake", capabilities: ["testing"], runtime: "fake" };

const passingRunner: ShellRunner = {
  async run() {
    return { stdout: "ok", stderr: "", exitCode: 0 };
  },
};

const failingRunner: ShellRunner = {
  async run() {
    return { stdout: "", stderr: "boom", exitCode: 1 };
  },
};

function clock() {
  let n = 0;
  return { id: () => `e${++n}`, now: () => "2026-01-01T00:00:00.000Z" };
}

async function tempLog(): Promise<{ log: JsonlEventLog; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "factory-log-"));
  const path = join(dir, "events.jsonl");
  return { log: new JsonlEventLog(path), path };
}

async function runExecution(eventLog: EventLog, runId = "run-1") {
  return executeWorkUnit({
    workUnit,
    worker,
    runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
    prompt: "implement",
    schema: workUnitSchema,
    eventLog,
    runId,
    ...clock(),
  });
}

describe("append-only event log", () => {
  it("survives a new process reading only the file", async () => {
    const { log, path } = await tempLog();
    await log.append([{ workUnitId: "FCT-011", runId: "r1", source: "factory", type: "work.validated", payload: { a: 1 } }]);

    // A fresh instance sharing nothing but the path must recover the history.
    const reopened = new JsonlEventLog(path);
    const records = await reopened.readAll();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ seq: 1, workUnitId: "FCT-011", runId: "r1", type: "work.validated" });
  });

  it("preserves insertion order as the authoritative sequence", async () => {
    const { log } = await tempLog();
    await log.append([
      { workUnitId: "w", runId: "r", source: "factory", type: "first", payload: {} },
      { workUnitId: "w", runId: "r", source: "factory", type: "second", payload: {} },
    ]);
    await log.append([{ workUnitId: "w", runId: "r", source: "factory", type: "third", payload: {} }]);

    const records = await log.readAll();
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.type)).toEqual(["first", "second", "third"]);
  });

  it("never rewrites earlier lines when appending", async () => {
    const { log, path } = await tempLog();
    await log.append([{ workUnitId: "w", runId: "r", source: "factory", type: "first", payload: {} }]);
    const afterFirst = await readFile(path, "utf8");
    await log.append([{ workUnitId: "w", runId: "r", source: "factory", type: "second", payload: {} }]);
    const afterSecond = await readFile(path, "utf8");
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
  });

  it("treats a corrupt trailing line as recoverable instead of failing the read", async () => {
    const { log, path } = await tempLog();
    await log.append([{ workUnitId: "w", runId: "r", source: "factory", type: "good", payload: {} }]);
    // Simulate a partially flushed final record.
    await appendFile(path, '{"workUnitId":"w","runId":"r","sou\n');

    const records = await new JsonlEventLog(path).readAll();
    expect(records.map((record) => record.type)).toEqual(["good"]);
  });

  it("reads a missing log as empty rather than throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-log-"));
    expect(await new JsonlEventLog(join(dir, "absent.jsonl")).readAll()).toEqual([]);
  });
});

describe("runtime events stay distinguishable from factory state", () => {
  it("tags runtime-observed events separately from factory events", async () => {
    const log = new InMemoryEventLog();
    await runExecution(log);

    const stored = log.stored();
    const runtime = stored.filter((event) => event.source === "runtime");
    const factory = stored.filter((event) => event.source === "factory");

    expect(runtime.length).toBeGreaterThan(0);
    expect(factory.length).toBeGreaterThan(0);
    // No runtime event may masquerade as factory state.
    expect(runtime.every((event) => !event.type.startsWith("verification."))).toBe(true);
    expect(runtime.every((event) => !event.type.startsWith("integration."))).toBe(true);
  });
});

describe("reconstruction", () => {
  it("reconstructs a completed execution without terminal history", async () => {
    const log = new InMemoryEventLog();
    const execution = await runExecution(log);
    const { result: verification } = await runShellVerification({
      workUnitId: workUnit.id,
      checks: [{ name: "unit-tests", command: "npm", args: ["test"] }],
      cwd: ".",
      runner: passingRunner,
      eventLog: log,
      runId: "run-1",
      ...clock(),
    });
    expect(execution.status).toBe("completed");
    await buildIntegrationResult({ execution, verification, eventLog: log, runId: "run-1" });

    const summary = reconstructExecution(await log.readAll(), "FCT-011");
    expect(summary.outcome).toBe("completed");
    expect(summary.runtime).toBe("fake");
    expect(summary.revision).toBe("abc123");
    expect(summary.workerId).toBe("worker-fake");
    expect(summary.workspaceId).toBe("workspace-1");
    expect(summary.worktreePath).toBeDefined();
    expect(summary.verification).toEqual({ status: "passed", attempts: 1 });
    expect(summary.integration).toEqual({ state: "ready", reason: "verification_passed" });
    expect(summary.runs.map((run) => run.runId)).toEqual(["run-1"]);
  });

  it("keeps a failed execution inspectable", async () => {
    const log = new InMemoryEventLog();
    const execution = await runExecution(log);
    const { result: verification } = await runShellVerification({
      workUnitId: workUnit.id,
      checks: [{ name: "unit-tests", command: "npm", args: ["test"] }],
      cwd: ".",
      runner: failingRunner,
      eventLog: log,
      runId: "run-1",
      ...clock(),
    });
    await buildIntegrationResult({ execution, verification, eventLog: log, runId: "run-1" });

    const summary = reconstructExecution(await log.readAll(), "FCT-011");
    expect(summary.outcome).toBe("failed");
    expect(summary.verification).toEqual({ status: "failed", attempts: 1 });
    expect(summary.integration?.state).toBe("blocked");
    expect(summary.integration?.reason).toBe("verification_failed");
  });

  it("detects an interrupted execution rather than calling it complete", async () => {
    const log = new InMemoryEventLog();
    // Start an agent but never record finishing: the process died mid-run.
    await log.append([
      { workUnitId: "FCT-011", runId: "run-1", source: "factory", type: "work.validated", payload: {} },
      { workUnitId: "FCT-011", runId: "run-1", source: "factory", type: "worker.started", payload: { runtime: "fake", agentId: "a1", workerId: "w1" } },
    ]);

    const summary = reconstructExecution(await log.readAll(), "FCT-011");
    expect(summary.outcome).toBe("interrupted");
    expect(summary.integration).toBeUndefined();
  });

  it("does not let a runtime event close out factory state", async () => {
    const log = new InMemoryEventLog();
    // A runtime claiming the worker finished, with no factory record of it.
    await log.append([
      { workUnitId: "FCT-011", runId: "run-1", source: "factory", type: "worker.started", payload: { runtime: "fake" } },
      { workUnitId: "FCT-011", runId: "run-1", source: "runtime", type: "worker.finished", payload: {} },
    ]);

    const summary = reconstructExecution(await log.readAll(), "FCT-011");
    expect(summary.outcome).not.toBe("completed");
    expect(summary.integration).toBeUndefined();
  });

  it("records a blocked Work Unit", async () => {
    const log = new InMemoryEventLog();
    await executeWorkUnit({
      workUnit: { ...workUnit, capabilities: ["testing", "rust"] },
      worker,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      prompt: "implement",
      schema: workUnitSchema,
      eventLog: log,
      runId: "run-1",
      ...clock(),
    });

    const summary = reconstructExecution(await log.readAll(), "FCT-011");
    expect(summary.outcome).toBe("blocked");
  });
});

describe("repair attempt accounting", () => {
  it("counts every verification attempt so the repair limit can be enforced", async () => {
    const log = new InMemoryEventLog();
    for (const attempt of [1, 2, 3]) {
      await runShellVerification({
        workUnitId: workUnit.id,
        checks: [{ name: "unit-tests", command: "npm", args: ["test"] }],
        cwd: ".",
        runner: failingRunner,
        attempt,
        eventLog: log,
        runId: "run-1",
        ...clock(),
      });
    }

    const records = await log.readAll();
    expect(countAttempts(records, "FCT-011")).toBe(3);
    expect(reconstructExecution(records, "FCT-011").verification?.attempts).toBe(3);
  });

  it("counts attempts per Work Unit, not globally", async () => {
    const log = new InMemoryEventLog();
    for (const attempt of [1, 2]) {
      await runShellVerification({
        workUnitId: "FCT-011",
        checks: [{ name: "t", command: "npm", args: ["test"] }],
        cwd: ".",
        runner: failingRunner,
        attempt,
        eventLog: log,
        runId: "run-1",
        ...clock(),
      });
    }
    await runShellVerification({
      workUnitId: "FCT-999",
      checks: [{ name: "t", command: "npm", args: ["test"] }],
      cwd: ".",
      runner: failingRunner,
      eventLog: log,
      runId: "run-9",
      ...clock(),
    });

    const records = await log.readAll();
    expect(countAttempts(records, "FCT-011")).toBe(2);
    expect(countAttempts(records, "FCT-999")).toBe(1);
  });
});

describe("correlation and parent-child identifiers", () => {
  it("records parentRunId when supplied", async () => {
    const log = new InMemoryEventLog();
    await executeWorkUnit({
      workUnit,
      worker,
      runtimes: [{ name: "fake", runtime: new FakeRuntime() }],
      prompt: "implement",
      schema: workUnitSchema,
      eventLog: log,
      runId: "run-2",
      parentRunId: "run-1",
      ...clock(),
    });

    const records = await log.readAll();
    expect(records.every((record) => record.parentRunId === "run-1")).toBe(true);

    const summary = reconstructExecution(records, "FCT-011");
    expect(summary.runs).toHaveLength(1);
    expect(summary.runs[0]?.parentRunId).toBe("run-1");
  });

  it("separates multiple runs of the same Work Unit", async () => {
    const log = new InMemoryEventLog();
    await runExecution(log, "run-1");
    await runExecution(log, "run-2");

    const summary = reconstructExecution(await log.readAll(), "FCT-011");
    expect(summary.runs.map((run) => run.runId)).toEqual(["run-1", "run-2"]);
  });
});