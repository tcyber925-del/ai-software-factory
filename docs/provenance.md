# Execution Provenance

## Purpose

This documents FCT-011: making factory executions reconstructable from durable records alone,
without relying on terminal history, and without introducing a database.

A full composed run writes its trace to `.factory/events.jsonl` via the CLI. Every stage —
scheduling, validation, workspace, worktree, worker, verification, repair, integration — appends as
it happens, so an interrupted run stays inspectable rather than becoming a silent gap.

## Storage

`src/state/event-log.ts` provides an append-only log of newline-delimited JSON.

**Append-only is a property of the format, not a convention.** Each record is one line, the file is
only ever opened for append, and there is deliberately no update, delete, or truncate operation.
Line order *is* the sequence, so no counter can drift out of sync with the stored history.

Two implementations share the interface:

| Implementation | Use |
|---|---|
| `JsonlEventLog` | Durable local file; the V1 default |
| `InMemoryEventLog` | Tests, and callers that must not touch the filesystem |

A missing log reads as empty. A corrupt or partially-flushed line is skipped rather than aborting the
read, so one bad record cannot make earlier history unreadable.

## Provenance envelope

Every persisted event carries:

| Field | Purpose |
|---|---|
| `runId` | Correlates all events from one execution attempt |
| `parentRunId` | Links a repair attempt to the run that spawned it |
| `workUnitId` | Groups all runs of a Work Unit |
| `source` | `factory` or `runtime` — see below |
| `seq`, `recordedAt` | Derived from line order and log-assigned time |

`seq` and `recordedAt` are assigned when reading, not trusted from input, so a malformed or forged
sequence cannot be injected.

## Runtime events are not factory state

This is the distinction the log exists to preserve.

Runtime-observed events — an agent starting, a prompt being accepted, a worker reporting it finished
— are stored with `source: "runtime"`. They are operational evidence. Factory events
(`work.validated`, `verification.*`, `integration.*`) are `source: "factory"`.

Reconstruction decides the outcome **only** from factory events. A runtime reporting
`worker.finished` cannot make an execution complete, because a runtime does not own factory state.
No runtime event can be mistaken for verification success or integration readiness.

## Reconstruction

`reconstructExecution(records, workUnitId)` rebuilds an `ExecutionSummary` from the log: outcome,
runtime, revision, worker, workspace/worktree, agent, verification summary, integration outcome, and
per-run status.

Outcomes:

| Outcome | Meaning |
|---|---|
| `completed` | Factory recorded `integration.ready` |
| `failed` | Runtime failure, or integration blocked by a failed check |
| `blocked` | Work Unit rejected or had no capable runtime |
| `interrupted` | Worker started but the run never finished — a crashed process stays visible |
| `in_progress` | Started, no terminal event yet |

`interrupted` is deliberately distinct from `in_progress`: a dead process and a running one look the
same in a log, and conflating them would hide a crash.

## Repair attempt accounting

`countAttempts(records, workUnitId)` counts `verification.started` factory events for a Work Unit.
`runShellVerification` always records an attempt number, defaulting to `1`, so counting is total and
the factory repair limit can be enforced against durable evidence rather than in-memory state.

## Failure containment

Durability failures are surfaced, not swallowed. If the log cannot be written, `executeWorkUnit`
propagates the error rather than continuing as though provenance were being kept. Silently losing
the record would defeat the purpose of the log, so an execution that cannot be recorded is treated
as failed.

## Boundary

No database, hosted control plane, distributed event infrastructure, analytics, or observability
platform. Storage is a local file. The log records what happened; it does not decide whether work is
correct — that remains verification's authority, and integration remains gated on it.

One thing the log deliberately cannot answer: who decided a run succeeded. It records the evidence
chain, and reconstruction derives the outcome from it. A human or the integration gate closes the
loop; see [cli.md](cli.md).