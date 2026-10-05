# Linear Intake and Status Adapter

## Purpose

This documents FCT-008: connecting the factory to Linear as an execution system, without making
Linear the factory protocol.

Linear is where work is *tracked*. It is not where the factory's contracts live. Nothing in this
adapter changes `src/protocol.ts`; `WorkUnit` remains provider-neutral.

## Two governing constraints

### Only explicitly eligible work dispatches

> never start arbitrary Backlog work

Workspace realities shaped this design. **This Linear workspace has no "Ready" status at all** — its
statuses are Triage, Backlog, Todo, In Progress, In Review, Done, Canceled, Duplicate (recorded in
`fixtures/linear/statuses.json`). Eligibility therefore cannot be inferred from a status *name* that
may not exist.

Instead:

- `HARD_EXCLUDED_STATUS_TYPES` — `backlog`, `triage`, `duplicate`, `canceled`, `completed` — can
  **never** be dispatched, and configuration cannot override it. A config mistake must not turn
  Backlog into a dispatch queue.
- `eligibleStatusTypes` / `eligibleStatusNames` default to **empty**. Nothing dispatches until a human
  allowlists a status.

Checks run in a fixed order (hard exclusion → terminal state → labels → status allowlist →
dependencies → requirements), so two runs over the same issue produce the same refusal and an intake
decision is auditable rather than a coin flip.

### No product or architecture decision is inferred

Where an issue does not state what the factory needs, compilation **refuses** and names what is
missing. It never guesses, because a guessed acceptance criterion becomes an unverifiable claim
attached to someone's name.

An eligible issue must carry an explicit block:

```
<!-- factory:start -->
- capability: coding
- acceptance: Duplicate slugs fail the build.
<!-- factory:end -->
```

An explicit block is required rather than parsing prose. A test uses a real issue whose description
says *"the site should be faster and the tests should pass"* and asserts the factory refuses it.

**The repository is required input, not an inference.** Linear carries no repository field, and
`work-unit.schema.json` requires a non-empty `repository` — so a missing repository is a refusal
(`missing_repository`), not a guess. This was a real bug the schema test caught: the first
implementation emitted `repository: ""`, which is invalid against the factory's own contract.

## Dependencies gate dispatch

`blockedBy` relations are resolved against issues the caller supplies. An incomplete blocker refuses;
so does a blocker that cannot be resolved at all, because proceeding would risk working on something
already superseded.

## Determinism and identity

Compilation has no clock and no randomness: the same issue and configuration always produce an
identical Work Unit.

The Linear identifier **is** the Work Unit id — `ENG-902` in, `ENG-902` out — so identity survives
into commits and PR evidence without a lookup table that could drift. `repository` is the only field
a caller supplies, and `autonomy` defaults to `review`, so intake can never self-authorize a merge.

A test compiles an issue and validates the result against `work-unit.schema.json` through the
factory's own validator, proving the adapter's output satisfies the factory's contract.

## Status reflection is a proposal, not a decision

`deriveOutcome` maps recorded evidence to a Linear outcome:

| Evidence | Outcome |
|---|---|
| Execution blocked | `blocked` |
| Execution failed | `failed` |
| Runtime finished, no verification | `in_progress` — *runtime completion is not correctness* |
| Verification failed | `in_progress` — not integration-ready |
| Verification passed **and** integration gate ready | `ready_for_review` / `done` |
| Gate blocked | `in_progress` |

`done` additionally requires human acknowledgement (`requiresHumanAcknowledgement`), so a machine
reading this module cannot complete an issue unattended. Every transition carries a reason and its
evidence, and is emitted as a **factory** event (`integration.status_proposed`) so it is never
confused with runtime output.

## Fixtures

`fixtures/linear/` holds payloads recorded from the live workspace plus explicitly-marked synthetic
cases. Tests run offline and reproducibly, and **CI needs no Linear credentials** — which is the
point: a gate that depends on a developer's local auth is not deterministic.

Every synthetic entry carries a `note` and `shape: "synthetic"` so a fabricated payload can never be
mistaken for a recorded one. Two fixtures exist specifically to stop this module's rules looking
covered when they are not:

- **ENG-900** — Backlog **with** full requirements declared, proving the exclusion is the status, not
  the missing block.
- **ENG-905** — eligible status with a blocking label, proving labels are honoured.

## Boundary

Linear is not replaced, and no product management is automated. No requirement change is ever
inferred, and no issue is dispatched without an explicit human allowlist. The adapter reads and
reports; it does not decide what the work is.