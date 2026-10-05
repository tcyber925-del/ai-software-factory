import type { EventRecord } from "./event-log.js";

/**
 * Reconstructs factory state from durable events alone.
 *
 * This is what makes the log worth keeping: terminal history is disposable, and a
 * completed, failed, or interrupted execution must all remain inspectable
 * without it.
 *
 * Runtime events are never treated as factory state. A runtime reporting
 * `worker.finished` does not make an execution complete; only factory events can
 * close a Work Unit out.
 */

export type ExecutionOutcome = "completed" | "failed" | "blocked" | "interrupted" | "in_progress";

export interface VerificationSummary {
  status: "passed" | "failed" | "blocked";
  /** Number of distinct verification attempts observed. */
  attempts: number;
}

export interface IntegrationSummary {
  state: "ready" | "blocked";
  reason: string;
}

export interface RunSummary {
  runId: string;
  parentRunId?: string;
  status: ExecutionOutcome;
  eventCount: number;
}

export interface ExecutionSummary {
  workUnitId: string;
  outcome: ExecutionOutcome;
  runs: RunSummary[];
  runtime?: string;
  revision?: string;
  workerId?: string;
  workspaceId?: string;
  worktreePath?: string;
  agentId?: string;
  verification?: VerificationSummary;
  integration?: IntegrationSummary;
  factoryEventCount: number;
  runtimeEventCount: number;
}

export function reconstructExecution(records: EventRecord[], workUnitId: string): ExecutionSummary {
  const mine = records.filter((record) => record.workUnitId === workUnitId);
  const factory = mine.filter((record) => record.source === "factory");
  const runtime = mine.filter((record) => record.source === "runtime");

  const summary: ExecutionSummary = {
    workUnitId,
    outcome: outcomeOf(factory, mine),
    runs: runsOf(mine),
    factoryEventCount: factory.length,
    runtimeEventCount: runtime.length,
  };

  const runtimeName = stringAt(factory, ["worker.started"], "runtime");
  if (runtimeName !== undefined) summary.runtime = runtimeName;

  const revision = stringAt(factory, ["worktree.created"], "baseRevision");
  if (revision !== undefined && revision !== "null") summary.revision = revision;

  const workerId = stringAt(factory, ["worker.started"], "workerId");
  if (workerId !== undefined) summary.workerId = workerId;

  const workspaceId = stringAt(factory, ["workspace.created"], "workspaceId");
  if (workspaceId !== undefined) summary.workspaceId = workspaceId;

  const worktreePath = stringAt(factory, ["worktree.created"], "worktreePath");
  if (worktreePath !== undefined && worktreePath !== "null") summary.worktreePath = worktreePath;

  const agentId = stringAt(factory, ["worker.started"], "agentId");
  if (agentId !== undefined) summary.agentId = agentId;

  const verification = verificationOf(factory);
  if (verification !== undefined) summary.verification = verification;

  const integration = integrationOf(factory);
  if (integration !== undefined) summary.integration = integration;

  return summary;
}

/** Counts repair/verification attempts so the factory repair limit can be enforced. */
export function countAttempts(records: EventRecord[], workUnitId: string): number {
  return records.filter(
    (record) => record.workUnitId === workUnitId && record.source === "factory" && record.type === "verification.started",
  ).length;
}

function verificationOf(factory: EventRecord[]): VerificationSummary | undefined {
  const passed = lastOf(factory, "verification.passed");
  const failed = lastOf(factory, "verification.failed");
  if (passed === undefined && failed === undefined) return undefined;
  const attempts = factory.filter((record) => record.type === "verification.started").length;
  return { status: passed === undefined ? "failed" : "passed", attempts };
}

function integrationOf(factory: EventRecord[]): IntegrationSummary | undefined {
  const ready = lastOf(factory, "integration.ready");
  if (ready !== undefined) return { state: "ready", reason: payloadString(ready, "reason") ?? "verification_passed" };
  const blocked = lastOf(factory, "integration.blocked");
  if (blocked !== undefined) return { state: "blocked", reason: payloadString(blocked, "reason") ?? "unknown" };
  return undefined;
}

function outcomeOf(factory: EventRecord[], mine: EventRecord[]): ExecutionOutcome {
  if (lastOf(factory, "integration.ready") !== undefined) return "completed";

  const blocked = lastOf(factory, "integration.blocked");
  if (blocked !== undefined) {
    const reason = payloadString(blocked, "reason") ?? "";
    return reason.startsWith("execution_blocked") ? "blocked" : "failed";
  }
  if (lastOf(factory, "runtime.failure") !== undefined) return "failed";
  if (lastOf(factory, "work.rejected") !== undefined) return "blocked";
  if (lastOf(factory, "work.blocked") !== undefined) return "blocked";

  const started = factory.some((record) => record.type === "worker.started");
  const finished = mine.some((record) => record.type === "worker.finished");
  return started && !finished ? "interrupted" : "in_progress";
}

function runsOf(mine: EventRecord[]): RunSummary[] {
  const order: string[] = [];
  const byRun = new Map<string, EventRecord[]>();
  for (const record of mine) {
    if (!byRun.has(record.runId)) {
      byRun.set(record.runId, []);
      order.push(record.runId);
    }
    byRun.get(record.runId)?.push(record);
  }
  return order.map((runId) => {
    const events = byRun.get(runId) ?? [];
    const parent = events.find((event) => event.parentRunId !== undefined)?.parentRunId;
    const run: RunSummary = {
      runId,
      status: outcomeOf(
        events.filter((event) => event.source === "factory"),
        events,
      ),
      eventCount: events.length,
    };
    if (parent !== undefined) run.parentRunId = parent;
    return run;
  });
}

function lastOf(records: EventRecord[], type: string): EventRecord | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record !== undefined && record.type === type) return record;
  }
  return undefined;
}

function payloadString(record: EventRecord, key: string): string | undefined {
  const value = record.payload[key];
  return typeof value === "string" ? value : undefined;
}

function stringAt(records: EventRecord[], types: string[] | string, key: string): string | undefined {
  const wanted = Array.isArray(types) ? types : [types];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined || !wanted.includes(record.type)) continue;
    const value = record.payload[key];
    if (typeof value === "string") return value;
    return undefined;
  }
  return undefined;
}