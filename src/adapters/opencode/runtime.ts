import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRef, RuntimeEvidence, RuntimeFailure, RuntimeHealth, WorkUnit, Worker, WorkerRuntime, WorkspaceRef } from "../../protocol.js";
import type { CommandRunner } from "./process.js";
import { defaultCommandRunner } from "./process.js";

interface OpenCodeAgentState { workspace: WorkspaceRef; worker: Worker; status: "created" | "running" | "idle" | "exited"; failure?: RuntimeFailure; events: RuntimeEvidence["events"]; }
export interface OpenCodeRuntimeOptions { command?: string; workspaceRoot?: string; runner?: CommandRunner; }

export class OpenCodeRuntime implements WorkerRuntime {
  readonly #command: string; readonly #workspaceRoot: string; readonly #runner: CommandRunner;
  readonly #workspaces = new Map<string, WorkspaceRef>(); readonly #agents = new Map<string, OpenCodeAgentState>();
  constructor(options: OpenCodeRuntimeOptions = {}) { this.#command = options.command ?? "opencode"; this.#workspaceRoot = options.workspaceRoot ?? join(".factory", "workspaces"); this.#runner = options.runner ?? defaultCommandRunner; }
  async capabilities(): Promise<string[]> { return ["coding", "frontend", "backend", "testing", "review"]; }
  async health(): Promise<RuntimeHealth> { try { await this.#runner.run(this.#command, ["--version"], process.cwd()); return { available: true, runtime: "opencode" }; } catch { return { available: false, runtime: "opencode" }; } }
  async createWorkspace(_workUnit: WorkUnit): Promise<WorkspaceRef> { const id = `opencode-ws-${randomUUID()}`; const path = join(this.#workspaceRoot, id); await mkdir(path, { recursive: true }); const workspace = { id, path }; this.#workspaces.set(id, workspace); return workspace; }
  async createWorktree(workspace: WorkspaceRef, baseRevision?: string): Promise<WorkspaceRef> {
    const worktreePath = join(workspace.path, "worktree"); await mkdir(dirname(worktreePath), { recursive: true });
    const args = ["worktree", "add", "--detach", worktreePath]; if (baseRevision) args.push(baseRevision);
    try { await this.#runner.run("git", args, process.cwd()); } catch (error) { throw this.#runtimeError("workspace_failed", error); }
    const updated = { ...workspace, worktreePath }; this.#workspaces.set(workspace.id, updated); return updated;
  }
  async startAgent(workspace: WorkspaceRef, worker: Worker): Promise<AgentRef> { if (!workspace.worktreePath) throw new Error("OpenCode runtime requires a worktree before starting an agent"); const id = `opencode-agent-${randomUUID()}`; this.#agents.set(id, { workspace, worker, status: "created", events: [] }); return { id, runtimeId: id }; }
  async promptAgent(agent: AgentRef, prompt: string): Promise<void> {
    if (!prompt.trim()) throw new Error("prompt must not be empty"); const state = this.#agents.get(agent.id); if (!state) throw new Error("unknown OpenCode agent");
    state.status = "running"; state.events.push(this.#event(agent, "prompt.started", { prompt }));
    try { await this.#runner.run(this.#command, ["run", "--format", "json", prompt], state.workspace.worktreePath!); state.status = "idle"; state.events.push(this.#event(agent, "prompt.completed")); }
    catch (error) { state.status = "exited"; state.failure = this.#mapFailure(error); state.events.push(this.#event(agent, "prompt.failed", { failure: state.failure })); throw this.#runtimeError(state.failure, error); }
  }
  async waitAgent(agent: AgentRef, _timeoutMs: number): Promise<"running" | "idle" | "exited"> { const state = this.#agents.get(agent.id); if (!state) throw new Error("unknown OpenCode agent"); return state.status === "created" ? "running" : state.status; }
  async inspectAgent(agent: AgentRef): Promise<{ status: string; failure?: RuntimeFailure }> { const state = this.#agents.get(agent.id); if (!state) throw new Error("unknown OpenCode agent"); return { status: state.status, failure: state.failure }; }
  async collectRuntimeEvidence(agent: AgentRef): Promise<RuntimeEvidence> { const state = this.#agents.get(agent.id); if (!state) throw new Error("unknown OpenCode agent"); return { runtime: "opencode", workspaceId: state.workspace.id, agentId: agent.id, events: [...state.events] }; }
  async cleanupWorkspace(workspace: WorkspaceRef): Promise<void> { if (workspace.worktreePath) { try { await this.#runner.run("git", ["worktree", "remove", "--force", workspace.worktreePath], process.cwd()); } catch (error) { throw this.#runtimeError("cleanup_failed", error); } } await rm(workspace.path, { recursive: true, force: true }); this.#workspaces.delete(workspace.id); }
  #event(agent: AgentRef, type: string, payload?: Record<string, unknown>) { return { id: randomUUID(), workUnitId: "runtime-local", type, timestamp: new Date().toISOString(), payload: { agentId: agent.id, ...payload } }; }
  #mapFailure(error: unknown): RuntimeFailure { const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase(); if (message.includes("enoent") || message.includes("not found")) return "unavailable"; if (message.includes("timed out") || message.includes("timeout")) return "timeout"; if (message.includes("permission")) return "blocked"; if (message.includes("worktree")) return "workspace_failed"; return "agent_exited"; }
  #runtimeError(failure: RuntimeFailure, error: unknown): Error { const message = error instanceof Error ? error.message : String(error); return new Error(`OpenCode runtime [${failure}]: ${message}`); }
}
