import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor/doctor.js";
import type { DoctorProbe } from "../src/doctor/probe.js";

/**
 * What `doctor` is allowed to claim about a runtime.
 *
 * It used to answer "available" on the evidence of `--version`, which establishes
 * only that a binary is installed. A runtime can be on PATH, version correctly, and
 * fail every dispatch — the default model may be gated, unauthenticated, or out of
 * quota — and none of that is visible to `--version`. Observed: `8 ok, 0 error(s)`
 * on a machine where every opencode dispatch died at a prompt.
 *
 * The other half matters just as much. Probing everything with a guessed command
 * reported two working runtimes as broken, because `herdr` has no `run` subcommand
 * and `hermes` takes `-z`. A failure we did not establish is the same mistake as a
 * success we did not establish, in the other direction.
 */

function probe(overrides: Partial<DoctorProbe> = {}): DoctorProbe {
  return {
    cwd: () => "/repo",
    nodeVersion: () => "v22.0.0",
    worktreeSupport: async () => ({ supported: true, reasons: [] }),
    repositoryState: async () => ({
      insideRepository: true,
      clean: true,
      isGitRepository: true,
      detachedHead: false,
      insideLinkedWorktree: false,
      worktrees: [],
    }),
    runtimeAvailability: async () => ({ available: true, version: "1.0.0" }),
    fileExists: () => true,
    ...overrides,
  };
}

const onlyOpenCode = [{ name: "opencode", role: "direct runtime", required: false }];

describe("a runtime that cannot run a prompt", () => {
  it("is not reported as available when a probe proves it", async () => {
    const report = await runDoctor({
      probe: probe({
        runtimeAvailability: async () => ({ available: true, version: "1.0.0" }),
        dispatchCheck: async () => ({ probed: true, ok: false, detail: "an active subscription is required" }),
      }),
      runtimes: onlyOpenCode,
      requiredFiles: [],
    });

    const runtime = report.diagnostics.find((d) => d.id === "runtime.opencode");
    expect(runtime?.severity).toBe("error");
    expect(runtime?.summary).toMatch(/cannot run a prompt/);
    // The operator needs the reason, not just a verdict.
    expect(runtime?.remedy).toMatch(/subscription/);
  });

  it("is reported as available only when a probe proves that", async () => {
    const report = await runDoctor({
      probe: probe({ dispatchCheck: async () => ({ probed: true, ok: true }) }),
      runtimes: onlyOpenCode,
      requiredFiles: [],
    });

    const runtime = report.diagnostics.find((d) => d.id === "runtime.opencode");
    expect(runtime?.severity).toBe("ok");
    expect(runtime?.summary).toMatch(/is available/);
  });
});

describe("a runtime that cannot be probed", () => {
  it("is reported as installed, never as broken", async () => {
    // The false negative. `herdr` has no `run` subcommand and `hermes` takes `-z`,
    // so a generic probe guessed wrong and reported two working runtimes as failing.
    const report = await runDoctor({
      probe: probe({ dispatchCheck: async () => ({ probed: false, ok: false, detail: "no probe defined for this runtime" }) }),
      runtimes: [{ name: "herdr", role: "managed runtime", required: false }],
      requiredFiles: [],
    });

    const runtime = report.diagnostics.find((d) => d.id === "runtime.herdr");
    expect(runtime?.severity).toBe("ok");
    expect(runtime?.summary).toMatch(/is installed/);
    expect(runtime?.summary).not.toMatch(/cannot run/);
  });
});

describe("without a probe", () => {
  it("says installed rather than available, because installed is what it checked", async () => {
    // The wording follows the evidence. Claiming "available" on a `--version` probe
    // is the defect; the fix is not to hide the check but to stop overstating it.
    const report = await runDoctor({
      probe: probe(),
      runtimes: onlyOpenCode,
      requiredFiles: [],
    });

    const runtime = report.diagnostics.find((d) => d.id === "runtime.opencode");
    expect(runtime?.severity).toBe("ok");
    expect(runtime?.summary).toMatch(/is installed/);
    expect(runtime?.summary).not.toMatch(/is available/);
    // And it points at the stronger check rather than leaving the gap unexplained.
    expect(runtime?.detail).toMatch(/--probe/);
  });

  it("does not fail a runtime that was never probed", async () => {
    const report = await runDoctor({
      probe: probe({ runtimeAvailability: async () => ({ available: true }) }),
      runtimes: [{ name: "opencode", role: "direct runtime", required: true }],
      requiredFiles: [],
    });

    // Asserted on the runtime's own diagnostic rather than the report status: other
    // checks legitimately block for unrelated reasons, and this test is about the
    // runtime, not the environment.
    const runtime = report.diagnostics.find((d) => d.id === "runtime.opencode");
    expect(runtime?.severity).toBe("ok");
  });
});