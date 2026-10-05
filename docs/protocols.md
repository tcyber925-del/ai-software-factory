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

Capabilities are the scheduler's contract with the Worker Registry. The wire contract is
`schemas/capability.schema.json` and the TypeScript type is `Capability`. A capability names a
requirement and must never carry a provider, command, or runtime field.

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

## Linear intake
Linear is an execution system, not the factory protocol. Only explicitly eligible work dispatches:
Backlog, Triage, Duplicate, Canceled and Done are never dispatchable and configuration cannot
override that, and the eligible-status allowlist is empty by default. An issue must declare its
acceptance criteria and capabilities explicitly, and supply a repository; the factory refuses rather
than inferring a product or architecture decision. Status reflection proposes an outcome from
recorded evidence and requires human acknowledgement before reporting done. See `docs/linear-adapter.md`.

## Hermes
Hermes is an optional orchestration entry point behind the same `WorkerRuntime` contract. It cannot
state that work is correct: `waitAgent` returns only its exit status, `inspectAgent` returns only
`{ status }`, and the integration gate is computed by modules that never receive Hermes state as an
input. Parent Work Unit identity is carried into every dispatched run, and Hermes' own approval
prompts and tool restrictions are preserved. See `docs/hermes-adapter.md`.

## Execution risk and isolation
Work is classified `trusted`, `untrusted` or `destructive`, and admission requires an isolation level
that meets the class: non-trusted work needs a **sandbox**, not an ordinary worktree, because a Git
worktree isolates files rather than privileges. A declared risk may raise the class but never lower
it, production credentials are never granted by the factory, and every decision is recorded as a
durable factory event. See `docs/security-policy.md`.

## Doctor
`factory doctor` reports whether the local environment can safely dispatch a Work Unit. It is
read-only, deterministic, and driven by an injected probe, so results do not depend on the machine
the doctor runs on. A missing optional runtime is a warning, never an error: Herdr is a preferred
supported runtime, not a mandatory dependency. See `docs/doctor.md`.

## Work Unit wire form
`schemas/work-unit.schema.json` is snake_case; the TypeScript `WorkUnit` is camelCase.
`workUnitToWireForm` and `workUnitFromWireForm` in `src/kernel/work-unit.ts` are the only two places
that correspondence is expressed, and they are tested as a round trip. The CLI parses work-unit
files through the inverse projection rather than casting, so a malformed Work Unit becomes an error
instead of a half-populated object that happens to validate.

## Repair
A deterministic verification failure may trigger a bounded number of repair attempts. Repair is judged
only by independent verification, never by the worker that performed it; the repair context restates
the original goal, acceptance criteria and scope so an attempt cannot become a requirement change; and
the attempt limit is enforced inside the loop. Reaching the limit escalates for human intervention.
See `docs/repair.md`.

## Scheduling
The scheduler decides ordering and grouping only. It exposes no field capable of expressing
verification or integration state, so it structurally cannot mark work correct or bypass the
integration gate. When a Work Unit does not declare the paths or contracts it touches, it is
treated as having uncertain ownership and serialized against everything. See `docs/scheduling.md`.

## Composition
`runPipeline` is the sequence: validate → plan → select runtime → dispatch → verify independently →
repair within a bound → integration record. Two invariants are enforced there rather than assumed:
readiness comes only from independent verification, and verification runs against the executed
worktree rather than the factory's checkout. A blocked integration halts dependent batches. See
`docs/cli.md`.

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
6. Verification inspects the tree that was executed, not the factory's own checkout.
