# Architecture

## Purpose
The factory is a thin coordination and governance layer over existing coding-agent runtimes.

## Responsibilities

### Factory owns
- Work Unit protocol
- capability requirements
- policy and autonomy
- scheduling semantics
- conflict detection
- execution events/state
- verification requirements/evidence
- integration gates
- traceability

### Runtime owns
- terminal/session lifecycle
- agent process lifecycle
- prompts and runtime interaction
- runtime-specific workspace mechanics
- runtime health

## Reference architecture

```
Founder / Product Owner
        ↓
Approved specification
        ↓
Work Unit  (declarative; capabilities, not providers)
        ↓
Eligibility  (Linear intake — explicit allowlist, nothing inferred)   ← library, not composed
        ↓
Security gate  (risk class → required isolation)                      ← composed, before dispatch
        ↓
Scheduler  (batches, conflicts, dependencies)                         ← composed
        ↓
Runtime Adapter
   ┌────┴───────────┐
   │                │
Direct Runtime   Managed Runtime
OpenCode         Herdr / Hermes
        ↓
Isolated Git worktree
        ↓
Implementation
        ↓
Independent verification  (against the executed worktree)             ← composed
        ↓
  ├─ failed → bounded repair → re-verify → escalate at the limit       ← composed
  ↓
Integration gate  (ready only through passing verification)            ← composed
        ↓
Durable event log  (reconstructable; runtime state ≠ factory state)    ← composed
        ↓
PR / human review                                                      ← human-led
        ↓
Release / observe / learn                                              ← human-led
```

The annotations matter. Four boxes are marked *library, not composed* or *human-led* because they are shipped and documented but not on the CLI's dispatch path. `src/kernel/pipeline.ts` composes only the boxes marked *composed*. See [cli.md](cli.md).

The security gate runs **before** anything is dispatched — before a workspace, before a worktree,
before a runtime is invoked — so a refusal has no aftermath to clean up. Each decision is persisted as
a durable factory event, for admitted work as well as refused work.

## The composition layer

Each box above is implemented and tested. Before FCT-016 they had never run in sequence —
`planSchedule`, `executeWorkUnit`, `runShellVerification`, and `buildIntegrationResult` were
exercised only in isolation. `src/kernel/pipeline.ts` composes them, and `factory work run` is the
command. See [cli.md](cli.md).

## Provider neutrality
A Work Unit requests capabilities such as `frontend`, `testing`, or `browser`. It must not require a particular provider command.

Provider-specific behavior belongs in adapters.

## Runtime abstraction
`WorkerRuntime` is ten methods, listed in [runtime-adapters.md](runtime-adapters.md). There is no
method through which a runtime can report success: the contract has nowhere to put that judgement.

Shipped adapters: `fake`, `opencode`, `herdr`, `hermes`. Herdr and Hermes are supported but not
mandatory.

`factory doctor` reports `opencode` as required, and `herdr` and `hermes` as optional. Hermes is
checked because the CLI offers it whenever its binary is on `PATH`; without the check, a broken
install would surface mid-dispatch — after a worktree was created and an agent started. Optional
means an *absent* runtime is a warning, never a blocker.

## State invariant
Runtime state and factory state are separate.

Examples:
- runtime `idle` does not mean Work Unit complete;
- runtime disconnect does not automatically mean Work Unit failed;
- agent exit does not establish correctness.

Completion requires factory verification evidence.

This is enforced structurally, not by convention. `runShellVerification` accepts no execution
record, so it cannot consult runtime state even if a caller wanted it to. `buildIntegrationResult`
reaches `ready` only on passing verification. `reconstructExecution` decides an outcome only from
`source: "factory"` events, so a runtime reporting `worker.finished` cannot complete an execution.

## Where each box lives

| Concern | Module |
|---|---|
| Protocol types | `src/protocol.ts` |
| Validation and runtime selection | `src/kernel/work-unit.ts`, `src/kernel/json-schema.ts` |
| Execution | `src/kernel/execution.ts` |
| Integration gate | `src/kernel/integration.ts` |
| Scheduling | `src/kernel/scheduler.ts` |
| Bounded repair | `src/kernel/repair.ts` |
| Composition | `src/kernel/pipeline.ts` |
| Verification | `src/adapters/verification/shell.ts` |
| Durable events | `src/state/event-log.ts`, `src/state/provenance.ts` |
| Risk and isolation | `src/security/risk.ts`, `src/security/index.ts` |
| Environment checks | `src/doctor/doctor.ts`, `src/doctor/probe.ts` |
| CLI | `src/cli/`, `src/bin.ts` |
| Runtimes | `src/adapters/opencode`, `src/adapters/herdr`, `src/adapters/hermes`, `src/fake-runtime.ts` |
| Intake | `src/adapters/linear/` |

## Isolation and concurrency
Two Work Units may run concurrently only when their dependencies, touched paths, APIs, schemas, runtime assumptions, and integration surfaces are sufficiently independent.

When uncertainty exists, serialize.

Git worktrees prevent ordinary working-tree collisions but do not provide a security sandbox. A
Work Unit classified `untrusted` or `destructive` is **refused** rather than run in one, because no
shipped adapter offers the isolation it requires. See [security-policy.md](security-policy.md).

The refusal is enforced by the pipeline and covered by `tests/security.test.ts`. Risk signals are
declared on the plan, never inferred from the goal text — see
[security-policy.md](security-policy.md) for what that does and does not buy you.

## V1 boundary
Local-first, no hosted control plane, no custom agent runtime, no database, no web dashboard, no
scheduler daemon, and no autonomous merge or release.
