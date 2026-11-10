import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeRuntime } from "../src/adapters/opencode/runtime.js";
import type { CommandRunner } from "../src/adapters/opencode/process.js";
import type { WorkUnit, Worker } from "../src/protocol.js";
const workUnit: WorkUnit = { id: "wu-1", goal: "Implement a bounded change", repository: "example/repo", capabilities: ["coding"], acceptanceCriteria: ["tests pass"] };
const worker: Worker = { id: "worker-opencode", capabilities: ["coding"], runtime: "opencode" };
function fakeRunner(responses: Record<string, { stdout?: string; stderr?: string; error?: Error }> = {}): CommandRunner { return { async run(command, args) { const response = responses[[command, ...args].join(" ")]; if (response?.error) throw response.error; return { stdout: response?.stdout ?? "", stderr: response?.stderr ?? "" }; } }; }
describe("OpenCodeRuntime", () => {
  it("implements the lifecycle without requiring OpenCode", async () => { const calls: string[][] = []; const runner: CommandRunner = { async run(command, args) { calls.push([command, ...args]); return { stdout: "ok", stderr: "" }; } }; const runtime = new OpenCodeRuntime({ workspaceRoot: ".tmp-test", runner }); const workspace = await runtime.createWorkspace(workUnit); const worktree = await runtime.createWorktree(workspace, "HEAD"); const agent = await runtime.startAgent(worktree, worker); await runtime.promptAgent(agent, "Implement the bounded change"); expect(await runtime.waitAgent(agent, 1000)).toBe("idle"); expect(await runtime.inspectAgent(agent)).toEqual({ status: "idle", failure: undefined }); const evidence = await runtime.collectRuntimeEvidence(agent); expect(evidence.runtime).toBe("opencode"); expect(evidence.events.map((event) => event.type)).toEqual(["prompt.started", "prompt.completed"]); expect(calls.some((call) => call[0] === "opencode" && call[1] === "run")).toBe(true); });
  it("maps an unavailable executable explicitly", async () => { const runtime = new OpenCodeRuntime({ runner: fakeRunner({ "opencode run --format json hello": { error: new Error("ENOENT: opencode not found") } }) }); const workspace = await runtime.createWorkspace(workUnit); const worktree = await runtime.createWorktree(workspace, "HEAD"); const agent = await runtime.startAgent(worktree, worker); await expect(runtime.promptAgent(agent, "hello")).rejects.toThrow("OpenCode runtime [unavailable]"); expect(await runtime.inspectAgent(agent)).toEqual({ status: "exited", failure: "unavailable" }); });
  it("keeps runtime completion separate from verification", async () => { const runtime = new OpenCodeRuntime({ runner: fakeRunner() }); const workspace = await runtime.createWorkspace(workUnit); const worktree = await runtime.createWorktree(workspace, "HEAD"); const agent = await runtime.startAgent(worktree, worker); await runtime.promptAgent(agent, "hello"); const runtimeStatus = await runtime.inspectAgent(agent); expect(runtimeStatus.status).toBe("idle"); expect("verification" in runtimeStatus).toBe(false); });

  it("attests the worktree where the agent process actually runs", async () => {
    // Real Git repository and a real subprocess. A runner that merely records
    // the cwd it was handed would prove the adapter echoed an argument; this
    // proves the process the agent runs in is the attested directory.
    const root = mkdtempSync(join(tmpdir(), "opencode-attest-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "a@b.c"], { cwd: root });
      execFileSync("git", ["config", "user.name", "t"], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "base"], { cwd: root });

      const recordedCwd = join(root, "recorded-cwd");
      const stub = join(root, "opencode-stub");
      writeFileSync(stub, `#!/bin/sh\npwd > "${recordedCwd}"\n`, { mode: 0o755 });

      const runtime = new OpenCodeRuntime({
        command: stub,
        repositoryRoot: root,
        workspaceRoot: join(root, "workspaces"),
      });

      const workspace = await runtime.createWorkspace(workUnit);
      const worktree = await runtime.createWorktree(workspace, "HEAD");
      const attestation = await runtime.attestIsolation({
        workUnit,
        workspace: worktree,
        repositoryRoot: root,
        observedAt: new Date().toISOString(),
      });

      expect(attestation.runtime).toBe("opencode");
      expect(attestation.level).toBe("git_worktree");
      expect(attestation.worktreePath).toBe(worktree.worktreePath);
      expect(attestation.agentCwd).toBe(worktree.worktreePath);

      const agent = await runtime.startAgent(worktree, worker);
      await runtime.promptAgent(agent, "implement the bounded change");

      expect(readFileSync(recordedCwd, "utf8").trim()).toBe(attestation.agentCwd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
