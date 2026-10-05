import { execFile } from "node:child_process";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createSystemProbe } from "../src/doctor/probe.js";
import { REQUIRED_PROJECT_FILES, runDoctor } from "../src/doctor/doctor.js";

/**
 * The doctor must not mutate the project it inspects. These tests prove it
 * against a real Git repository and a real worktree rather than asserting it
 * in prose, because "diagnostics do not mutate project state" is a claim worth
 * evidence.
 */

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "doctor-repo-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "doctor@example.test"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Doctor Test"], { cwd: dir });
  // Commit a tracked file so the tree has real content to leave alone.
  await execFileAsync("git", ["commit", "--quiet", "--allow-empty", "-m", "initial"], { cwd: dir });
  return dir;
}

/** Snapshot of everything a mutating doctor could plausibly disturb. */
async function snapshot(root: string): Promise<string> {
  const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: root });
  const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
  const branches = await execFileAsync("git", ["branch", "--list"], { cwd: root });
  const worktrees = await execFileAsync("git", ["worktree", "list"], { cwd: root });
  const entries: string[] = [];
  for (const entry of await readdir(root)) {
    const info = await stat(join(root, entry));
    entries.push(`${entry}:${info.isDirectory() ? "dir" : info.size}`);
  }
  return JSON.stringify({
    status: status.stdout,
    head: head.stdout,
    branches: branches.stdout,
    worktrees: worktrees.stdout,
    entries: entries.sort(),
  });
}

describe("the doctor does not mutate project state", () => {
  it("leaves status, HEAD, branches, worktrees and the file tree untouched", async () => {
    const repo = await makeRepo();
    const before = await snapshot(repo);

    const report = await runDoctor({ probe: createSystemProbe(repo) });

    const after = await snapshot(repo);
    expect(after).toBe(before);
    // It did run and produce diagnostics; it simply changed nothing.
    expect(report.diagnostics.length).toBeGreaterThan(0);
  });

  it("does not create a worktree while inspecting worktree support", async () => {
    const repo = await makeRepo();
    const probe = createSystemProbe(repo);

    await probe.worktreeSupport();
    await probe.worktreeSupport();

    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("registers no new branch after a full diagnostic pass", async () => {
    const repo = await makeRepo();
    const before = await execFileAsync("git", ["branch", "--list"], { cwd: repo });

    await runDoctor({ probe: createSystemProbe(repo) });

    const after = await execFileAsync("git", ["branch", "--list"], { cwd: repo });
    expect(after.stdout).toBe(before.stdout);
  });

  it("is safe to run twice with identical results", async () => {
    const repo = await makeRepo();
    const probe = createSystemProbe(repo);
    const first = await runDoctor({ probe });
    const second = await runDoctor({ probe });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("the doctor reads the real environment correctly", () => {
  it("reports a healthy Git worktree setup in a real repository", async () => {
    const repo = await makeRepo();
    const report = await runDoctor({ probe: createSystemProbe(repo) });

    expect(report.diagnostics.find((d) => d.id === "git.repository")?.severity).toBe("ok");
    expect(report.diagnostics.find((d) => d.id === "git.worktree")?.severity).toBe("ok");
    expect(report.diagnostics.find((d) => d.id === "git.clean")?.severity).toBe("ok");
  });

  it("blocks when pointed at a directory that is not a Git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "doctor-plain-"));
    const report = await runDoctor({ probe: createSystemProbe(dir) });
    expect(report.diagnostics.find((d) => d.id === "git.repository")?.severity).toBe("error");
    expect(report.status).toBe("blocked");
  });

  it("reports missing required project files in a bare repository", async () => {
    const repo = await makeRepo();
    const report = await runDoctor({
      probe: createSystemProbe(repo),
      requiredFiles: REQUIRED_PROJECT_FILES,
    });
    // A scratch repository has none of the factory's files.
    expect(report.diagnostics.find((d) => d.id === "project.files")?.severity).toBe("error");
  });

  it("detects an uncommitted change as a warning in a real repository", async () => {
    const repo = await makeRepo();
    await execFileAsync("git", ["commit", "--quiet", "--allow-empty", "-m", "second"], { cwd: repo });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(repo, "dirty.txt"), "uncommitted");

    const report = await runDoctor({ probe: createSystemProbe(repo) });
    // A dirty tree is a warning, never an error: it is worth reporting, but it
    // does not by itself make dispatch unsafe. Other diagnostics (missing
    // runtimes, absent project files) depend on the machine and are not what
    // this test is about.
    expect(report.diagnostics.find((d) => d.id === "git.clean")?.severity).toBe("warning");
    expect(report.diagnostics.some((d) => d.id === "git.clean" && d.severity === "error")).toBe(false);
    expect(report.diagnostics.find((d) => d.id === "git.clean")?.remedy).toContain("Commit or stash");
  });
});