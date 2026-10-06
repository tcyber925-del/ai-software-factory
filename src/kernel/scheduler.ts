import type { Conflict, ConflictReason, WorkerRuntime, WorkUnit } from "../protocol.js";
import type { EventLog } from "../state/event-log.js";
import type { LabelledRuntime } from "./work-unit.js";
import type { ExecutionRiskInput } from "../security/risk.js";

/**
 * Conservative dependency and conflict scheduler.
 *
 * The scheduler decides only *ordering and grouping*. It never decides that work
 * is correct, and it cannot: `SchedulePlan` has no field for verification or
 * integration state. Integration remains reachable only through independent
 * verification, so scheduling cannot bypass that gate.
 *
 * Conservative by construction:
 *
 * - A Work Unit runs only after every dependency has completed.
 * - Two Work Units share a parallel batch only when no conflict is detected
 *   between them. Any doubt serializes.
 * - A Work Unit that does not declare what it touches is treated as having
 *   uncertain ownership, and is serialized against everything.
 */

/** A Work Unit plus the scheduling facts the factory must know to place it safely. */
export interface ScheduledWorkUnit {
  workUnit: WorkUnit;
  /** Work Unit ids that must complete first. */
  dependsOn?: string[];
  /** Repository paths this Work Unit may modify. */
  paths?: string[];
  /** Shared API/schema identifiers it modifies. */
  contracts?: string[];
  /** Runtime identifiers it assumes. */
  runtimes?: string[];
  /** Exclusive resources it needs, e.g. a protected branch. */
  protectedResources?: string[];
  /**
   * Declared execution risk, consumed by the security gate before dispatch.
   *
   * These signals live on the plan rather than on `WorkUnit` because the Work Unit
   * is the portable contract and deliberately says nothing about how it will be
   * executed. Risk is a property of *this dispatch*, and it belongs with the other
   * dispatch facts.
   *
   * They are declared, never inferred. Deriving "consumes untrusted content" from
   * the goal string would be a guess dressed as a control, which is the exact
   * failure mode the factory exists to prevent. The gate enforces what is declared;
   * it is not content analysis. See `docs/security-policy.md`.
   */
  risk?: ExecutionRiskInput;
}

export type DecisionOutcome = "scheduled" | "blocked";

export interface SchedulingDecision {
  workUnitId: string;
  outcome: DecisionOutcome;
  /** Zero-based parallel batch. Absent when blocked. */
  batch?: number;
  reason?: string;
  missingCapabilities?: string[];
  conflictsWith?: string[];
}

export interface SchedulePlan {
  /** Each batch may run concurrently; batches run in order. */
  batches: string[][];
  decisions: SchedulingDecision[];
  conflicts: Conflict[];
  /** Dependency cycles, which cannot be ordered at all. */
  cycles: string[][];
}

export interface PlanScheduleOptions {
  units: ScheduledWorkUnit[];
  /** Available runtimes. A unit needing unavailable capabilities is blocked. */
  runtimes?: LabelledRuntime[];
  eventLog?: EventLog;
  runId?: string;
  now?: () => string;
}

export async function planSchedule(options: PlanScheduleOptions): Promise<SchedulePlan> {
  const units = options.units;
  const byId = new Map(units.map((unit) => [unit.workUnit.id, unit]));

  const decisions: SchedulingDecision[] = [];
  const conflicts: Conflict[] = [];
  const duplicateIds = findDuplicates(units.map((unit) => unit.workUnit.id));
  const cyclic = findCycles(units, byId);

  for (const id of duplicateIds) {
    decisions.push({ workUnitId: id, outcome: "blocked", reason: "duplicate_work_unit_id" });
  }

  for (const cycle of cyclic) {
    for (const id of cycle) {
      decisions.push({ workUnitId: id, outcome: "blocked", reason: "dependency_cycle" });
    }
  }

  const blocked = new Set([...duplicateIds, ...cyclic.flat()]);

  // A dependency that no scheduled unit can satisfy is a silent stall; catch it.
  for (const unit of units) {
    if (blocked.has(unit.workUnit.id)) continue;
    for (const dependency of unit.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        blocked.add(unit.workUnit.id);
        decisions.push({
          workUnitId: unit.workUnit.id,
          outcome: "blocked",
          reason: "unsatisfied_dependency",
          conflictsWith: [dependency],
        });
      }
    }
  }

  // Capability matching needs known capacity. When no runtime inventory is
  // supplied the scheduler is doing ordering and conflict analysis only, and
  // must not invent a "missing capability" verdict from an unknown fleet.
  const unmetCapabilities =
    options.runtimes === undefined ? new Map<string, string[]>() : await capabilityBlockers(units, options.runtimes, blocked);
  for (const [id, missing] of unmetCapabilities) {
    blocked.add(id);
    decisions.push({ workUnitId: id, outcome: "blocked", reason: "missing_capabilities", missingCapabilities: missing });
  }

  const batches: string[][] = [];
  const completed = new Set<string>();

  for (;;) {
    const ready = units
      .map((unit) => unit.workUnit.id)
      .filter((id) => !blocked.has(id) && !completed.has(id))
      .filter((id) => dependenciesMet(id, byId, completed));

    if (ready.length === 0) break;

    const batch: string[] = [];
    const deferred: string[] = [];
    for (const id of ready) {
      const conflicting = batch.filter((other) => detectConflict(byId.get(id), byId.get(other)) !== undefined);
      if (conflicting.length === 0) {
        batch.push(id);
      } else {
        deferred.push(id);
      }
    }

    // Everything deferred this round would otherwise deadlock if the batch is
    // empty; an empty batch means no progress is possible.
    if (batch.length === 0) {
      for (const id of deferred) {
        blocked.add(id);
        decisions.push({ workUnitId: id, outcome: "blocked", reason: "unresolvable_conflict" });
      }
      break;
    }

    const batchIndex = batches.length;
    for (const id of batch) {
      completed.add(id);
      decisions.push({ workUnitId: id, outcome: "scheduled", batch: batchIndex });
    }
    batches.push(batch);
  }

  // Record every conflict the plan actually relied on.
  for (const reason of conflictReasons()) {
    for (let i = 0; i < units.length; i += 1) {
      for (let j = i + 1; j < units.length; j += 1) {
        const left = units[i];
        const right = units[j];
        if (left === undefined || right === undefined) continue;
        const found = detectConflict(left, right);
        if (found?.reason === reason) conflicts.push(toConflict(found.reason, left.workUnit.id, right.workUnit.id, found.details));
      }
    }
  }

  const plan: SchedulePlan = { batches, decisions, conflicts, cycles: cyclic };
  await recordDecisions(plan, options);
  return plan;
}

function dependenciesMet(id: string, byId: Map<string, ScheduledWorkUnit>, completed: Set<string>): boolean {
  const unit = byId.get(id);
  if (unit === undefined) return false;
  return (unit.dependsOn ?? []).every((dependency) => completed.has(dependency));
}

export interface DetectedConflict {
  reason: ConflictReason;
  details: string;
}

/**
 * Returns the conflict between two units, or undefined when they are safe to run
 * together. Reason precedence is fixed so decisions stay deterministic.
 */
export function detectConflict(left: ScheduledWorkUnit | undefined, right: ScheduledWorkUnit | undefined): DetectedConflict | undefined {
  if (left === undefined || right === undefined) return undefined;
  const a = left.workUnit.id;
  const b = right.workUnit.id;

  if ((left.dependsOn ?? []).includes(b) || (right.dependsOn ?? []).includes(a)) {
    return { reason: "dependency", details: `${a} and ${b} declare a dependency relationship` };
  }

  const overlap = intersect(left.paths ?? [], right.paths ?? []);
  if (overlap.length > 0) {
    return { reason: "overlapping_paths", details: `shared paths: ${overlap.join(", ")}` };
  }

  const contracts = intersect(left.contracts ?? [], right.contracts ?? []);
  if (contracts.length > 0) {
    return { reason: "shared_contract", details: `shared contracts: ${contracts.join(", ")}` };
  }

  const runtimes = intersect(left.runtimes ?? [], right.runtimes ?? []);
  if (runtimes.length > 0) {
    return { reason: "runtime_assumption", details: `shared runtime assumptions: ${runtimes.join(", ")}` };
  }

  const resources = intersect(left.protectedResources ?? [], right.protectedResources ?? []);
  if (resources.length > 0) {
    return { reason: "protected_resource", details: `shared protected resources: ${resources.join(", ")}` };
  }

  // Anything not fully described is serialized against everything. A Work Unit
  // that does not say what it touches could touch anything.
  if (isUncertain(left) || isUncertain(right)) {
    return {
      reason: "uncertain",
      details: `${isUncertain(left) ? a : b} does not declare its touched surface`,
    };
  }

  return undefined;
}

function isUncertain(unit: ScheduledWorkUnit): boolean {
  const hasPaths = (unit.paths ?? []).length > 0;
  const hasContracts = (unit.contracts ?? []).length > 0;
  return !hasPaths && !hasContracts;
}

/**
 * Two paths conflict when either is the other, or one contains the other as a
 * directory prefix. Comparing normalized prefixes keeps `src/kernel` conflicting
 * with `src/kernel/execution.ts` without treating it as a string substring.
 */
function intersect(left: string[], right: string[]): string[] {
  const shared: string[] = [];
  for (const a of left) {
    for (const b of right) {
      if (pathsOverlap(a, b)) {
        shared.push(a === b ? a : `${a} <-> ${b}`);
      }
    }
  }
  return [...new Set(shared)];
}

function pathsOverlap(a: string, b: string): boolean {
  const left = normalizePath(a);
  const right = normalizePath(b);
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}

async function capabilityBlockers(
  units: ScheduledWorkUnit[],
  runtimes: LabelledRuntime[],
  alreadyBlocked: Set<string>,
): Promise<Map<string, string[]>> {
  const blockers = new Map<string, string[]>();
  for (const unit of units) {
    const id = unit.workUnit.id;
    if (alreadyBlocked.has(id)) continue;

    const provided = new Set<string>();
    for (const candidate of runtimes) {
      try {
        for (const capability of await candidate.runtime.capabilities()) provided.add(capability);
      } catch {
        // An unreachable runtime provides nothing.
      }
    }
    const missing = unit.workUnit.capabilities.filter((capability) => !provided.has(capability));
    if (missing.length > 0) blockers.set(id, missing);
  }
  return blockers;
}

/** Reports dependency cycles so they are blocked rather than silently dropped. */
function findCycles(units: ScheduledWorkUnit[], byId: Map<string, ScheduledWorkUnit>): string[][] {
  const cycles: string[][] = [];
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const walk = (id: string): void => {
    if (onStack.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    onStack.add(id);
    stack.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency)) walk(dependency);
    }
    stack.pop();
    onStack.delete(id);
  };

  for (const unit of units) walk(unit.workUnit.id);
  return cycles;
}

function findDuplicates(ids: string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

function toConflict(reason: ConflictReason, a: string, b: string, details: string): Conflict {
  return { id: `${reason}:${[a, b].sort().join("|")}`, workUnits: [a, b].sort(), reason, details };
}

function conflictReasons(): ConflictReason[] {
  return ["dependency", "overlapping_paths", "shared_contract", "runtime_assumption", "protected_resource", "uncertain"];
}

async function recordDecisions(plan: SchedulePlan, options: PlanScheduleOptions): Promise<void> {
  const log = options.eventLog;
  if (log === undefined) return;
  const runId = options.runId ?? "schedule";
  const now = options.now ?? (() => new Date().toISOString());

  await log.append([
    {
      workUnitId: plan.batches[0]?.[0] ?? "scheduler",
      runId,
      source: "factory",
      type: "scheduling.planned",
      payload: {
        plannedAt: now(),
        batches: plan.batches,
        conflicts: plan.conflicts.length,
        blocked: plan.decisions.filter((decision) => decision.outcome === "blocked").length,
      },
    },
  ]);

  await log.append(
    plan.decisions.map((decision) => ({
      workUnitId: decision.workUnitId,
      runId,
      source: "factory" as const,
      type: decision.outcome === "scheduled" ? "scheduling.scheduled" : "scheduling.blocked",
      payload: { ...decision },
    })),
  );
}