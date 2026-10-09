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

## Behind the provider-neutral intake boundary

`src/kernel/intake.ts` defines the contract every task provider implements. This adapter is its
first consumer: `linearIntakeAdapter` in `src/adapters/linear/intake.ts` is a
`ProviderIntakeAdapter<LinearIssue, LinearIntakePolicy>`.

It is a **binding, not a second implementation**. `evaluate` delegates to `evaluateEligibility` and
`compile` delegates to `compileWorkUnit`, so every rule above is reached exactly as it was written
and none can be softened by being re-expressed for the boundary. A test asserts the two paths
produce the identical Work Unit, which is what keeps them from drifting apart. The only new logic is
`LINEAR_REFUSAL_CLASSIFICATIONS`, a `Record<RefusalReason, IntakeRefusalClassification>` mapping each
Linear reason onto the boundary's coarse vocabulary — `not_dispatchable`, `not_allowlisted`,
`policy_blocked`, `dependency_incomplete`, `dependency_unresolved`, `requirements_undeclared`,
`target_undeclared`. Because the record type is exhaustive, adding a refusal reason to this adapter
fails `npm run build` until it is classified, rather than degrading to a silent default.

Summarising loses nothing: the Linear reason code travels alongside as `providerReason`, `check`
names which check decided, and `detail` reaches the operator intact. Linear identity — provider,
issue id, url — lands on `result.source`, beside the Work Unit. The compiled unit carries exactly the
protocol's own fields, so nothing provider-specific is portable-blocked into `work-unit.schema.json`.

## Intake produces a plan; it does not dispatch

`buildLinearIntakePlan({ issues, policy, extras })` in `src/adapters/linear/plan.ts` runs a set of
issues through the boundary and returns `{ units, refusals }`.

`units` is a plan file, in the shape `readWorkUnitFile` in `src/cli/args.ts` already parses:

```json
[{ "workUnit": { "id": "ENG-902", "goal": "…", "repository": "acme/widgets" } }]
```

Each entry is `{ workUnit, dependsOn?, paths?, contracts?, runtimes?, protectedResources?, risk? }`.
A test writes the output to disk and reads it back through that real reader, so if the plan shape ever
drifts from what `factory work run --work-units` accepts, the read throws rather than the plan
quietly becoming unusable.

`refusals` holds what was *not* planned, each naming the issue and why. Refused issues never appear
as units: a refusal is about a provider record, and a refused record never became a Work Unit to
plan. Having both lists is the point — an operator does not re-run intake to discover what was
excluded.

Three properties are structural rather than promised:

- **It cannot dispatch.** This module returns a document. There is no runtime, worktree or call into
  `runPipeline` on this path, so composing intake cannot start work.
- **No scheduling structure is inferred.** `blockedBy` gated eligibility, but an accepted issue's
  blockers are finished by definition — turning that relation into a plan `dependsOn` would ask the
  scheduler for work already done. `dependsOn`, `paths`, `contracts` and `risk` are whatever the
  caller passed in `extras`, copied verbatim. `risk` especially: it is a control the security gate
  enforces, so inferring it from the goal string would be a guess dressed as a gate.
- **It is reproducible.** Same issues and policy, identical plan, input order, no clock. A plan is a
  document a human approves before work runs, so re-running intake must not rewrite what was agreed.

## Composed into the CLI as planning

This adapter is reachable: `factory intake --source linear --records <issues.json> --out
<plan.json>` runs issues through the boundary and writes a plan file. That is the whole of
what it does there. No `factory` command emits `integration.status_proposed` or calls
`deriveOutcome` — status reflection stays a library path, because a transition needs a human
acknowledgement the CLI has no business supplying.

`buildLinearIntakePlan` remains the composable seam for a caller that wants the plan in
process rather than on disk, and the `extras` it accepts remain the way to supply `paths`,
`dependsOn`, `contracts` or `risk`. `factory intake` supplies none, because a Linear issue
states no write boundary: a plan it writes has no scope gate, so add `paths` before
running one.

The command does not dispatch, and the composition is visible in the output: the last line
names the separate `factory work run --work-units <plan>` step. That answers the question
FCT-018 deferred — intake writes a plan, and a human runs it — rather than piping straight
into dispatch.

The eligibility allowlist is still empty by default, and the CLI adds no flag around it.
`--eligible-status` and `--eligible-status-name` *set* it; nothing overrides it.

The `scheduler blocked` message the pipeline can print is a different thing entirely:
`runPipeline` reads `planSchedule` decisions, so it is reporting a Work Unit the *scheduler*
blocked — an unsatisfied dependency, a missing capability, a cycle — not an issue Linear
refused.

That distinction is carried in the types rather than left to prose. An `IntakeResult` and an
`IntakePlanRefusal` are identified by `source.provider` + `source.reference` and carry **no**
`workUnitId` field — the key a `SchedulingDecision` uses. Their vocabularies are disjoint
(`accepted`/`refused` against `scheduled`/`blocked`), and every refusal line is rendered by the
kernel's `describeIntakeOutcome`, which prefixes `intake` and names the provider and record. A
consumer therefore cannot report an intake refusal against a Work Unit that does not exist.

`fixtures/linear/` holds recorded payloads so the rules are tested offline. `factory intake`
reads them the same way it reads any records file: a local path, no network call, and no
credential. `buildLinearIntakePlan` plans the identical result in process.

## Boundary

Linear is not replaced, and no product management is automated. No requirement change is ever
inferred, and no issue is dispatched without an explicit human allowlist. The adapter reads and
reports; it does not decide what the work is.