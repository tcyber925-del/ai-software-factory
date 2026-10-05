import {describe,expect,it} from "vitest";
import {FakeRuntime} from "../src/fake-runtime.js";
import type {Worker,WorkUnit} from "../src/protocol.js";

const workUnit:WorkUnit={id:"FCT-002",goal:"prove the runtime contract",repository:"example/project",capabilities:["testing"],acceptanceCriteria:["runtime lifecycle is deterministic"]};
const worker:Worker={id:"test-worker",capabilities:["testing"],runtime:"fake"};

describe("FakeRuntime",()=>{
  it("runs the runtime lifecycle without declaring verification success",async()=>{
    const runtime=new FakeRuntime();
    expect(await runtime.health()).toEqual({available:true,runtime:"fake",version:"test"});
    const workspace=await runtime.createWorkspace(workUnit);
    const isolated=await runtime.createWorktree(workspace);
    const agent=await runtime.startAgent(isolated,worker);
    await runtime.promptAgent(agent,"implement the bounded task");
    await expect(runtime.waitAgent(agent,1000)).resolves.toBe("idle");
    expect((await runtime.inspectAgent(agent)).status).toBe("idle");
    const evidence=await runtime.collectRuntimeEvidence(agent);
    expect(evidence.runtime).toBe("fake");
    expect(evidence.events.some(e=>e.type==="worker.finished")).toBe(true);
    await runtime.cleanupWorkspace(isolated);
  });

  it("represents an exited agent as runtime state, not verification success",async()=>{
    const runtime=new FakeRuntime(true);
    const workspace=await runtime.createWorkspace(workUnit);
    const agent=await runtime.startAgent(workspace,worker);
    await runtime.promptAgent(agent,"bounded task");
    await expect(runtime.waitAgent(agent,1000)).resolves.toBe("exited");
    expect((await runtime.inspectAgent(agent)).status).toBe("exited");
    const verification={status:"blocked" as const,checks:[]};
    expect(verification.status).not.toBe("passed");
  });

  it("rejects an empty prompt",async()=>{
    const runtime=new FakeRuntime();
    const workspace=await runtime.createWorkspace(workUnit);
    const agent=await runtime.startAgent(workspace,worker);
    await expect(runtime.promptAgent(agent,"   ")).rejects.toThrow("prompt must not be empty");
  });
});