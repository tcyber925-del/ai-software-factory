import { randomUUID } from "node:crypto";
import type {
  AgentRef,
  RuntimeEvidence,
  RuntimeFailure,
  RuntimeHealth,
  WorkUnit,
  Worker,
  WorkerRuntime,
  WorkspaceRef,
} from "../../protocol.js";
import type { HerdrCommandRunner } from "./process.js";
import { defaultHerdrCommandRunner } from "./process.js";

interface HerdrWorkspaceResponse {
  result?: {
    workspace?: { workspace_id?: string };
    root_pane?: { pane_id?: string };
    worktree?: { worktree_id?: string; path?: string; branch?: string };
  };
}

interface HerdrAgentResponse {
  result?: {
    agent?: { name?: string; status?: string };
  };
}

interface HerdrAgentState {
  workUnitId: string;
  workspace: WorkspaceRef;
  worker: Worker;
  agentName: string;
  status: "created" | "running" | "idle" | "blocked" | "exited";
  failure?: RuntimeFailure;
  events: RuntimeEvidence["events"];
}

export interface HerdrRuntimeOptions {
  commandRunner?: HerdrCommandRunner;
  repositoryRoot?: string;
  workspaceLabelPrefix?: string;
}

export class HerdrRuntime implements WorkerRuntime {
  readonly #runner: HerdrCommandRunner;
  readonly #repositoryRoot: string;
  readonly #workspaceLabelPrefix: string;
  readonly #workspaces = new Map<string, WorkspaceRef>();
  readonly #workUnitIds = new Map<string, string>();
  readonly #agents = new Map<string, HerdrAgentState>();

  constructor(options: HerdrRuntimeOptions = {}) {
    this.#runner = options.commandRunner ?? defaultHerdrCommandRunner;
    this.#repositoryRoot = options.repositoryRoot ?? process.cwd();
    this.#workspaceLabelPrefix = options.workspaceLabelPrefix ?? "factory";
  }

  async capabilities(): Promise<string[]> {
    return ["coding", "frontend", "backend", "testing", "review", "managed-runtime"];
  }

  async health(): Promise<RuntimeHealth> {
    try {
      await this.#runner.run(["status", "server"], this.#repositoryRoot);
      return { available: true, runtime: "herdr" };
    } catch {
      return { available: false, runtime: "herdr" };
    }
  }

  async createWorkspace(workUnit: WorkUnit): Promise<WorkspaceRef> {
    const label = `${this.#workspaceLabelPrefix}-${workUnit.id}-${randomUUID().slice(0, 8)}`;
    try {
      const response = await this.#runJson<HerdrWorkspaceResponse>([
        "workspace",
        "create",
        "--cwd",
        this.#repositoryRoot,
        "--label",
        label,
        "--no-focus",
      ]);
      const id = response.result?.workspace?.workspace_id;
      const paneId = response.result?.root_pane?.pane_id;
      if (!id || !paneId) throw new Error("Herdr workspace response omitted workspace or pane ID");
      const workspace = { id, path: this.#repositoryRoot };
      this.#workspaces.set(id, workspace);
      this.#workUnitIds.set(id, workUnit.id);
      return workspace;
    } catch (error) {
      throw this.#runtimeError(this.#mapFailure(error), error);
    }
  }

  async createWorktree(workspace: WorkspaceRef, baseRevision?: string): Promise<WorkspaceRef> {
    const branch = `factory/${this.#workUnitIds.get(workspace.id) ?? randomUUID()}`;
    const args = [
      "worktree",
      "create",
      "--workspace",
      workspace.id,
      "--branch",
      branch,
      "--no-focus",
    ];
    if (baseRevision) args.push("--base", baseRevision);

    try {
      const response = await this.#runJson<HerdrWorkspaceResponse>(args);
      const path = response.result?.worktree?.path;
      if (!path) throw new Error("Herdr worktree response omitted checkout path");
      const updated = { ...workspace, worktreePath: path };
      this.#workspaces.set(workspace.id, updated);
      return updated;
    } catch (error) {
      throw this.#runtimeError("workspace_failed", error);
    }
  }

  async startAgent(workspace: WorkspaceRef, worker: Worker): Promise<AgentRef> {
    const paneId = await this.#rootPane(workspace.id);
    const id = `herdr-agent-${randomUUID()}`;
    const agentName = id;
    const kind = worker.runtime || "opencode";

    try {
      await this.#runJson<HerdrAgentResponse>([
        "agent",
        "start",
        agentName,
        "--kind",
        kind,
        "--pane",
        paneId,
        "--timeout",
        "30000",
        "--",
        kind,
      ]);
    } catch (error) {
      const failure = this.#mapFailure(error);
      this.#agents.set(id, {
        workUnitId: this.#workUnitIds.get(workspace.id) ?? "unknown",
        workspace,
        worker,
        agentName,
        status: "exited",
        failure,
        events: [],
      });
      throw this.#runtimeError(failure, error);
    }

    this.#agents.set(id, {
      workUnitId: this.#workUnitIds.get(workspace.id) ?? "unknown",
      workspace,
      worker,
      agentName,
      status: "idle",
      events: [this.#event(id, "agent.started", { agentName, kind })],
    });
    return { id, runtimeId: agentName };
  }

  async promptAgent(agent: AgentRef, prompt: string): Promise<void> {
    if (!prompt.trim()) throw new Error("prompt must not be empty");
    const state = this.#getAgent(agent);
    state.status = "running";
    state.events.push(this.#event(agent.id, "prompt.started", { prompt }));

    try {
      await this.#runJson<HerdrAgentResponse>([
        "agent",
        "prompt",
        state.agentName,
        prompt,
        "--wait",
        "--timeout",
        "120000",
      ]);
      state.status = "idle";
      state.events.push(this.#event(agent.id, "prompt.completed"));
    } catch (error) {
      state.status = this.#mapFailure(error) === "blocked" ? "blocked" : "exited";
      state.failure = this.#mapFailure(error);
      state.events.push(this.#event(agent.id, "prompt.failed", { failure: state.failure }));
      throw this.#runtimeError(state.failure, error);
    }
  }

  async waitAgent(agent: AgentRef, timeoutMs: number): Promise<"running" | "idle" | "exited"> {
    const state = this.#getAgent(agent);
    try {
      const response = await this.#runJson<HerdrAgentResponse>([
        "agent",
        "wait",
        state.agentName,
        "--until",
        "idle",
        "--until",
        "done",
        "--until",
        "blocked",
        "--timeout",
        String(Math.max(3001, timeoutMs)),
      ]);
      const status = response.result?.agent?.status;
      if (status === "blocked") state.status = "blocked";
      else if (status === "done" || status === "idle") state.status = "idle";
      return state.status === "blocked" ? "exited" : state.status;
    } catch (error) {
      const failure = this.#mapFailure(error);
      state.failure = failure;
      if (failure === "timeout") return "running";
      state.status = failure === "blocked" ? "blocked" : "exited";
      return state.status === "blocked" ? "exited" : state.status;
    }
  }

  async inspectAgent(agent: AgentRef): Promise<{ status: string; failure?: RuntimeFailure }> {
    const state = this.#getAgent(agent);
    try {
      const response = await this.#runJson<HerdrAgentResponse>([
        "agent",
        "get",
        state.agentName,
      ]);
      const status = response.result?.agent?.status;
      if (status) {
        if (status === "blocked") state.status = "blocked";
        else if (status === "done" || status === "idle") state.status = "idle";
        else if (status === "working") state.status = "running";
      }
    } catch {
      // Preserve the last independently observed state if inspection is unavailable.
    }
    return state.failure === undefined
      ? { status: state.status }
      : { status: state.status, failure: state.failure };
  }

  async collectRuntimeEvidence(agent: AgentRef): Promise<RuntimeEvidence> {
    const state = this.#getAgent(agent);
    return {
      runtime: "herdr",
      workspaceId: state.workspace.id,
      agentId: agent.id,
      events: [...state.events],
    };
  }

  async cleanupWorkspace(workspace: WorkspaceRef): Promise<void> {
    try {
      await this.#runJson([
        "worktree",
        "remove",
        "--workspace",
        workspace.id,
        "--force",
      ]);
      await this.#runJson(["workspace", "close", workspace.id]);
      this.#workspaces.delete(workspace.id);
      this.#workUnitIds.delete(workspace.id);
    } catch (error) {
      throw this.#runtimeError("cleanup_failed", error);
    }
  }

  async #rootPane(workspaceId: string): Promise<string> {
    const response = await this.#runJson<HerdrWorkspaceResponse>([
      "workspace",
      "get",
      workspaceId,
    ]);
    const pane = response.result?.root_pane?.pane_id;
    if (!pane) throw new Error("Herdr workspace response omitted root pane ID");
    return pane;
  }

  async #runJson<T>(args: string[]): Promise<T> {
    const result = await this.#runner.run(args, this.#repositoryRoot);
    const output = result.stdout.trim();
    if (!output) throw new Error(result.stderr || "Herdr returned no JSON output");
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new Error(`Herdr returned invalid JSON: ${output.slice(0, 500)}`);
    }
  }

  #getAgent(agent: AgentRef): HerdrAgentState {
    const state = this.#agents.get(agent.id);
    if (!state) throw new Error("unknown Herdr agent");
    return state;
  }

  #event(agentId: string, type: string, payload?: Record<string, unknown>) {
    return {
      id: randomUUID(),
      workUnitId: this.#agents.get(agentId)?.workUnitId ?? "unknown",
      type,
      timestamp: new Date().toISOString(),
      payload: { agentId, ...payload },
    };
  }

  #mapFailure(error: unknown): RuntimeFailure {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("not found") || message.includes("enoent") || message.includes("connect")) return "unavailable";
    if (message.includes("protocol") || message.includes("schema")) return "protocol_incompatible";
    if (message.includes("timeout") || message.includes("timed out")) return "timeout";
    if (message.includes("blocked") || message.includes("permission") || message.includes("auth")) return "blocked";
    if (message.includes("workspace") || message.includes("worktree")) return "workspace_failed";
    if (message.includes("start") || message.includes("agent_not_ready")) return "startup_failed";
    return "agent_exited";
  }

  #runtimeError(failure: RuntimeFailure, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`Herdr runtime [${failure}]: ${message}`);
  }
}
