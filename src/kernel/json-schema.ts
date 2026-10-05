/**
 * Dependency-free validator for the subset of JSON Schema draft 2020-12 that
 * `schemas/*.json` actually uses.
 *
 * This is deliberately partial: it enforces only the keywords present in the
 * repository's schemas (type, properties, required, additionalProperties, items,
 * minItems, minLength, uniqueItems, enum). It does not claim to be a conforming
 * JSON Schema implementation, and it is not a general-purpose validator.
 *
 * Keeping it in-repo avoids adding a validation dependency for a fixed, small,
 * known set of schemas. Revisit if the schemas grow beyond this subset.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minItems?: number;
  minLength?: number;
  minimum?: number;
  format?: string;
  uniqueItems?: boolean;
  enum?: JsonValue[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  check(value, schema, "$", issues);
  return issues;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function check(value: unknown, schema: JsonSchema, path: string, issues: ValidationIssue[]): void {
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    issues.push({ path, message: `expected type ${schema.type}, received ${describe(value)}` });
    return;
  }

  if (schema.enum !== undefined && !schema.enum.some((candidate) => candidate === value)) {
    issues.push({ path, message: `expected one of [${schema.enum.map(describe).join(", ")}]` });
  }

  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push({ path, message: `expected minLength ${schema.minLength}, received length ${value.length}` });
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    issues.push({ path, message: `expected minimum ${schema.minimum}, received ${value}` });
  }

  if (typeof value === "string" && schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
    issues.push({ path, message: "expected format date-time" });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `expected minItems ${schema.minItems}, received ${value.length}` });
    }
    if (schema.uniqueItems === true && !allUnique(value)) {
      issues.push({ path, message: "expected uniqueItems, received duplicates" });
    }
    const itemSchema = schema.items;
    if (itemSchema !== undefined) {
      value.forEach((item, index) => check(item, itemSchema, `${path}[${index}]`, issues));
    }
    return;
  }

  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) issues.push({ path: `${path}.${key}`, message: "missing required property" });
    }
    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = schema.properties?.[key];
      if (propertySchema !== undefined) {
        check(entry, propertySchema, `${path}.${key}`, issues);
      } else if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, message: "additional property is not permitted" });
      }
    }
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function allUnique(items: unknown[]): boolean {
  const seen = new Set(items.map((item) => JSON.stringify(item)));
  return seen.size === items.length;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}