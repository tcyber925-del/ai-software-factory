export type Autonomy = "automatic" | "review" | "approval";
export interface WorkUnit { id:string; goal:string; repository:string; baseRevision?:string; capabilities:string[]; scope?:string[]; acceptanceCriteria:string[]; verification?:string[]; autonomy?:Autonomy; }
export interface Worker { id:string; capabilities:string[]; runtime:string; version?:string; }
export type VerificationStatus = "passed"|"failed"|"blocked";
export type CheckStatus = "passed"|"failed"|"skipped";
export interface VerificationCheck { name:string; status:CheckStatus; evidence?:string; }
export interface VerificationResult { workUnitId:string; status:VerificationStatus; checks:VerificationCheck[]; attempt?:number; }
export interface ExecutionEvent { id:string; workUnitId:string; type:string; timestamp:string; payload?:Record<string,unknown>; }
export type ConflictReason = "overlapping_paths"|"dependency"|"shared_contract"|"runtime_assumption"|"protected_resource"|"uncertain";
export interface Conflict { id:string; workUnits:string[]; reason:ConflictReason; details?:string; }
export type IntegrationState = "ready"|"blocked";
export interface IntegrationResult { workUnitId:string; state:IntegrationState; reason:string; verification:VerificationResult; commit?:string; events:ExecutionEvent[]; }
export interface WorkspaceRef { id:string; path:string; worktreePath?:string; }
/**
 * Isolation strength, ordered weakest to strongest.
 *
 * `git_worktree` separates files. It does not separate privileges, processes, or
 * the host, so it is not a sandbox and never implies one.
 */
export type IsolationLevel = "none" | "git_worktree" | "sandbox";
/**
 * What a runtime is asked to attest, after the workspace/worktree exists and
 * before any agent process starts.
 *
 * The request carries the kernel's observation time so a runtime cannot mint a
 * fresh-looking timestamp for evidence it collected earlier. A runtime may still
 * lie; that is why admission validates identity as well as level and why a
 * conformance test exercises the actual execution directory.
 */
export interface IsolationAttestationRequest {
  workUnit: WorkUnit;
  workspace: WorkspaceRef;
  repositoryRoot: string;
  /** When the kernel asked for the evidence, in ISO-8601 form. */
  observedAt: string;
}
/**
 * Typed, runtime-bound isolation evidence.
 *
 * This is deliberately not `IsolationLevel`. A level alone is a caller-supplied
 * label; an attestation binds a level to one runtime, one Work Unit, one
 * workspace, one worktree, and the directory the agent will actually run in.
 */
export interface IsolationAttestation {
  /** Runtime identity that produced the evidence. Checked against the selected runtime. */
  runtime: string;
  /** The isolation level the runtime claims to provide. */
  level: IsolationLevel;
  workUnitId: string;
  workspaceId: string;
  /** The main checkout the worktree belongs to. */
  repositoryRoot: string;
  /** The directory the agent process will execute in. */
  agentCwd: string;
  /** Required when `level` is `git_worktree` or stronger. */
  worktreePath?: string;
  /** When the evidence was observed, in ISO-8601 form. */
  observedAt: string;
  baseRevision?: string;
}
/** A stable capability requirement. Names a requirement, never a provider or command. Mirrors schemas/capability.schema.json. */
export interface Capability { name:string; category?:string; description?:string; }
export interface AgentRef { id:string; runtimeId:string; }
export interface RuntimeEvidence { runtime:string; workspaceId:string; agentId:string; events:ExecutionEvent[]; }
export type RuntimeFailure = "unavailable"|"startup_failed"|"prompt_failed"|"timeout"|"blocked"|"agent_exited"|"workspace_failed"|"cleanup_failed"|"protocol_incompatible";
export interface RuntimeHealth { available:boolean; runtime:string; version?:string; }
export interface WorkerRuntime {
  capabilities():Promise<string[]>;
  health():Promise<RuntimeHealth>;
  createWorkspace(workUnit:WorkUnit):Promise<WorkspaceRef>;
  createWorktree(workspace:WorkspaceRef,baseRevision?:string):Promise<WorkspaceRef>;
  /** Evidence of the isolation actually provided, checked before `startAgent`. */
  attestIsolation(request:IsolationAttestationRequest):Promise<IsolationAttestation>;
  startAgent(workspace:WorkspaceRef,worker:Worker):Promise<AgentRef>;
  promptAgent(agent:AgentRef,prompt:string):Promise<void>;
  waitAgent(agent:AgentRef,timeoutMs:number):Promise<"running"|"idle"|"exited">;
  inspectAgent(agent:AgentRef):Promise<{status:string; failure?:RuntimeFailure}>;
  collectRuntimeEvidence(agent:AgentRef):Promise<RuntimeEvidence>;
  cleanupWorkspace(workspace:WorkspaceRef):Promise<void>;
}