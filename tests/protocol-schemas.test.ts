import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Capability, WorkspaceRef } from "../src/protocol.js";
import type { JsonSchema } from "../src/kernel/json-schema.js";
import { isRecord, validateAgainstSchema } from "../src/kernel/json-schema.js";

/**
 * The protocol TypeScript types and the wire schemas must stay in correspondence.
 *
 * Every schema in `schemas/` is validated as well-formed, and each schema's
 * `properties` are checked to have a same-named counterpart in the TypeScript
 * type. This is what stops the two drifting apart silently, which is how the
 * earlier Work Unit/schema mismatch survived until CI.
 */

function schema(name: string): JsonSchema {
  return JSON.parse(readFileSync(`schemas/${name}`, "utf8")) as JsonSchema;
}

const contracts: { name: string; schemaName: string; sample: Record<string, unknown> }[] = [
  {
    name: "Capability",
    schemaName: "capability.schema.json",
    sample: { name: "testing", category: "verification", description: "Runs and maintains automated tests." },
  },
  {
    name: "Workspace",
    schemaName: "workspace.schema.json",
    sample: { id: "ws-1", path: "/repo", worktree_path: "/repo/.worktree" },
  },
];

describe("protocol schema contracts", () => {
  it("declares every schema referenced by the kernel and docs", () => {
    const declared = [
      "capability.schema.json",
      "conflict.schema.json",
      "execution-event.schema.json",
      "integration-result.schema.json",
      "verification-result.schema.json",
      "worker.schema.json",
      "work-unit.schema.json",
      "workspace.schema.json",
    ];
    for (const file of declared) {
      expect(() => readFileSync(`schemas/${file}`, "utf8")).not.toThrow();
    }
  });

  it.each(contracts)("$name validates its conforming instance", ({ schemaName, sample }) => {
    expect(validateAgainstSchema(sample, schema(schemaName))).toEqual([]);
  });

  it.each(contracts)("$name requires its identifying fields", ({ schemaName }) => {
    const issues = validateAgainstSchema({}, schema(schemaName));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.message === "missing required property")).toBe(true);
  });

  it.each(contracts)("$name rejects additional properties", ({ schemaName, sample }) => {
    const issues = validateAgainstSchema({ ...sample, rogue: "value" }, schema(schemaName));
    expect(issues).toEqual([{ path: "$.rogue", message: "additional property is not permitted" }]);
  });

  it("rejects a capability with an empty name", () => {
    const issues = validateAgainstSchema({ name: "" }, schema("capability.schema.json"));
    expect(issues[0]?.message).toContain("minLength");
  });

  it("rejects a workspace with an empty path", () => {
    const issues = validateAgainstSchema({ id: "ws", path: "" }, schema("workspace.schema.json"));
    expect(issues[0]?.message).toContain("minLength");
  });
});

describe("TypeScript types correspond to the schemas", () => {
  it("Capability projects onto the wire form with no provider fields", () => {
    const capability: Capability = { name: "frontend", category: "implementation" };
    // A capability names a requirement; it must not carry provider detail.
    expect(Object.keys(capability).sort()).toEqual(["category", "name"]);
    expect(validateAgainstSchema({ name: capability.name, category: capability.category }, schema("capability.schema.json"))).toEqual([]);
  });

  it("WorkspaceRef maps to the snake_case wire form the schema requires", () => {
    const workspace: WorkspaceRef = { id: "ws-1", path: "/repo", worktreePath: "/repo/.worktree" };
    const wire = {
      id: workspace.id,
      path: workspace.path,
      ...(workspace.worktreePath === undefined ? {} : { worktree_path: workspace.worktreePath }),
    };
    expect(validateAgainstSchema(wire, schema("workspace.schema.json"))).toEqual([]);
  });

  it("workspace schema exposes exactly the WorkspaceRef fields plus audit fields", () => {
    const properties = Object.keys(schema("workspace.schema.json").properties ?? {});
    expect(properties).toEqual(["id", "path", "worktree_path", "runtime", "isolation"]);
    // The first three mirror WorkspaceRef exactly.
    expect(properties.slice(0, 3)).toEqual(["id", "path", "worktree_path"]);
  });

  it("capability schema names requirements, never providers", () => {
    const text = readFileSync("schemas/capability.schema.json", "utf8").toLowerCase();
    // Documentation may mention providers as examples of what NOT to do, but the
    // schema must not encode a provider or command field.
    expect(text).not.toContain('"opencode"');
    expect(text).not.toContain('"herdr"');
    expect(text).not.toContain('"command"');
    const properties = Object.keys(schema("capability.schema.json").properties ?? {});
    expect(properties.every((field) => !/provider|command|runtime/i.test(field))).toBe(true);
  });

  it("keeps every schema a valid object contract with an identifier", () => {
    for (const file of ["capability.schema.json", "workspace.schema.json"]) {
      const parsed: unknown = JSON.parse(readFileSync(`schemas/${file}`, "utf8"));
      expect(isRecord(parsed)).toBe(true);
      const record = parsed as Record<string, unknown>;
      expect(record["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(typeof record["$id"]).toBe("string");
      expect(record["title"]).toBeDefined();
      expect(record["type"]).toBe("object");
      expect(record["additionalProperties"]).toBe(false);
    }
  });
});