import { randomUUID } from "node:crypto";
import type {
  AgentRef,
  ExecutionEvent,
  RuntimeEvidence,
  RuntimeFailure,
  Worker,
  WorkerRuntime,
  WorkUnit,
  WorkspaceRef,
} from "../protocol.js";
import type { JsonSchema } from "./json-schema.js";
import type { LabelledRuntime } from "./work-unit.js";
import { selectRuntime, validateWorkUnit } from "./work-unit.js";

/**
 * The first end-to-end execution slice.
 *
 * Invariants enforced here, not merely documented:
 *
 * 1. A Work Unit that fails validation never reaches a runtime.
 * 2. A Work Unit whose capabilities are unmet never reaches a runtime.
 * 3. Runtime failure never erases factory state: the returned record always
 *    carries the events observed so far.
 * 4. `status: "completed"` means the runtime finished. It does NOT mean the
 *    Work Unit is correct. Only verification can decide that, and it runs
 *    separately via `runShellVerification`.
 */

export type ExecutionStatus = "completed" | "failed" | "blocked";
export type ExecutionFailure = RuntimeFailure | "work_unit_invalid" | "no_capable_runtime";

export interface ExecutionRecord {
  workUnitId: string;
  status: ExecutionStatus;
  events: ExecutionEvent[];
  runtime?: string;
  workspaceId?: string;
  worktreePath?: string;
  agentId?: string;
  /** Runtime-reported status. Operational evidence only, never proof of correctness. */
  runtimeStatus?: string;
  runtimeEvidence?: RuntimeEvidence;
  failure?: ExecutionFailure;
}

export interface ExecuteWorkUnitOptions {
  workUnit: WorkUnit;
  worker: Worker;
  runtimes: LabelledRuntime[];
  prompt: string;
  schema: JsonSchema;
  baseRevision?: string;
  /** Injected for deterministic tests. */
  id?: () => string;
  now?: () => string;
}

export async function executeWorkUnit(options: ExecuteWorkUnitOptions): Promise<ExecutionRecord> {
  const { workUnit, worker, runtimes, prompt, schema, baseRevision } = options;
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  const events: ExecutionEvent[] = [];
  const emit = (type: string, payload: Record<string, unknown>): void => {
    events.push({ id: id(), workUnitId: workUnit.id, type, timestamp: now(), payload });
  };

  const validation = validateWorkUnit(workUnit, schema);
  if (!validation.valid) {
    emit("work.rejected", { issues: validation.issues });
    return { workUnitId: workUnit.id, status: "blocked", events, failure: "work_unit_invalid" };
  }
  emit("work.validated", { capabilities: workUnit.capabilities, acceptanceCriteria: workUnit.acceptanceCriteria });

  const selection = await selectRuntime(workUnit, runtimes);
  if (selection.selected === undefined) {
    emit("work.blocked", { reason: "no_capable_runtime", missingCapabilities: selection.missingCapabilities });
    return { workUnitId: workUnit.id, status: "blocked", events, failure: "no_capable_runtime" };
  }

  const chosen: LabelledRuntime = selection.selected;
  const runtime: WorkerRuntime = chosen.runtime;

  let workspace: WorkspaceRef | undefined;
  let agent: AgentRef | undefined;

  try {
    workspace = await runtime.createWorkspace(workUnit);
    emit("workspace.created", { runtime: chosen.name, workspaceId: workspace.id, path: workspace.path });

    const worktree = await runtime.createWorktree(workspace, baseRevision ?? workUnit.baseRevision);
    workspace = worktree;
    emit("worktree.created", { worktreePath: worktree.worktreePath ?? null, baseRevision: baseRevision ?? workUnit.baseRevision ?? null });

    agent = await runtime.startAgent(worktree, worker);
    emit("worker.started", { runtime: chosen.name, agentId: agent.id, workerId: worker.id });

    await runtime.promptAgent(agent, prompt);
    emit("worker.prompted", { agentId: agent.id });

    const runtimeStatus = await runtime.waitAgent(agent, 120_000);
    const runtimeEvidence = await runtime.collectRuntimeEvidence(agent);
    emit("worker.finished", { agentId: agent.id, runtimeStatus });

    const record: ExecutionRecord = {
      workUnitId: workUnit.id,
      status: "completed",
      events,
      runtime: chosen.name,
      agentId: agent.id,
      runtimeStatus,
      runtimeEvidence,
    };
    assignOptional(record, "workspaceId", workspace.id);
    assignOptional(record, "worktreePath", workspace.worktreePath);
    return record;
  } catch (error) {
    const failure = asRuntimeFailure(error);
    emit("runtime.failure", { runtime: chosen.name, failure, message: messageOf(error) });
    const record: ExecutionRecord = {
      workUnitId: workUnit.id,
      status: "failed",
      events,
      runtime: chosen.name,
      failure,
    };
    assignOptional(record, "workspaceId", workspace?.id);
    assignOptional(record, "worktreePath", workspace?.worktreePath);
    assignOptional(record, "agentId", agent?.id);
    return record;
  } finally {
    // Cleanup is best-effort: a cleanup failure must not erase the record of
    // what happened during execution.
    if (workspace !== undefined) {
      try {
        await runtime.cleanupWorkspace(workspace);
        emit("workspace.cleaned", { workspaceId: workspace.id });
      } catch (error) {
        emit("workspace.cleanup_failed", { workspaceId: workspace.id, message: messageOf(error) });
      }
    }
  }
}

/**
 * Assigns an optional field only when a value exists. Required because the
 * project compiles with `exactOptionalPropertyTypes`, where writing an explicit
 * `undefined` is not the same as omitting the key.
 */
function assignOptional<K extends "workspaceId" | "worktreePath" | "agentId">(
  record: ExecutionRecord,
  key: K,
  value: string | undefined,
): void {
  if (value !== undefined) record[key] = value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRuntimeFailure(error: unknown): RuntimeFailure {
  const message = messageOf(error).toLowerCase();
  if (message.includes("not found") || message.includes("enoent") || message.includes("connect")) return "unavailable";
  if (message.includes("protocol") || message.includes("schema")) return "protocol_incompatible";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("blocked") || message.includes("permission") || message.includes("auth")) return "blocked";
  if (message.includes("workspace") || message.includes("worktree")) return "workspace_failed";
  if (message.includes("cleanup")) return "cleanup_failed";
  if (message.includes("start")) return "startup_failed";
  return "agent_exited";
}