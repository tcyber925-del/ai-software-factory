import { describe, expect, it } from "vitest";
import type { WorkUnit } from "../src/protocol.js";
import type { LabelledRuntime } from "../src/kernel/work-unit.js";
import type { ScheduledWorkUnit } from "../src/kernel/scheduler.js";
import { detectConflict, planSchedule } from "../src/kernel/scheduler.js";
import { InMemoryEventLog } from "../src/state/event-log.js";

function unit(overrides: Partial<ScheduledWorkUnit> & { id: string }): ScheduledWorkUnit {
  const workUnit: WorkUnit = {
    id: overrides.id,
    goal: `do ${overrides.id}`,
    repository: "example/repo",
    capabilities: ["coding"],
    acceptanceCriteria: ["works"],
  };
  return { workUnit, ...overrides };
}

/** Declares a full touched surface, so a unit is not treated as uncertain. */
function described(overrides: Partial<ScheduledWorkUnit> & { id: string }): ScheduledWorkUnit {
  return unit({ paths: [`src/${overrides.id}`], ...overrides });
}

type Decision = Awaited<ReturnType<typeof planSchedule>>["decisions"][number];

const runtime: LabelledRuntime = {
  name: "fake",
  runtime: { capabilities: () => Promise.resolve(["coding", "testing"]) } as never,
};

function decisionFor(plan: { decisions: Decision[] }, id: string): Decision | undefined {
  return plan.decisions.find((decision) => decision.workUnitId === id);
}

describe("dependency ordering", () => {
  it("never schedules work whose dependency has not completed", async () => {
    const plan = await planSchedule({
      units: [
        described({ id: "A" }),
        described({ id: "B", dependsOn: ["A"] }),
        described({ id: "C", dependsOn: ["B"] }),
      ],
    });

    expect(plan.batches).toEqual([["A"], ["B"], ["C"]]);
    expect(decisionFor(plan, "B")?.batch).toBe(1);
    expect(decisionFor(plan, "C")?.batch).toBe(2);
  });

  it("blocks a dependency cycle rather than dropping it", async () => {
    const plan = await planSchedule({
      units: [described({ id: "A", dependsOn: ["B"] }), described({ id: "B", dependsOn: ["A"] })],
    });

    expect(plan.cycles.length).toBeGreaterThan(0);
    expect(decisionFor(plan, "A")?.reason).toBe("dependency_cycle");
    expect(decisionFor(plan, "B")?.reason).toBe("dependency_cycle");
    expect(plan.batches).toEqual([]);
  });

  it("blocks work whose dependency is not scheduled at all", async () => {
    const plan = await planSchedule({ units: [described({ id: "A", dependsOn: ["ghost"] })] });
    expect(decisionFor(plan, "A")?.reason).toBe("unsatisfied_dependency");
    expect(plan.batches).toEqual([]);
  });

  it("blocks duplicate work unit ids", async () => {
    const plan = await planSchedule({ units: [described({ id: "A" }), described({ id: "A" })] });
    expect(decisionFor(plan, "A")?.reason).toBe("duplicate_work_unit_id");
  });
});

describe("capability matching", () => {
  it("blocks dispatch when no runtime provides a required capability", async () => {
    const plan = await planSchedule({
      units: [described({ id: "A", workUnit: { ...described({ id: "A" }).workUnit, capabilities: ["rust"] } })],
      runtimes: [runtime],
    });
    expect(decisionFor(plan, "A")?.reason).toBe("missing_capabilities");
    expect(decisionFor(plan, "A")?.missingCapabilities).toEqual(["rust"]);
    expect(plan.batches).toEqual([]);
  });

  it("schedules work when a runtime provides the capability", async () => {
    const plan = await planSchedule({ units: [described({ id: "A" })], runtimes: [runtime] });
    expect(decisionFor(plan, "A")?.outcome).toBe("scheduled");
  });

  it("treats an unreachable runtime as providing no capabilities", async () => {
    const broken: LabelledRuntime = {
      name: "broken",
      runtime: { capabilities: () => Promise.reject(new Error("unavailable")) } as never,
    };
    const plan = await planSchedule({ units: [described({ id: "A" })], runtimes: [broken] });
    expect(decisionFor(plan, "A")?.reason).toBe("missing_capabilities");
  });

  it("skips capability matching when no runtime inventory is supplied", async () => {
    // With an unknown fleet the scheduler must not invent a verdict. Blocking
    // here would make a pure ordering call refuse all work.
    const plan = await planSchedule({ units: [described({ id: "A" })] });
    expect(decisionFor(plan, "A")?.outcome).toBe("scheduled");
    expect(plan.batches).toEqual([["A"]]);
  });

  it("blocks all work when an empty runtime inventory is supplied explicitly", async () => {
    // An empty inventory is a known fleet with no capacity, which is different
    // from not knowing the fleet at all.
    const plan = await planSchedule({ units: [described({ id: "A" })], runtimes: [] });
    expect(decisionFor(plan, "A")?.reason).toBe("missing_capabilities");
  });
});

describe("conservative conflict detection", () => {
  it("serializes work touching the same path", async () => {
    const plan = await planSchedule({
      units: [
        described({ id: "A", paths: ["src/shared.ts"] }),
        described({ id: "B", paths: ["src/shared.ts"] }),
      ],
    });
    expect(plan.batches).toEqual([["A"], ["B"]]);
    expect(plan.conflicts.map((conflict) => conflict.reason)).toContain("overlapping_paths");
  });

  it("serializes a directory prefix against a file inside it", async () => {
    const found = detectConflict(
      described({ id: "A", paths: ["src/kernel"] }),
      described({ id: "B", paths: ["src/kernel/execution.ts"] }),
    );
    expect(found?.reason).toBe("overlapping_paths");
  });

  it("serializes work sharing a contract", async () => {
    const plan = await planSchedule({
      units: [
        described({ id: "A", contracts: ["work-unit.schema.json"] }),
        described({ id: "B", contracts: ["work-unit.schema.json"] }),
      ],
    });
    expect(plan.batches).toEqual([["A"], ["B"]]);
    expect(plan.conflicts.map((c) => c.reason)).toContain("shared_contract");
  });

  it("serializes work sharing a protected resource", async () => {
    const found = detectConflict(
      described({ id: "A", protectedResources: ["main"] }),
      described({ id: "B", protectedResources: ["main"] }),
    );
    expect(found?.reason).toBe("protected_resource");
  });

  it("serializes incompatible runtime assumptions", async () => {
    const found = detectConflict(
      described({ id: "A", runtimes: ["opencode"] }),
      described({ id: "B", runtimes: ["opencode"] }),
    );
    expect(found?.reason).toBe("runtime_assumption");
  });

  it("defaults to serialization when a unit does not declare its surface", async () => {
    const found = detectConflict(unit({ id: "A" }), described({ id: "B" }));
    expect(found?.reason).toBe("uncertain");
  });

  it("runs independent units in the same batch", async () => {
    const plan = await planSchedule({
      units: [described({ id: "A", paths: ["src/a.ts"] }), described({ id: "B", paths: ["src/b.ts"] })],
    });
    expect(plan.batches).toEqual([["A", "B"]]);
    expect(plan.conflicts).toEqual([]);
  });
});

describe("determinism", () => {
  it("produces the identical plan for the same input", async () => {
    const units = [
      described({ id: "A", paths: ["src/shared.ts"] }),
      described({ id: "B", paths: ["src/shared.ts"] }),
      described({ id: "C", paths: ["src/c.ts"] }),
    ];
    const first = await planSchedule({ units });
    const second = await planSchedule({ units });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("assigns every unit exactly one decision", async () => {
    const units = [described({ id: "A" }), described({ id: "B", dependsOn: ["A"] }), unit({ id: "C" })];
    const plan = await planSchedule({ units });
    expect(plan.decisions).toHaveLength(units.length);
    expect(new Set(plan.decisions.map((d) => d.workUnitId)).size).toBe(units.length);
  });

  it("puts a unit in exactly one batch", async () => {
    const plan = await planSchedule({
      units: [
        described({ id: "A", paths: ["src/s.ts"] }),
        described({ id: "B", paths: ["src/s.ts"] }),
        described({ id: "C", paths: ["src/c.ts"] }),
      ],
    });
    const flattened = plan.batches.flat();
    expect(new Set(flattened).size).toBe(flattened.length);
  });
});

describe("the scheduler cannot bypass verification or integration", () => {
  it("exposes no field capable of asserting correctness", async () => {
    const plan = await planSchedule({ units: [described({ id: "A" })] });
    // A plan may only ever talk about ordering and grouping.
    expect(Object.keys(plan).sort()).toEqual(["batches", "conflicts", "cycles", "decisions"]);
    expect(JSON.stringify(plan)).not.toContain("verification");
    expect(JSON.stringify(plan)).not.toContain("integration");
  });

  it("records decisions as factory events, never as runtime completion", async () => {
    const log = new InMemoryEventLog();
    await planSchedule({ units: [described({ id: "A" }), described({ id: "B", dependsOn: ["A"] })], eventLog: log, runId: "r1" });

    const stored = log.stored();
    expect(stored.every((event) => event.source === "factory")).toBe(true);
    expect(stored.map((event) => event.type)).toContain("scheduling.planned");
    expect(stored.map((event) => event.type)).toContain("scheduling.scheduled");
    // Scheduling must never emit a worker or verification event.
    expect(stored.map((event) => event.type)).not.toContain("worker.finished");
    expect(stored.map((event) => event.type)).not.toContain("verification.passed");
    expect(stored.map((event) => event.type)).not.toContain("integration.ready");
  });

  it("emits a blocked decision for work it refuses to dispatch", async () => {
    const log = new InMemoryEventLog();
    await planSchedule({
      units: [described({ id: "A", dependsOn: ["ghost"] })],
      eventLog: log,
      runId: "r1",
    });
    const blocked = log.stored().find((event) => event.type === "scheduling.blocked");
    expect(blocked?.payload).toMatchObject({ workUnitId: "A", reason: "unsatisfied_dependency" });
  });
});