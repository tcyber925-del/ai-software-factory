import type { WorkerRuntime, WorkUnit } from "../protocol.js";
import type { JsonSchema, ValidationIssue } from "./json-schema.js";
import { validateAgainstSchema } from "./json-schema.js";

/**
 * Work Unit validation and runtime selection.
 *
 * `schemas/work-unit.schema.json` is the wire contract and uses snake_case;
 * the TypeScript `WorkUnit` is the internal contract and uses camelCase. The
 * projection below is the single place that correspondence is expressed, so it
 * is covered by tests rather than left implicit.
 */

export interface WorkUnitValidation {
  valid: boolean;
  issues: ValidationIssue[];
}

/** A runtime plus a stable label, so selection results are inspectable. */
export interface LabelledRuntime {
  name: string;
  runtime: WorkerRuntime;
}

export interface RuntimeCandidate {
  name: string;
  available: boolean;
  missing: string[];
}

export interface RuntimeSelection {
  selected?: LabelledRuntime;
  candidates: RuntimeCandidate[];
  missingCapabilities: string[];
}

export function workUnitToWireForm(workUnit: WorkUnit): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: workUnit.id,
    goal: workUnit.goal,
    repository: workUnit.repository,
    capabilities: workUnit.capabilities,
    acceptance_criteria: workUnit.acceptanceCriteria,
  };
  if (workUnit.baseRevision !== undefined) wire["base_revision"] = workUnit.baseRevision;
  if (workUnit.scope !== undefined) wire["scope"] = workUnit.scope;
  if (workUnit.verification !== undefined) wire["verification"] = workUnit.verification;
  if (workUnit.autonomy !== undefined) wire["autonomy"] = workUnit.autonomy;
  return wire;
}

export function validateWorkUnit(workUnit: WorkUnit, schema: JsonSchema): WorkUnitValidation {
  const issues = validateAgainstSchema(workUnitToWireForm(workUnit), schema);
  if (workUnit.acceptanceCriteria.length === 0) {
    issues.push({ path: "$.acceptance_criteria", message: "a Work Unit must declare acceptance criteria" });
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Conservative selection: a runtime qualifies only when it declares every
 * capability the Work Unit requires. When several qualify, the first in the
 * supplied order is chosen so selection stays deterministic.
 *
 * A Work Unit whose capabilities cannot be satisfied blocks dispatch. It is
 * never downgraded to a partially capable runtime.
 */
export async function selectRuntime(workUnit: WorkUnit, runtimes: LabelledRuntime[]): Promise<RuntimeSelection> {
  const candidates: RuntimeCandidate[] = [];
  let selected: LabelledRuntime | undefined;

  for (const candidate of runtimes) {
    const missing = await missingCapabilities(workUnit, candidate.runtime);
    candidates.push({ name: candidate.name, available: missing.length === 0, missing });
    if (missing.length === 0 && selected === undefined) selected = candidate;
  }

  const unmet = [...new Set(candidates.flatMap((candidate) => candidate.missing))].sort();
  return selected === undefined
    ? { candidates, missingCapabilities: unmet }
    : { selected, candidates, missingCapabilities: unmet };
}

/**
 * A runtime that cannot report its capabilities cannot be selected. Treating an
 * unreachable runtime as "provides nothing" keeps dispatch blocked rather than
 * silently degrading the worker.
 */
async function missingCapabilities(workUnit: WorkUnit, runtime: WorkerRuntime): Promise<string[]> {
  let declared: unknown;
  try {
    declared = await runtime.capabilities();
  } catch {
    return [...workUnit.capabilities];
  }
  if (!Array.isArray(declared)) return [...workUnit.capabilities];
  const provided = new Set(declared.filter((value): value is string => typeof value === "string"));
  return workUnit.capabilities.filter((capability) => !provided.has(capability));
}