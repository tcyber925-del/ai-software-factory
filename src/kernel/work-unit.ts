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

/**
 * The inverse of `workUnitToWireForm`, for reading the published wire contract.
 *
 * Kept next to its counterpart on purpose: the snake_case/camelCase mapping is the
 * thing most likely to drift, and having both directions in one file is what makes
 * the round trip checkable rather than assumed.
 *
 * Throws on a structurally wrong value. A malformed Work Unit must not become a
 * partially-populated object that happens to validate.
 */
export function workUnitFromWireForm(wire: unknown): WorkUnit {
  if (typeof wire !== "object" || wire === null) {
    throw new Error("a Work Unit must be an object");
  }
  const source = wire as Record<string, unknown>;

  const required = ["id", "goal", "repository", "capabilities", "acceptance_criteria"] as const;
  for (const field of required) {
    if (source[field] === undefined) throw new Error(`work unit is missing required field '${field}'`);
  }
  if (typeof source["id"] !== "string" || source["id"] === "") {
    throw new Error("work unit 'id' must be a non-empty string");
  }
  if (typeof source["goal"] !== "string" || source["goal"] === "") {
    throw new Error(`work unit '${source["id"]}': 'goal' must be a non-empty string`);
  }
  if (typeof source["repository"] !== "string" || source["repository"] === "") {
    throw new Error(`work unit '${source["id"]}': 'repository' must be a non-empty string`);
  }

  const capabilities = requireStringArray(source["capabilities"], "capabilities", String(source["id"]));
  const acceptanceCriteria = requireStringArray(
    source["acceptance_criteria"],
    "acceptance_criteria",
    String(source["id"]),
  );

  const workUnit: WorkUnit = {
    id: String(source["id"]),
    goal: String(source["goal"]),
    repository: String(source["repository"]),
    capabilities,
    acceptanceCriteria,
  };
  if (source["base_revision"] !== undefined) workUnit.baseRevision = String(source["base_revision"]);
  if (source["scope"] !== undefined) workUnit.scope = requireStringArray(source["scope"], "scope", workUnit.id);
  if (source["verification"] !== undefined) {
    workUnit.verification = requireStringArray(source["verification"], "verification", workUnit.id);
  }
  if (source["autonomy"] !== undefined) {
    const autonomy = source["autonomy"];
    if (autonomy !== "automatic" && autonomy !== "review" && autonomy !== "approval") {
      throw new Error(`work unit '${workUnit.id}': 'autonomy' must be automatic, review, or approval`);
    }
    workUnit.autonomy = autonomy;
  }
  return workUnit;
}

function requireStringArray(value: unknown, field: string, id: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`work unit '${id}': '${field}' must be an array of strings`);
  }
  return [...(value as string[])];
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