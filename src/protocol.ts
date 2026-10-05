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
export interface AgentRef { id:string; runtimeId:string; }
export interface RuntimeEvidence { runtime:string; workspaceId:string; agentId:string; events:ExecutionEvent[]; }
export type RuntimeFailure = "unavailable"|"startup_failed"|"prompt_failed"|"timeout"|"blocked"|"agent_exited"|"workspace_failed"|"cleanup_failed"|"protocol_incompatible";
export interface RuntimeHealth { available:boolean; runtime:string; version?:string; }
export interface WorkerRuntime {
  capabilities():Promise<string[]>;
  health():Promise<RuntimeHealth>;
  createWorkspace(workUnit:WorkUnit):Promise<WorkspaceRef>;
  createWorktree(workspace:WorkspaceRef,baseRevision?:string):Promise<WorkspaceRef>;
  startAgent(workspace:WorkspaceRef,worker:Worker):Promise<AgentRef>;
  promptAgent(agent:AgentRef,prompt:string):Promise<void>;
  waitAgent(agent:AgentRef,timeoutMs:number):Promise<"running"|"idle"|"exited">;
  inspectAgent(agent:AgentRef):Promise<{status:string; failure?:RuntimeFailure}>;
  collectRuntimeEvidence(agent:AgentRef):Promise<RuntimeEvidence>;
  cleanupWorkspace(workspace:WorkspaceRef):Promise<void>;
}