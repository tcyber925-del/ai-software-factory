import { describe, expect, it } from "vitest";
import type { DoctorProbe, RepositoryState, RuntimeAvailability, WorktreeSupport } from "../src/doctor/probe.js";
import { MINIMUM_NODE_MAJOR, REQUIRED_PROJECT_FILES, RUNTIME_REQUIREMENTS, formatDoctorReport, runDoctor } from "../src/doctor/doctor.js";

/** A fixture probe, so diagnostics never depend on the developer's machine. */
function probeWith(overrides: Partial<DoctorProbe> = {}, state: Partial<RepositoryState> = {}): DoctorProbe {
  const repository: RepositoryState = {
    isGitRepository: true,
    clean: true,
    detachedHead: false,
    insideLinkedWorktree: false,
    worktrees: [],
    ...state,
  };
  return {
    cwd: () => "/repo",
    nodeVersion: () => "v24.0.0",
    worktreeSupport: async (): Promise<WorktreeSupport> => ({ supported: true, reasons: [] }),
    repositoryState: async () => repository,
    runtimeAvailability: async (runtime): Promise<RuntimeAvailability> => ({ available: runtime === "opencode", version: "1.2.3" }),
    fileExists: (file) => REQUIRED_PROJECT_FILES.includes(file),
    ...overrides,
  };
}

/** Every runtime present, for the fully-healthy case. */
function healthyProbe(overrides: Partial<DoctorProbe> = {}): DoctorProbe {
  return probeWith({
    runtimeAvailability: async (runtime): Promise<RuntimeAvailability> => ({ available: true, version: `v-${runtime}` }),
    ...overrides,
  });
}

describe("deterministic reporting", () => {
  it("reports the same result for the same environment", async () => {
    const first = await runDoctor({ probe: probeWith() });
    const second = await runDoctor({ probe: probeWith() });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("emits an ok diagnostic for every passing check", async () => {
    const report = await runDoctor({ probe: healthyProbe() });
    const ids = report.diagnostics.map((diagnostic) => diagnostic.id);
    expect(ids).toContain("node.version");
    expect(ids).toContain("git.worktree");
    expect(ids).toContain("git.repository");
    expect(ids).toContain("git.clean");
    expect(ids).toContain("project.files");
    expect(report.status).toBe("healthy");
  });

  it("formats a readable report with counts", async () => {
    const text = formatDoctorReport(await runDoctor({ probe: healthyProbe() }));
    expect(text).toContain("factory doctor: healthy");
    expect(text).toContain("[ok  ] node.version");
    expect(text).toMatch(/ok, \d+ warning\(s\), \d+ error\(s\)/);
  });
});

describe("optional runtimes are distinguished from required ones", () => {
  it("does not fail when an optional runtime is missing", async () => {
    const report = await runDoctor({
      probe: probeWith({
        runtimeAvailability: async (runtime) => ({ available: runtime === "opencode" }),
      }),
    });
    const herdr = report.diagnostics.find((diagnostic) => diagnostic.id === "runtime.herdr");
    expect(herdr?.severity).toBe("warning");
    expect(herdr?.summary).toContain("Optional");
    expect(herdr?.remedy).toContain("Not required for dispatch");
    // A missing optional runtime must not block dispatch.
    expect(report.status).toBe("degraded");
    expect(report.counts.error).toBe(0);
  });

  it("blocks dispatch when a required runtime is missing", async () => {
    const report = await runDoctor({
      probe: probeWith({ runtimeAvailability: async () => ({ available: false }) }),
    });
    expect(report.diagnostics.find((diagnostic) => diagnostic.id === "runtime.opencode")?.severity).toBe("error");
    expect(report.status).toBe("blocked");
  });

  it("marks Herdr optional and OpenCode required, per the documented policy", () => {
    expect(RUNTIME_REQUIREMENTS.find((r) => r.name === "herdr")?.required).toBe(false);
    expect(RUNTIME_REQUIREMENTS.find((r) => r.name === "opencode")?.required).toBe(true);
  });
});

describe("prerequisites", () => {
  it("blocks on a Node version below the minimum", async () => {
    const report = await runDoctor({ probe: probeWith({ nodeVersion: () => "v18.0.0" }) });
    const node = report.diagnostics.find((diagnostic) => diagnostic.id === "node.version");
    expect(node?.severity).toBe("error");
    expect(node?.remedy).toContain(String(MINIMUM_NODE_MAJOR));
  });

  it("blocks when worktree isolation is unavailable", async () => {
    const report = await runDoctor({
      probe: probeWith({
        worktreeSupport: async () => ({ supported: false, reasons: ["not inside a Git working tree"] }),
      }),
    });
    const worktree = report.diagnostics.find((diagnostic) => diagnostic.id === "git.worktree");
    expect(worktree?.severity).toBe("error");
    expect(worktree?.detail).toContain("not inside a Git working tree");
  });

  it("blocks when project files are missing", async () => {
    const report = await runDoctor({ probe: probeWith({ fileExists: () => false }) });
    const files = report.diagnostics.find((diagnostic) => diagnostic.id === "project.files");
    expect(files?.severity).toBe("error");
    expect(files?.detail).toContain("AGENTS.md");
  });
});

describe("unsafe worktree conditions are detected before execution", () => {
  it("warns on uncommitted changes", async () => {
    const report = await runDoctor({ probe: probeWith({}, { clean: false }) });
    expect(report.diagnostics.find((diagnostic) => diagnostic.id === "git.clean")?.severity).toBe("warning");
  });

  it("warns on a detached HEAD", async () => {
    const report = await runDoctor({ probe: probeWith({}, { detachedHead: true }) });
    expect(report.diagnostics.find((diagnostic) => diagnostic.id === "git.head")?.severity).toBe("warning");
  });

  it("blocks dispatch from inside a nested linked worktree", async () => {
    const report = await runDoctor({
      probe: probeWith({}, { insideLinkedWorktree: true, worktrees: ["/elsewhere"] }),
    });
    const nested = report.diagnostics.find((diagnostic) => diagnostic.id === "git.nested_worktree");
    expect(nested?.severity).toBe("error");
    expect(report.status).toBe("blocked");
  });

  it("does not flag a legitimate linked worktree as nested", async () => {
    const report = await runDoctor({
      probe: probeWith({}, { insideLinkedWorktree: true, worktrees: ["/repo"] }),
    });
    expect(report.diagnostics.find((diagnostic) => diagnostic.id === "git.nested_worktree")).toBeUndefined();
  });

  it("blocks when not inside a Git repository at all", async () => {
    const report = await runDoctor({
      probe: probeWith({}, { isGitRepository: false }),
    });
    expect(report.diagnostics.find((diagnostic) => diagnostic.id === "git.repository")?.severity).toBe("error");
  });

  it("attaches a remedy to every non-ok diagnostic", async () => {
    const report = await runDoctor({
      probe: probeWith({ nodeVersion: () => "v16.0.0", fileExists: () => false }, { clean: false, detachedHead: true }),
    });
    for (const diagnostic of report.diagnostics) {
      if (diagnostic.severity !== "ok") expect(diagnostic.remedy).toBeDefined();
    }
  });
});