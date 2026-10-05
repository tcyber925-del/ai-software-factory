# Execution Slice

## Purpose

This documents the first end-to-end factory execution slice (FCT-006): the path from an
approved Work Unit to an explicit integration record, using only the existing
provider-neutral protocols and `WorkerRuntime`.

It is a kernel, not a scheduler. Nothing here decides *which* Work Unit runs next, and nothing
here can mark work correct.

## The path

```
validate Work Unit
  -> resolve required capabilities
  -> select a runtime that provides all of them
  -> create isolated workspace + worktree
  -> start and prompt the worker
  -> wait, collect runtime evidence
  -> (independently) run deterministic verification
  -> emit an integration result
```

Each stage emits an `ExecutionEvent`, so an execution is reconstructable from its events alone.

## Modules

| Module | Responsibility |
|---|---|
| `src/kernel/json-schema.ts` | Dependency-free validator for the JSON Schema subset used by `schemas/*.json` |
| `src/kernel/work-unit.ts` | Wire-form projection, Work Unit validation, conservative runtime selection |
| `src/kernel/execution.ts` | The orchestrated execution path and `ExecutionRecord` |
| `src/kernel/integration.ts` | `IntegrationResult` and the integration gate |
| `src/adapters/verification/shell.ts` | Deterministic shell verification |

## Invariants

These are enforced in code and covered by tests, not only stated here.

**1. Invalid Work Units never reach a runtime.** Validation runs first; a failure returns
`status: "blocked"` with `failure: "work_unit_invalid"` and no runtime call.

**2. Unmet capabilities block dispatch.** A runtime qualifies only if it declares *every*
required capability. Selection is conservative: a partially capable runtime is never used, and a
Work Unit is never silently downgraded. A runtime that cannot report its capabilities is treated
as providing none.

**3. Runtime failure does not erase factory state.** Every failure path still returns the events
observed so far, so an interrupted execution stays inspectable.

**4. Runtime completion is not verification success.** `ExecutionRecord.status: "completed"` means
the *runtime finished*. It says nothing about correctness. `runtimeStatus` and `runtimeEvidence`
are operational evidence only.

**5. Verification is structurally independent.** `runShellVerification` accepts no execution
record, no runtime status and no agent state. It cannot consult runtime completion even if a caller
wanted it to, because nothing in its inputs carries that information.

**6. Integration readiness requires independent passing verification.**
`buildIntegrationResult` reaches `state: "ready"` only when `verification.status === "passed"`.
Execution state is recorded for traceability but never decides the outcome.

## Determinism

`executeWorkUnit` and `runShellVerification` accept injected `id()` and `now()` functions, so event
sequences and timestamps are exactly assertable in tests. `json-schema.ts` performs no I/O.
Shell verification is the only adapter that executes anything, and it is driven through an
injectable `ShellRunner`.

## Known limitations

- The schema validator covers only the keywords `schemas/*.json` actually use. It is not a
  conforming JSON Schema implementation and should be revisited if the schemas grow.
- CI validates that each schema file is well-formed and that at least five exist. It does not
  validate instances against the schemas; this slice adds instance validation for Work Units but
  does not yet change CI.
- `IntegrationResult` is recorded but nothing publishes it. PR linkage, merge and the bounded repair
  loop are later Work Units.
- Worktree isolation is demonstrated through the `WorkerRuntime` boundary. The kernel does not
  itself create Git worktrees, and a worktree is not a security boundary.

## Boundary

This slice introduces no scheduler, no Linear or Hermes adapter, no database, no hosted control
plane, and no autonomous merge or release. Provider-specific behaviour remains inside adapters, and
`WorkUnit` gained no provider-specific fields.