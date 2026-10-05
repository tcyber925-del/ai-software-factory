# Execution Slice

## Purpose

This documents the execution slice (FCT-006): the path from an
approved Work Unit to an explicit integration record, using only the existing
provider-neutral protocols and `WorkerRuntime`.

`executeWorkUnit` itself is a kernel, not a scheduler. Nothing here decides *which* Work Unit runs
next, and nothing here can mark work correct. Ordering is the scheduler's job
([docs/scheduling.md](scheduling.md)); the composition that sequences the two is the pipeline
([docs/cli.md](cli.md)).

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

The composition that runs these in sequence, plus repair and event persistence, is
`src/kernel/pipeline.ts`. See [docs/cli.md](cli.md).

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

**7. Verification runs against the executed worktree.** When composed, the pipeline points the
checks at the tree the runtime produced, not the factory's checkout; a runtime that reports no
worktree blocks rather than falling back. See [docs/cli.md](cli.md).

## Determinism

`executeWorkUnit` and `runShellVerification` accept injected `id()` and `now()` functions, so event
sequences and timestamps are exactly assertable in tests. `json-schema.ts` performs no I/O.
Shell verification is the only adapter that executes anything, and it is driven through an
injectable `ShellRunner`.

## Known limitations

- The schema validator covers only the keywords `schemas/*.json` actually use. It is not a
  conforming JSON Schema implementation and should be revisited if the schemas grow.
- CI validates that each schema file is well-formed, names `$schema`/`title`/`type: object`, and
  rejects unknown fields. It does **not** validate instances against the schemas; instance
  validation is exercised by tests through the in-repo validator.
- The kernel records `IntegrationResult` but does not itself open a pull request. It records the
  decision; a human or a separate integration step acts on it.
- Worktree isolation is demonstrated through the `WorkerRuntime` boundary. The kernel does not
  itself create Git worktrees, and a worktree is not a security boundary.

## Composition

Everything above existed before FCT-016 and none of it ran in sequence. `src/kernel/pipeline.ts`
composes scheduling, execution, independent verification, bounded repair, and the integration
record, and the invariants above are enforced there as well as here. See
[docs/cli.md](cli.md).

## Boundary

The execution slice itself introduces no scheduler, no adapter, no database, and no hosted control
plane. Adapters and the scheduler were added by later units and remain provider-neutral;
`WorkUnit` gained no provider-specific fields. No autonomous merge or release exists anywhere in
the factory.