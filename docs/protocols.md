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
