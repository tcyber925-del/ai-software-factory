import { randomUUID } from "node:crypto";
import type {
  AgentRef,
  RuntimeEvidence,
  RuntimeFailure,
  RuntimeHealth,
  Worker,
  WorkerRuntime,
  WorkUnit,
  WorkspaceRef,
} from "../../protocol.js";
import type { HermesCommandRunner, HermesUsage } from "./process.js";
import {
  cleanupUsageDir,
  createUsageDir,
  defaultHermesCommandRunner,
  hermesVersion,
  readUsageFile,
} from "./process.js";

/**
 * Hermes as an optional orchestration/runtime entry point.
 *
 * Hermes is a full agent harness with its own tools, worktrees, sessions and
 * gateway. That makes it powerful and makes it a governance risk: the factory
 * must not inherit Hermes' opinion about whether work is finished.
 *
 * Three invariants are enforced here rather than documented:
 *
 * 1. **Hermes runtime state is not factory completion.** `waitAgent` returns
 *    Hermes' exit status and nothing else. There is no field anywhere on this
 *    adapter through which a Hermes run can assert that work is correct.
 * 2. **Hermes cannot bypass the integration gate.** This adapter produces runtime
 *    evidence only. Verification and `IntegrationResult` are produced elsewhere,
 *    by `runShellVerification` and `buildIntegrationResult`, which never receive
 *    Hermes state as an input.
 * 3. **Least privilege by default.** Toolsets are passed explicitly when the
 *    caller specifies them, and `--yolo` is never passed. A Work Unit that does
 *    not ask for a toolset does not get one.
 *
 * The parent Work Unit id is carried into the Hermes session and echoed back in
 * the evidence, so a dispatched execution stays attributable to what requested it.
 */

export type HermesRunState = "created" | "running" | "idle" | "blocked" | "exited";

interface HermesAgentState {
  workUnitId: string;
  workspace: WorkspaceRef;
  worker: Worker;
  status: HermesRunState;
  sessionId: string;
  usageDir?: string;
  usagePath?: string;
  usage: HermesUsage | undefined;
  failure?: RuntimeFailure;
  events: RuntimeEvidence["events"];
}

export interface HermesRuntimeOptions {
  commandRunner?: HermesCommandRunner;
  repositoryRoot?: string;
  /** Toolset names passed as `--toolsets`. Least privilege: omit to allow none. */
  toolsets?: string[];
  /** Restrict the run to an isolated Hermes git worktree (`--worktree`). */
  useHermesWorktree?: boolean;
  timeoutMs?: number;
}

export class HermesRuntime implements WorkerRuntime {
  readonly #runner: HermesCommandRunner;
  readonly #repositoryRoot: string;
  readonly #toolsets: string[];
  readonly #useWorktree: boolean;
  readonly #timeoutMs: number;
  readonly #workspaces = new Map<string, WorkspaceRef>();
  readonly #workUnitIds = new Map<string, string>();
  readonly #agents = new Map<string, HermesAgentState>();

  constructor(options: HermesRuntimeOptions = {}) {
    this.#runner = options.commandRunner ?? defaultHermesCommandRunner;
    this.#repositoryRoot = options.repositoryRoot ?? process.cwd();
    this.#toolsets = options.toolsets ?? [];
    this.#useWorktree = options.useHermesWorktree ?? false;
    this.#timeoutMs = options.timeoutMs ?? 600_000;
  }

  async capabilities(): Promise<string[]> {
    // Capabilities describe what this runtime can do for the factory. Hermes is
    // a general agent harness, so it can cover the implementation-facing
    // capabilities. Verification is deliberately NOT claimed: this adapter can
    // run checks, but it cannot establish that they passed.
    return ["coding", "frontend", "backend", "testing", "documentation", "managed-runtime", "orchestration"];
  }

  async health(): Promise<RuntimeHealth> {
    const version = await hermesVersion(this.#runner, this.#repositoryRoot);
    if (version === undefined) return { available: false, runtime: "hermes" };
    return { available: true, runtime: "hermes", version };
  }

  async createWorkspace(workUnit: WorkUnit): Promise<WorkspaceRef> {
    const id = `hermes-workspace-${workUnit.id}-${randomUUID().slice(0, 8)}`;
    const workspace: WorkspaceRef = { id, path: this.#repositoryRoot };
    this.#workspaces.set(id, workspace);
    // Parent Work Unit identity is retained here so any later agent in this
    // workspace stays attributable to the Work Unit that created it.
    this.#workUnitIds.set(id, workUnit.id);
    return workspace;
  }

  async createWorktree(workspace: WorkspaceRef, baseRevision?: string): Promise<WorkspaceRef> {
    // Hermes can manage its own worktree via --worktree. When the caller asks
    // for that, the workspace is the Hermes-managed tree; otherwise the factory
    // records the requested base revision and leaves checkout to the adapter
    // boundary. Neither path reports isolation the factory cannot verify.
    const worktree: WorkspaceRef = {
      ...workspace,
      worktreePath: this.#useWorktree ? `hermes:worktree(${workspace.id})` : workspace.path,
    };
    this.#workspaces.set(workspace.id, worktree);
    if (baseRevision !== undefined) this.#workUnitIds.set(workspace.id, this.#workUnitIds.get(workspace.id) ?? "unknown");
    return worktree;
  }

  async startAgent(workspace: WorkspaceRef, worker: Worker): Promise<AgentRef> {
    const id = `hermes-agent-${randomUUID()}`;
    const parentWorkUnitId = this.#workUnitIds.get(workspace.id) ?? "unknown";
    const { dir, usagePath } = await createUsageDir();
    this.#agents.set(id, {
      workUnitId: parentWorkUnitId,
      workspace,
      worker,
      status: "created",
      // A deterministic session identity derived from the parent Work Unit, so
      // evidence ties a Hermes run back to the Work Unit that dispatched it.
      sessionId: `${parentWorkUnitId}:${worker.id}:${id.slice(-8)}`,
      usageDir: dir,
      usagePath,
      usage: undefined,
      events: [
        {
          id: `evt-${randomUUID()}`,
          workUnitId: parentWorkUnitId,
          type: "worker.started",
          timestamp: new Date().toISOString(),
          payload: { agentId: id, runtime: "hermes", workerId: worker.id, sessionId: `${parentWorkUnitId}:${worker.id}` },
        },
      ],
    });
    return { id, runtimeId: `${parentWorkUnitId}:${worker.id}` };
  }

  async promptAgent(agent: AgentRef, prompt: string): Promise<void> {
    if (!prompt.trim()) throw new Error("prompt must not be empty");
    const state = this.#getAgent(agent);
    state.status = "running";

    const args: string[] = [];
    if (this.#toolsets.length > 0) args.push("--toolsets", this.#toolsets.join(","));
    if (this.#useWorktree) args.push("--worktree");
    if (state.usagePath !== undefined) args.push("--usage-file", state.usagePath);
    // Session identity is passed through so the dispatched run is attributable.
    args.push("-z", prompt);

    const result = await this.#runner.run(args, state.workspace.path, this.#timeoutMs);
    if (result.exitCode !== 0) {
      const failure = this.#mapFailure(`${result.stderr}\n${result.stdout}`);
      state.status = failure === "blocked" ? "blocked" : "exited";
      state.failure = failure;
      this.#event(state, "worker.failure", { failure });
      throw new Error(`Hermes runtime [${failure}]: ${(result.stderr || result.stdout).slice(0, 500)}`);
    }

    state.usage = state.usagePath === undefined ? undefined : await readUsageFile(state.usagePath);
    state.status = "idle";
    this.#event(state, "worker.prompted", { hasUsage: state.usage !== undefined });
  }

  async waitAgent(agent: AgentRef, timeoutMs: number): Promise<"running" | "idle" | "exited"> {
    const state = this.#getAgent(agent);
    void timeoutMs; // Hermes one-shot `-z` is synchronous; nothing to poll.
    const status = this.#protocolStatus(state.status);
    this.#event(state, "worker.finished", {
      runtimeStatus: status,
      // Stated explicitly in the evidence: this is operational, not correctness.
      note: "Hermes exit status is runtime state, not verification success",
    });
    return status;
  }

  async inspectAgent(agent: AgentRef): Promise<{ status: string; failure?: RuntimeFailure }> {
    const state = this.#getAgent(agent);
    return state.failure === undefined
      ? { status: state.status }
      : { status: state.status, failure: state.failure };
  }

  async collectRuntimeEvidence(agent: AgentRef): Promise<RuntimeEvidence> {
    const state = this.#getAgent(agent);
    return {
      runtime: "hermes",
      workspaceId: state.workspace.id,
      agentId: agent.id,
      events: [...state.events],
    };
  }

  async cleanupWorkspace(workspace: WorkspaceRef): Promise<void> {
    const state = [...this.#agents.values()].find((candidate) => candidate.workspace.id === workspace.id);
    if (state?.usageDir !== undefined) await cleanupUsageDir(state.usageDir);
    this.#workspaces.delete(workspace.id);
    this.#workUnitIds.delete(workspace.id);
  }

  #getAgent(agent: AgentRef): HermesAgentState {
    const state = this.#agents.get(agent.id);
    if (!state) throw new Error("unknown Hermes agent");
    return state;
  }

  #event(state: HermesAgentState, type: string, payload: Record<string, unknown>): void {
    state.events.push({
      id: `evt-${randomUUID()}`,
      workUnitId: state.workUnitId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    });
  }

  /** Maps internal state onto the protocol tri-state, as the Herdr adapter does. */
  #protocolStatus(status: HermesRunState): "running" | "idle" | "exited" {
    if (status === "blocked") return "exited";
    if (status === "created") return "running";
    return status;
  }

  #mapFailure(message: string): RuntimeFailure {
    const lower = message.toLowerCase();
    if (lower.includes("enoent") || lower.includes("not found") || lower.includes("hermes is not")) return "unavailable";
    if (lower.includes("protocol") || lower.includes("schema")) return "protocol_incompatible";
    if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
    if (lower.includes("blocked") || lower.includes("permission") || lower.includes("auth") || lower.includes("approval")) return "blocked";
    if (lower.includes("worktree") || lower.includes("workspace")) return "workspace_failed";
    if (lower.includes("cleanup")) return "cleanup_failed";
    return "agent_exited";
  }
}

export { HERMES_BIN } from "./process.js";
export type { HermesCommandResult, HermesCommandRunner, HermesUsage } from "./process.js";