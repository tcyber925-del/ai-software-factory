import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { isRecord, validateAgainstSchema } from "../src/kernel/json-schema.js";

const person: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "capabilities"],
  properties: {
    id: { type: "string", minLength: 1 },
    capabilities: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
    mode: { enum: ["auto", "manual"] },
    attempt: { type: "integer", minimum: 1 },
    timestamp: { type: "string", format: "date-time" },
  },
};

function paths(issues: { path: string }[]): string[] {
  return issues.map((issue) => issue.path);
}

describe("validateAgainstSchema", () => {
  it("accepts a conforming instance", () => {
    expect(
      validateAgainstSchema(
        { id: "w1", capabilities: ["testing"], mode: "auto", attempt: 1, timestamp: "2026-01-01T00:00:00.000Z" },
        person,
      ),
    ).toEqual([]);
  });

  it("reports every missing required property", () => {
    expect(paths(validateAgainstSchema({}, person))).toEqual(["$.id", "$.capabilities"]);
  });

  it("enforces additionalProperties:false", () => {
    expect(validateAgainstSchema({ id: "w1", capabilities: ["testing"], rogue: 1 }, person)).toEqual([
      { path: "$.rogue", message: "additional property is not permitted" },
    ]);
  });

  it("enforces minLength, minItems and uniqueItems", () => {
    const issues = validateAgainstSchema({ id: "", capabilities: [] }, person);
    expect(paths(issues)).toEqual(["$.id", "$.capabilities"]);
    expect(issues[1]?.message).toContain("minItems");

    const duplicates = validateAgainstSchema({ id: "w1", capabilities: ["a", "a"] }, person);
    expect(duplicates[0]?.message).toContain("uniqueItems");
  });

  it("enforces enum, minimum and date-time format", () => {
    expect(validateAgainstSchema({ id: "w1", capabilities: ["a"], mode: "nope" }, person)[0]?.message).toContain(
      "expected one of",
    );
    expect(validateAgainstSchema({ id: "w1", capabilities: ["a"], attempt: 0 }, person)[0]?.message).toContain(
      "expected minimum 1",
    );
    expect(validateAgainstSchema({ id: "w1", capabilities: ["a"], timestamp: "not-a-date" }, person)[0]?.message).toContain(
      "format date-time",
    );
  });

  it("rejects a type mismatch without descending into the value", () => {
    expect(validateAgainstSchema("nope", person)).toEqual([
      { path: "$", message: "expected type object, received string" },
    ]);
  });

  it("validates nested array items", () => {
    const issues = validateAgainstSchema({ id: "w1", capabilities: ["ok", ""] }, person);
    expect(paths(issues)).toEqual(["$.capabilities[1]"]);
  });
});

describe("isRecord", () => {
  it("accepts plain objects and rejects arrays and null", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});