# Scheduling

## Purpose

This documents FCT-007: deciding *when* and *in what grouping* Work Units may run, conservatively.

The scheduler decides only ordering and grouping. It never decides that work is correct, and it
cannot: `SchedulePlan` has no field capable of expressing verification or integration state. That
is the structural reason the scheduler cannot bypass the integration gate — not a convention that
could be forgotten.

## Conservative by construction

| Rule | Effect |
|---|---|
| A unit runs only after every dependency completed | Dependency-blocked work is never dispatched |
| Two units share a batch only when no conflict is detected | Known conflicts serialize |
| A unit that does not declare its touched surface is treated as `uncertain` | Uncertainty serializes against everything |
| An unresolved conflict round with an empty batch blocks rather than loops | The plan always terminates |

When in doubt, the scheduler serializes. The bias is deliberately toward slower, safer execution
rather than faster, riskier concurrency.

## Conflict reasons

`detectConflict` returns the first matching reason in a fixed precedence, so decisions are
deterministic:

1. `dependency` — one declares the other as a prerequisite
2. `overlapping_paths` — shared or directory-prefixed paths
3. `shared_contract` — shared API/schema identifiers
4. `runtime_assumption` — shared runtime assumptions
5. `protected_resource` — shared exclusive resources
6. `uncertain` — either unit did not declare what it touches

Path comparison normalizes prefixes rather than using substring matching, so `src/kernel`
correctly conflicts with `src/kernel/execution.ts` without also matching an unrelated path that
merely contains that text.

## Blocks, and why each is not a silent stall

| Reason | Meaning |
|---|---|
| `dependency_cycle` | Circular prerequisites; cannot be ordered at all |
| `unsatisfied_dependency` | Depends on a Work Unit that is not scheduled |
| `duplicate_work_unit_id` | Two units share an id, so correlation is ambiguous |
| `missing_capabilities` | No supplied runtime provides a required capability |
| `unresolvable_conflict` | No safe grouping exists for the remaining units |

## Capability matching and known-unknown capacity

Capability blocking requires a runtime inventory. Two states are deliberately distinct:

- **No `runtimes` supplied** → the scheduler is doing ordering and conflict analysis only, and
  does **not** invent a "missing capability" verdict from an unknown fleet.
- **An empty `runtimes` array supplied** → a known fleet with no capacity, so work is blocked.

Collapsing these would either stall all work on a pure ordering call, or dispatch work the caller
knows cannot run. A runtime that fails to report capabilities provides none, so an unreachable
worker cannot be treated as available capacity.

## Output

`SchedulePlan` contains `batches` (each may run concurrently, batches run in order), `decisions`
(exactly one per unit, scheduled with a batch index or blocked with a reason), `conflicts` in the
existing `Conflict` protocol shape, and any `cycles`.

Decisions are also emitted as `scheduling.planned`, `scheduling.scheduled`, and
`scheduling.blocked` **factory** events, so scheduling decisions are auditable and durable.
Scheduling never emits runtime or verification events.

## Composition

`planSchedule` is used standalone by the scheduler's own tests, and is also the first stage of
`runPipeline`, which honours its batches: units in a batch may run together, batches run in order,
and a blocked integration halts dependent batches. See [cli.md](cli.md).

## Boundary

This is a local, single-process planner. No distributed scheduler, hosted control plane, ML
scheduling, or automatic production deployment. It plans; it does not execute, verify, merge, or
release. Concurrency here means "these may run together", and each unit still gets its own isolated
worktree through the existing execution slice.