import type { DoctorProbe } from "./probe.js";

/**
 * `factory doctor` — deterministic local diagnostics.
 *
 * Reports whether the factory can safely dispatch work, before any dispatch
 * happens. Every check is read-only and reports through the injected probe, so
 * results depend on the environment being described, not on the machine the
 * doctor happens to run on.
 *
 * The doctor distinguishes three severities:
 *
 * - `error`   — dispatch is unsafe; a required capability is missing.
 * - `warning` — dispatch can proceed, but something is degraded (an optional
 *               runtime is missing, the tree is dirty).
 * - `ok`      — the check passed, and is reported so absence of an error is
 *               evidenced rather than assumed.
 *
 * A missing *optional* runtime is never an error. Treating Herdr's absence as a
 * failure would contradict the documented policy that Herdr is a preferred but
 * optional runtime.
 */

export type DiagnosticSeverity = "error" | "warning" | "ok";

export interface Diagnostic {
  id: string;
  severity: DiagnosticSeverity;
  summary: string;
  detail?: string;
  /** Actionable next step. Present whenever severity is not `ok`. */
  remedy?: string;
}

export type DoctorStatus = "healthy" | "degraded" | "blocked";

export interface DoctorReport {
  status: DoctorStatus;
  diagnostics: Diagnostic[];
  counts: Record<DiagnosticSeverity, number>;
}

export interface RequiredRuntime {
  name: string;
  /** A missing required runtime blocks dispatch; a missing optional one does not. */
  required: boolean;
  role: string;
}

/**
 * Runtime requirements, matching `docs/runtime-adapters.md`: a direct OpenCode
 * runtime is required, Herdr is a preferred supported runtime but explicitly not
 * a mandatory factory dependency.
 */
export const RUNTIME_REQUIREMENTS: RequiredRuntime[] = [
  { name: "opencode", required: true, role: "direct runtime" },
  { name: "herdr", required: false, role: "managed runtime" },
  // Hermes is offered by the CLI whenever its binary is on PATH, so a broken
  // installation surfaces mid-dispatch instead of at diagnosis. Listing it as an
  // optional requirement means an absent Hermes stays a warning, while a *present*
  // but unhealthy one is reported before dispatch rather than during it.
  { name: "hermes", required: false, role: "managed runtime" },
];

export const MINIMUM_NODE_MAJOR = 22;

/** Protocol and policy files the factory cannot operate without. */
export const REQUIRED_PROJECT_FILES = [
  "package.json",
  "AGENTS.md",
  "docs/architecture.md",
  "docs/protocols.md",
  "docs/verification-and-merge-gates.md",
];

export interface DoctorOptions {
  probe: DoctorProbe;
  runtimes?: RequiredRuntime[];
  requiredFiles?: string[];
  minimumNodeMajor?: number;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { probe } = options;
  const runtimes = options.runtimes ?? RUNTIME_REQUIREMENTS;
  const requiredFiles = options.requiredFiles ?? REQUIRED_PROJECT_FILES;
  const minimumNode = options.minimumNodeMajor ?? MINIMUM_NODE_MAJOR;
  const diagnostics: Diagnostic[] = [];

  // --- Node prerequisite -------------------------------------------------
  const nodeVersion = probe.nodeVersion();
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (Number.isFinite(nodeMajor) && nodeMajor >= minimumNode) {
    diagnostics.push({ id: "node.version", severity: "ok", summary: `Node ${nodeVersion} meets the minimum v${minimumNode}` });
  } else {
    diagnostics.push({
      id: "node.version",
      severity: "error",
      summary: `Node ${nodeVersion} is below the required v${minimumNode}`,
      remedy: `Install Node ${minimumNode} or newer, then re-run factory doctor.`,
    });
  }

  // --- Worktree capability ------------------------------------------------
  const worktrees = await probe.worktreeSupport();
  if (worktrees.supported) {
    diagnostics.push({ id: "git.worktree", severity: "ok", summary: "Git worktrees are available for isolation" });
  } else {
    diagnostics.push({
      id: "git.worktree",
      severity: "error",
      summary: "Git worktree isolation is unavailable",
      detail: worktrees.reasons.join("; "),
      remedy: "Run from inside a Git repository with a Git version that supports worktrees.",
    });
  }

  // --- Repository state ---------------------------------------------------
  const state = await probe.repositoryState();
  if (!state.isGitRepository) {
    diagnostics.push({
      id: "git.repository",
      severity: "error",
      summary: "Not inside a Git repository",
      remedy: "Run factory doctor from a repository root.",
    });
  } else {
    diagnostics.push({ id: "git.repository", severity: "ok", summary: "Inside a Git repository" });

    if (!state.clean) {
      diagnostics.push({
        id: "git.clean",
        severity: "warning",
        summary: "Working tree has uncommitted changes",
        detail: "Worktrees are created from a revision, so uncommitted work would not be isolated.",
        remedy: "Commit or stash changes before dispatching a Work Unit.",
      });
    } else {
      diagnostics.push({ id: "git.clean", severity: "ok", summary: "Working tree is clean" });
    }

    if (state.detachedHead) {
      diagnostics.push({
        id: "git.head",
        severity: "warning",
        summary: "HEAD is detached",
        detail: "New branches cannot be based on the current checkout.",
        remedy: "Check out a branch before dispatching.",
      });
    }

    // Isolation preconditions. These are checked before dispatch so an
    // unsafe worktree condition is never discovered mid-execution.
    if (state.insideLinkedWorktree && !state.worktrees.includes(probe.cwd())) {
      diagnostics.push({
        id: "git.nested_worktree",
        severity: "error",
        summary: "Already inside a linked worktree",
        detail: "Nested dispatch would place the new worktree inside an existing one.",
        remedy: "Dispatch from the primary repository root, not from a linked worktree.",
      });
    }
  }

  // --- Runtimes -----------------------------------------------------------
  for (const requirement of runtimes) {
    const availability = await probe.runtimeAvailability(requirement.name);
    if (availability.available) {
      // Installed is not the same claim as usable, and the report must not make the
      // stronger one on the evidence of the weaker check.
      //
      // A runtime can be on PATH, version correctly, and still fail every dispatch:
      // the default model may be gated, unauthenticated, or out of quota, and none
      // of that is visible to `--version`. Claiming "available" on that basis sent an
      // operator into a run that could not succeed, and the failure surfaced minutes
      // later at a prompt timeout rather than here.
      //
      // So the wording follows the evidence: with a dispatch probe, "is available";
      // without one, "is installed", which is precisely what was checked.
      const dispatch = probe.dispatchCheck === undefined ? undefined : await probe.dispatchCheck(requirement.name);
      if (dispatch !== undefined && dispatch.probed && !dispatch.ok) {
        diagnostics.push({
          id: `runtime.${requirement.name}`,
          severity: "error",
          summary: `${requirement.name} is installed but cannot run a prompt`,
          remedy: `Fix the runtime before dispatching: ${dispatch.detail ?? "the probe could not complete"}`,
        });
        continue;
      }
      const probed = dispatch !== undefined && dispatch.probed;
      diagnostics.push({
        id: `runtime.${requirement.name}`,
        severity: "ok",
        summary: probed
          ? `${requirement.name} (${requirement.role}) is available`
          : `${requirement.name} (${requirement.role}) is installed`,
        ...(probed
          ? availability.version === undefined
            ? {}
            : { detail: availability.version }
          : {
              detail: `binary present; dispatch not verified${dispatch?.detail === undefined ? "" : ` (${dispatch.detail})`} — run \`doctor --probe\` to check`,
            }),
      });
      continue;
    }

    if (requirement.required) {
      diagnostics.push({
        id: `runtime.${requirement.name}`,
        severity: "error",
        summary: `Required ${requirement.role} '${requirement.name}' is not available`,
        remedy: `Install ${requirement.name} and ensure it is on PATH.`,
      });
    } else {
      diagnostics.push({
        id: `runtime.${requirement.name}`,
        severity: "warning",
        summary: `Optional ${requirement.role} '${requirement.name}' is not available`,
        remedy: `Install ${requirement.name} to use ${requirement.role} capabilities. Not required for dispatch.`,
      });
    }
  }

  // --- Project files ------------------------------------------------------
  const missingFiles = requiredFiles.filter((file) => !probe.fileExists(file));
  if (missingFiles.length === 0) {
    diagnostics.push({
      id: "project.files",
      severity: "ok",
      summary: `All ${requiredFiles.length} required project files are present`,
    });
  } else {
    diagnostics.push({
      id: "project.files",
      severity: "error",
      summary: `${missingFiles.length} required project file(s) missing`,
      detail: missingFiles.join(", "),
      remedy: "Restore the missing files; the factory treats them as authoritative.",
    });
  }

  return summarise(diagnostics);
}

/** Formats a report as deterministic, human-readable lines. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [`factory doctor: ${report.status}`];
  for (const diagnostic of report.diagnostics) {
    const marker = diagnostic.severity === "ok" ? "ok  " : diagnostic.severity === "warning" ? "warn" : "fail";
    lines.push(`  [${marker}] ${diagnostic.id}: ${diagnostic.summary}`);
    if (diagnostic.detail !== undefined) lines.push(`         ${diagnostic.detail}`);
    if (diagnostic.remedy !== undefined) lines.push(`         remedy: ${diagnostic.remedy}`);
  }
  lines.push(
    `  ${report.counts.ok} ok, ${report.counts.warning} warning(s), ${report.counts.error} error(s)`,
  );
  return lines.join("\n");
}

function summarise(diagnostics: Diagnostic[]): DoctorReport {
  const counts: Record<DiagnosticSeverity, number> = { error: 0, warning: 0, ok: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;

  const status: DoctorStatus = counts.error > 0 ? "blocked" : counts.warning > 0 ? "degraded" : "healthy";
  return { status, diagnostics, counts };
}