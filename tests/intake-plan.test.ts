import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IntakeEligibility, ProviderIntakeAdapter } from "../src/kernel/intake.js";
import { describeIntakeOutcome, runIntake } from "../src/kernel/intake.js";
import type { IntakePlan } from "../src/kernel/intake-plan.js";
import * as intakePlanModule from "../src/kernel/intake-plan.js";
import { buildIntakePlan } from "../src/kernel/intake-plan.js";
import type { WorkUnit } from "../src/protocol.js";
import { workUnitToWireForm } from "../src/kernel/work-unit.js";

/**
 * The provider-neutral plan builder: what intake produces once the record loop is
 * lifted out of any one adapter.
 *
 * FCT-026 defined the boundary, FCT-027 gave Linear a plan, FCT-028 gave GitHub an
 * adapter. What did not exist is a *second* provider that could be planned by the
 * same code. Without this module the second adapter's plan would be a second
 * implementation of "run the records, collect the two outcomes" — and two
 * implementations is how a refusal quietly stops being rendered by
 * `describeIntakeOutcome` and starts being paraphrased.
 *
 * The provider driven through it here is deliberately unlike both shipped ones: a
 * task board with a `stage` field and no prose and no `owner/repo` coordinates. It is
 * the check that the builder assumes nothing about a record's shape, because if it
 * did, the CLI would only work for the first provider wired into it.
 */

/** A record from a task board: no status taxonomy, no description prose, no coordinates. */
interface BoardTask {
  id: string;
  title: string;
  stage: "backlog" | "ready" | "doing" | "closed";
  requiredCapabilities: string[];
  acceptance: string[];
}

interface BoardPolicy {
  /** Cleared stages. Empty by default, like every eligibility allowlist here. */
  readyStages: string[];
}

const boardAdapter: ProviderIntakeAdapter<BoardTask, BoardPolicy> = {
  provider: "board",

  sourceId: (task) => task.id,
  sourceUrl: (task) => `https://board.example/${task.id}`,

  evaluate: (task, policy): IntakeEligibility => {
    if (policy.readyStages.includes(task.stage) === false) {
      return {
        eligible: false,
        refusal: {
          classification: "not_allowlisted",
          providerReason: "stage_not_cleared",
          detail: `stage '${task.stage}' is not cleared for dispatch`,
          check: "stage_allowlist",
        },
      };
    }
    if (task.acceptance.length === 0) {
      return {
        eligible: false,
        refusal: { classification: "requirements_undeclared", providerReason: "no_acceptance" },
      };
    }
    return { eligible: true };
  },

  compile: (task): WorkUnit | undefined => {
    if (task.acceptance.length === 0) return undefined;
    return {
      id: task.id,
      goal: task.title,
      repository: "acme/board",
      capabilities: [...task.requiredCapabilities],
      acceptanceCriteria: [...task.acceptance],
    };
  },
};

const task = (id: string, overrides: Partial<BoardTask> = {}): BoardTask => ({
  id,
  title: `Board work ${id}`,
  stage: "ready",
  requiredCapabilities: ["coding"],
  acceptance: [`${id} is done`],
  ...overrides,
});

const policy: BoardPolicy = { readyStages: ["ready", "doing"] };

const records: BoardTask[] = [
  task("B-1"),
  task("B-2", { stage: "backlog" }),
  task("B-3", { acceptance: [] }),
  task("B-4", { stage: "closed" }),
  task("B-5", { stage: "doing" }),
];

describe("intake plans records for any provider, not just the first one", () => {
  it("plans what it accepted and refuses the rest, with no third outcome", () => {
    const plan = buildIntakePlan({ adapter: boardAdapter, records, policy });

    expect(Object.keys(plan).sort()).toEqual(["refusals", "units"]);
    expect(plan.units.map((unit) => unit.workUnit["id"])).toEqual(["B-1", "B-5"]);
    expect(plan.refusals.map((entry) => entry.source.reference).sort()).toEqual(["B-2", "B-3", "B-4"]);
  });

  it("never lets a refused record appear as a unit", () => {
    // A refusal is about a provider record; a refused record has no Work Unit to
    // plan. One collection for each outcome makes a third state unrepresentable.
    const plan = buildIntakePlan({ adapter: boardAdapter, records, policy });

    const planned = new Set(plan.units.map((unit) => unit.workUnit["id"]));
    for (const entry of plan.refusals) expect(planned.has(entry.source.reference)).toBe(false);
  });

  it("emits the exact plan shape `factory work run --work-units` already parses", () => {
    const plan: IntakePlan = buildIntakePlan({ adapter: boardAdapter, records, policy });

    // A plan entry is the Work Unit's wire form and nothing else, so the array this
    // produces is byte-for-byte the shape `readWorkUnitFile` consumes.
    for (const unit of plan.units) expect(Object.keys(unit).sort()).toEqual(["workUnit"]);
    expect(plan.units[0]?.workUnit).toEqual(
      workUnitToWireForm({
        id: "B-1",
        goal: "Board work B-1",
        repository: "acme/board",
        capabilities: ["coding"],
        acceptanceCriteria: ["B-1 is done"],
      }),
    );
  });

  it("copies declared scheduling facts verbatim and omits them when undeclared", () => {
    const plan = buildIntakePlan({
      adapter: boardAdapter,
      records,
      policy,
      extras: {
        "B-1": {
          dependsOn: ["B-5"],
          paths: ["src/board"],
          contracts: ["board-schema"],
          runtimes: ["fake"],
          protectedResources: ["main"],
          risk: { declaredRisk: "trusted", touchesProduction: false },
        },
      },
    });

    expect(plan.units[0]).toEqual({
      workUnit: expect.objectContaining({ id: "B-1" }),
      dependsOn: ["B-5"],
      paths: ["src/board"],
      contracts: ["board-schema"],
      runtimes: ["fake"],
      protectedResources: ["main"],
      risk: { declaredRisk: "trusted", touchesProduction: false },
    });
    // Declared for one record, absent for another: an undeclared fact is not filled
    // in with a default, because a default here would be the factory guessing.
    expect(Object.keys(plan.units[1] ?? {}).sort()).toEqual(["workUnit"]);
  });

  it("declares no scheduling structure the record did not state", () => {
    // Nothing here reads `stage`, `tags` or anything else off a record to invent a
    // dependency or a path. `risk` especially: it is a control the security gate
    // enforces, so deriving it from a record's content would be a guess as a gate.
    const plan = buildIntakePlan({ adapter: boardAdapter, records, policy });

    for (const unit of plan.units) {
      expect(unit.dependsOn).toBeUndefined();
      expect(unit.paths).toBeUndefined();
      expect(unit.contracts).toBeUndefined();
      expect(unit.risk).toBeUndefined();
    }
  });
});

describe("an intake refusal stays an intake refusal", () => {
  it("keys a refusal by provider and record, never by Work Unit id", () => {
    const plan = buildIntakePlan({ adapter: boardAdapter, records, policy });
    const refusal = plan.refusals.find((entry) => entry.source.reference === "B-2");
    if (refusal === undefined) throw new Error("unreachable: B-2 is refused");

    // `workUnitId` is the key a `SchedulingDecision` uses. A refused record never
    // became a Work Unit, so it cannot be reported against one.
    expect(Object.keys(refusal).sort()).toEqual(["message", "outcome", "refusal", "source"]);
    expect(refusal.outcome).toBe("refused");
    expect(refusal.source.provider).toBe("board");
    expect(refusal.source.url).toBe("https://board.example/B-2");
    expect(refusal.refusal.providerReason).toBe("stage_not_cleared");
  });

  it("renders every refusal through the kernel's own wording", () => {
    const plan = buildIntakePlan({ adapter: boardAdapter, records, policy });
    const refusal = plan.refusals.find((entry) => entry.source.reference === "B-2");
    if (refusal === undefined) throw new Error("unreachable: B-2 is refused");

    // One renderer, so the `intake` prefix and the provider/record naming hold for a
    // provider that was never considered when the wording was written.
    expect(refusal.message).toBe(
      describeIntakeOutcome(runIntake(boardAdapter, records[1] as BoardTask, policy)),
    );
    expect(refusal.message).toContain("intake refused");
    expect(refusal.message).not.toContain("blocked");
  });
});

describe("planning is reproducible, because a plan is approved before it runs", () => {
  it("produces an identical plan for the same records and policy", () => {
    const first = buildIntakePlan({ adapter: boardAdapter, records, policy });
    const second = buildIntakePlan({ adapter: boardAdapter, records, policy });

    // Re-running intake must not rewrite what a reviewer agreed to.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("plans nothing at all until a stage is allowlisted", () => {
    const plan = buildIntakePlan({ adapter: boardAdapter, records, policy: { readyStages: [] } });

    expect(plan.units).toEqual([]);
    expect(plan.refusals).toHaveLength(records.length);
  });

  it("plans an empty record set as an empty plan rather than failing", () => {
    const plan = buildIntakePlan({ adapter: boardAdapter, records: [], policy });

    expect(plan).toEqual({ units: [], refusals: [] });
  });
});

describe("the plan builder cannot dispatch or mutate anything", () => {
  it("imports nothing with the capability to execute work or write to a provider", () => {
    // Structural evidence, in the same shape FCT-028 used for its adapter: a green
    // behaviour test cannot see a capability the module does not happen to call.
    //
    // Asserted over the *imports*, not the whole file, because a doc comment that
    // explains "this mirrors `ScheduledWorkUnit` in `src/kernel/scheduler.ts`" is the
    // module being explicit about its contract rather than reaching for that module.
    // A name that must never appear even in prose is checked separately below.
    const source = readFileSync("src/kernel/intake-plan.ts", "utf8");
    const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+"([^"]+)";/gm)].map((match) => match[1]!);
    expect([...new Set(imports)].sort()).toEqual(["../security/risk.js", "./intake.js", "./work-unit.js"]);

    // The import set above is the whole reach of this module, so the raw-text check
    // is left to the things an import statement would not catch: a lazy `import()` or
    // `require()` would slip past a scan of the static imports entirely.
    for (const forbidden of ["import(", "require(", "node:child_process", "node:http", "node:https", "node:net"]) {
      expect(source, `the plan builder must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("exports no dispatch, merge or release operation", () => {
    // The module namespace, so this fails if a capability to execute or mutate work
    // is ever added beside the builder.
    const exported = Object.keys(intakePlanModule).join(" ").toLowerCase();
    for (const forbidden of ["dispatch", "execute", "merge", "release", "mutate"]) {
      expect(exported, `intake must not export '${forbidden}'`).not.toContain(forbidden);
    }
  });
});