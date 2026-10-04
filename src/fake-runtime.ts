import type {AgentRef,ExecutionEvent,RuntimeEvidence,RuntimeHealth,Worker,WorkerRuntime,WorkUnit,WorkspaceRef} from "./protocol.js";

export class FakeRuntime implements WorkerRuntime {
  readonly name="fake";
  private workspaceCounter=0;
  private agentCounter=0;
  private readonly statuses=new Map<string,"running"|"idle"|"exited">();
  private readonly events:ExecutionEvent[]=[];

  constructor(private readonly exitAfterPrompt=false) {}

  async capabilities():Promise<string[]> { return ["frontend","backend","browser","testing","documentation"]; }
  async health():Promise<RuntimeHealth> { return {available:true,runtime:this.name,version:"test"}; }

  async createWorkspace(workUnit:WorkUnit):Promise<WorkspaceRef> {
    const id="workspace-"+(++this.workspaceCounter);
    this.record(workUnit.id,"workspace.created",{workspaceId:id});
    return {id,path:"/tmp/factory/"+id};
  }

  async createWorktree(workspace:WorkspaceRef,baseRevision?:string):Promise<WorkspaceRef> {
    const worktree={...workspace,worktreePath:workspace.path+"/worktree"};
    this.record("runtime","worktree.created",{workspaceId:workspace.id,baseRevision});
    return worktree;
  }

  async startAgent(workspace:WorkspaceRef,worker:Worker):Promise<AgentRef> {
    const id="agent-"+(++this.agentCounter);
    this.statuses.set(id,"running");
    this.record("runtime","worker.started",{agentId:id,workspaceId:workspace.id,workerId:worker.id});
    return {id,runtimeId:id};
  }

  async promptAgent(agent:AgentRef,prompt:string):Promise<void> {
    if(!prompt.trim()) throw new Error("prompt must not be empty");
    this.record("runtime","agent.prompted",{agentId:agent.id});
    if(this.exitAfterPrompt) this.statuses.set(agent.id,"exited");
  }

  async waitAgent(agent:AgentRef,_timeoutMs:number):Promise<"running"|"idle"|"exited"> {
    const current=this.statuses.get(agent.id);
    if(!current) throw new Error("unknown agent");
    if(current==="running") this.statuses.set(agent.id,"idle");
    const status=this.statuses.get(agent.id) ?? "exited";
    this.record("runtime","worker.finished",{agentId:agent.id,status});
    return status;
  }

  async inspectAgent(agent:AgentRef):Promise<{status:string; failure?:never}> {
    const status=this.statuses.get(agent.id);
    if(!status) throw new Error("unknown agent");
    return {status};
  }

  async collectRuntimeEvidence(agent:AgentRef):Promise<RuntimeEvidence> {
    return {runtime:this.name,workspaceId:"unknown",agentId:agent.id,events:this.events.filter(e=>e.payload?.agentId===agent.id)};
  }

  async cleanupWorkspace(workspace:WorkspaceRef):Promise<void> {
    this.record("runtime","workspace.cleaned",{workspaceId:workspace.id});
  }

  private record(workUnitId:string,type:string,payload:Record<string,unknown>):void {
    this.events.push({id:"event-"+(this.events.length+1),workUnitId,type,timestamp:new Date(0).toISOString(),payload});
  }
}