# Protocols

## Work Unit
A Work Unit is the smallest independently dispatchable engineering unit.

Required concepts:
- stable id
- goal
- repository
- base revision
- capability requirements
- scope
- acceptance criteria
- verification requirements
- autonomy policy

A Work Unit should be declarative. It describes desired work, not provider commands.

## Worker
A Worker is an execution identity that can satisfy declared capabilities.

Workers may be backed by OpenCode, Codex, Claude Code, or another supported runtime.

## Capability
A capability is a stable requirement such as:
- frontend
- backend
- browser
- testing
- documentation
- accessibility

Capabilities are the scheduler's contract with the Worker Registry.

## VerificationResult
Verification is independent evidence about whether acceptance criteria and repository gates pass.

A successful runtime execution is not a VerificationResult.

## Durable event record
Factory events are persisted to an append-only log so an execution stays reconstructable without
terminal history. Every persisted event carries a `runId`, an optional `parentRunId` for repair
attempts, and a `source` of `factory` or `runtime`. Only factory events determine factory state:
a runtime reporting `worker.finished` cannot make an execution complete. See `docs/provenance.md`.

## ExecutionEvent
Events form the append-only operational trace. Examples include:
- work.created
- work.validated
- workspace.created
- worker.started
- worker.finished
- verification.started
- verification.passed
- verification.failed
- repair.started
- integration.ready
- integration.blocked

## Scheduling
The scheduler decides ordering and grouping only. It exposes no field capable of expressing
verification or integration state, so it structurally cannot mark work correct or bypass the
integration gate. When a Work Unit does not declare the paths or contracts it touches, it is
treated as having uncertain ownership and serialized against everything. See `docs/scheduling.md`.

## Conflict
A Conflict records why two Work Units cannot safely execute or integrate concurrently.

Typical reasons:
- overlapping paths
- dependency relationship
- shared API/schema
- incompatible runtime assumptions
- protected resource
- uncertain ownership

## IntegrationResult
Integration records the result of the merge/integration gate and links back to verification evidence.

The concrete shape is `IntegrationResult` in `src/protocol.ts`, and `state: "ready"` is reachable
only through independent passing verification. See `docs/execution.md`.

## Key invariants
1. Provider-specific commands never appear in Work Units.
2. Runtime completion never implies correctness.
3. Every consequential state transition is traceable.
4. Integration cannot bypass verification.
5. Automatic repair is bounded.
