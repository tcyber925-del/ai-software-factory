# Bounded Repair

## Purpose

This documents FCT-012: letting a deterministic verification failure trigger a *bounded* number of
repair attempts, without letting agents self-authorize correctness.

## What the loop deliberately cannot do

**1. Self-authorization is impossible.** A repair attempt is never judged by the worker that performed
it. `verify` is a separately supplied function and is the only input to the success decision. The
`ExecutionRecord` is recorded for traceability and is never consulted for the outcome — a worker
reporting `completed` with failing checks stays failing.

**2. Scope cannot expand.** The repair context restates the Work Unit's goal, acceptance criteria and
scope verbatim, and adds only what failed. Repair narrows toward a failing check; it never
re-specifies the work. The prompt explicitly forbids changing requirements or architecture, and
forbids modifying tests to make them pass.

**3. Retries are finite.** `maxAttempts` is enforced inside the loop, not by the caller, so no worker
can request another attempt. Default is **2**, matching `AGENTS.md`. A limit of `0` means no repair
is attempted and the failure escalates immediately.

## Flow

```
initial verification
  -> passed?  return verified, no repair
  -> for attempt in 1..maxAttempts:
       build bounded repair context from the failing checks
       emit repair.started
       execute repair
       verify independently        <-- the only success input
       passed? emit repair.succeeded, return verified
       else   emit repair.failed, continue
  -> emit repair.escalated, return escalated
```

The loop stops as soon as a repair verifies, so a first-attempt success never burns the remaining
budget.

## What repair is *not* for

Repair fixes failing checks against **completed** work. It is not a retry mechanism.

When the runtime never completed — timed out, failed to start, could not be reached — the failed
check is a *symptom* of that, not a cause. Re-issuing the same prompt to the same runtime
re-encounters the same fault, at the cost of a full prompt ceiling per attempt. A timing-out runtime
was measured dispatching **three** times and creating **three** worktrees before escalating: the
entire repair budget spent on an outcome that was knowable after the first attempt.

So the pipeline runs verification either way — partial work may have landed, and that evidence is
worth keeping — but enters the repair loop only when `execution.status === "completed"`. A skipped
repair is recorded as `repair_not_attempted_runtime_<failure>` rather than silently omitted.

The blocking reason names the runtime failure (`execution_timeout`) rather than `verification_failed`,
because the runtime failure is the cause and a failed check is the consequence. Sending an operator to
their test suite when the runtime never ran is the wrong door.

**What this does not add:** retry with backoff for transient failures. A binary that reappears, or a
provider that recovers, might genuinely succeed on a second attempt — but that needs evidence about
which failures are actually transient, which V1 does not have. Guessing would trade a known cost for
an unknown one.

## Escalation

Reaching the limit does not mean the work succeeded. The result is `status: "escalated"` with
`reason: repair_limit_reached_after_N_attempts`, carrying the last failing check names. Escalation is
a stop for human intervention, not a soft pass.

## Traceability

Every attempt emits `repair.started`, then `repair.failed` or `repair.succeeded`, and a final
`repair.escalated` if the limit is hit. All are `source: "factory"` events, so repair attempts are
durable and auditable via `reconstructExecution` from FCT-011.

Repair runs are correlated with `runId` and linked to the run that triggered them via `parentRunId`,
so an escalation can be traced back to the original execution.

## Dependency injection

`execute` and `verify` are both supplied by the caller. The loop embeds no runtime and no verification
implementation, so it cannot accidentally verify itself, and it is testable without any agent present.

In the composed pipeline, `verify` re-runs the checks against the worktree the repair attempt
produced, so a repair that never touched the work cannot pass by pointing at an unchanged tree. See
[cli.md](cli.md).

## Boundary

No unbounded self-healing, no autonomous architecture change, no autonomous merge or release. The
loop retries inside an unchanged Work Unit and escalates rather than widening what it is allowed to
attempt.