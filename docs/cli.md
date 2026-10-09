# The `factory` CLI

`factory` is the composition layer: the command that runs the verified units in
sequence. Before it existed, every part of the factory worked and nothing ran them
together.

## Why this needed building

FCT-002 through FCT-015 were implemented independently, each with its own tests,
each merged green. `planSchedule → executeWorkUnit → runShellVerification →
buildIntegrationResult` had never been called in sequence anywhere in `src/`.

Per-unit green is not evidence that a sequence is correct. The same class of
defect was found during the FCT-010 dogfood review: a false-green verification
gate that fourteen unit tests could not see. Composition bugs are only visible by
running the sequence.

## Commands

```
factory work run       --work-units <plan.json> [--runtime <name>]
factory work validate  --work-units <plan.json>
factory intake         --source <linear|github> --records <issues.json> --out <plan.json>
factory verify
factory doctor
```

| Flag | Meaning |
| --- | --- |
| `--work-units <path>` | A plan: JSON array of `{ workUnit, dependsOn?, paths?, contracts?, runtimes?, protectedResources? }` |
| `--runtime <name>` | Restrict dispatch to one runtime. An unknown name is an error, never a silent substitution |
| `--max-parallel <n>` | Bound concurrency inside one batch |
| `--no-strict-scope` | Report out-of-scope changes without blocking integration |
| `--prompt-timeout-ms <n>` | Ceiling on one agent prompt (default 900000) |
| `--verify-in <where>` | `worktree` (default) or `repo` — see below |
| `--json` | Machine-readable output |
| `--debug` | Include a stack trace on failure |
| `--help` | Usage |
| `--source <name>` | Provider to intake from: `linear` or `github` |
| `--records <path>` | Provider records: a JSON array, or `{ "issues": [...] }` |
| `--out <path>` | Where to write the plan `work run --work-units` reads |
| `--repository <name>` | Target repository for compiled work. Never inferred |
| `--eligible-status <list>` | Linear: status types cleared for dispatch. **Default: none** |
| `--eligible-status-name <list>` | Linear: status names cleared for dispatch. **Default: none** |
| `--eligible-label <list>` | GitHub: labels cleared for dispatch. **Default: none** |
| `--blocking-label <list>` | Refuse records carrying these labels |

Exit code is `0` only when the run reached `ready`. A blocked run, an unknown
command, a missing file, and a bare `factory` all exit `1`.

`factory intake` is the one exception to that sentence, and deliberately: it exits `0`
when it wrote a plan, **even if every record was refused**, because a refusal is a
reportable outcome rather than a failure of the command. Refusals are printed, one per
record, each naming its provider, its record and the reason. A mistake in the
invocation — an unknown `--source`, a missing `--records`, a provider-specific flag
handed to the wrong provider — exits `1` with one line naming it, and writes no plan
file at all. A command that shrugged and wrote an empty plan would report "no work
found" for a typo in a path.

## `factory intake` compiles, it does not run

```
$ factory intake --source github --records fixtures/github/issues.json --out plan.json \
    --repository acme/widgets --eligible-label factory:eligible
intake: github — 2 accepted, 8 refused (10 record(s))
plan written: plan.json
intake accepted acme/widgets#900 (github)
intake accepted acme/widgets#904 (github)
intake refused owner/repository#60 (github): not_allowlisted ...
intake refused acme/widgets#901 (github): not_allowlisted eligibility_label_not_allowlisted ...
...
nothing was dispatched; review the plan, then run: factory work run --work-units plan.json
```

The provider decides which adapter runs and whose policy applies; **nothing else**.
There is no `linear run` and no `github run`, so execution stays the single
`factory work run` boundary and a second provider cannot arrive with its own execution
path. Both providers emit the same plan format described under
[The work-unit file](#the-work-unit-file) — entries of `{ workUnit, … }` — so nothing
downstream had to change to consume what either of them writes.

**The eligibility allowlist still defaults to empty**, and this command adds no flag
that bypasses it. `--eligible-status`, `--eligible-status-name` and `--eligible-label`
*set* the allowlist, which is the human decision the safety property is made of;
`--blocking-label` adds refusals. There is deliberately no way to say "dispatch
whatever is open" — see [linear-adapter.md](linear-adapter.md) for why an empty
allowlist is the property and not an oversight.

`--repository` is required input, not an inference. Leave it out and every record is
refused as `target_undeclared`, naming what is missing, rather than the factory
guessing which codebase the work is against.

### Intake refusal is not scheduler refusal

`intake refused … (github): not_allowlisted` and `scheduler blocked 1 work unit(s)`
are different reports about different subjects: a provider record that may never become
a Work Unit, against a Work Unit that already exists and was blocked on a dependency or
a capability. Every refusal line is rendered by the kernel's own
`describeIntakeOutcome`, which prefixes `intake` and names the provider and record —
the prefix exists because `work run` once printed "intake refused" while reading
`planSchedule` decisions, which made an unsatisfied dependency and a refused issue
indistinguishable.

### Where provenance lives

Each shipped adapter compiles the provider's **own reference** as the Work Unit id —
`ENG-902` for a Linear issue, `acme/widgets#900` for a GitHub one — so a reader holding
a plan entry can find the record it came from without a lookup table that could drift.
No provider field goes *into* the Work Unit: `work-unit.schema.json` sets
`additionalProperties: false`, and a test asserts each compiled unit carries exactly the
protocol's own fields.

Refusals carry the full `IntakeSource` — provider, reference and deep link — which is
what `--json` emits:

```
$ factory intake … --json
{ "source": "github", "records": 10, "plan": "plan.json", "dispatched": false,
  "units": [ { "id": "acme/widgets#900", "provider": "github" } ],
  "refusals": [ { "outcome": "refused", "source": { "provider": "github", … },
                  "refusal": { "classification": "not_allowlisted", … },
                  "message": "intake refused acme/widgets#901 (github): …" } ] }
```

`dispatched: false` is a stated field rather than an inference from the absence of a
pipeline call, because a caller wiring this into automation needs something to assert
on.

### Records come from a file

`--records` reads a file. There is no live provider fetch, no credential, and no
environment variable on this path — the command opens no socket and a test asserts its
source never mentions `process.env`. That is why CI needs no provider auth, and it is
the honest reading of "live access, if it ever exists, is explicit opt-in": the offline
fixtures already cover the accepted path and every refused one.

### `factory verify` is currently non-functional

`factory verify` shells out to `npm run` for `format:check`, `lint`, `typecheck`,
`test`, and `build`, in that order, stopping at the first failure. This repository
defines only `build`, `build:cli`, `factory`, `test`, and `verify` — so
`format:check` is missing and the command exits `1` before doing any work.

```
$ node dist/bin.js verify
fail  npm run format:check
$ echo $?
1
```

There is no formatter, linter, or separate `typecheck` script in this repository;
`npm run build` is the typecheck. `npm run verify` is the working equivalent. The
gap is recorded rather than papered over by adding empty scripts that would report
a green run without checking anything.

The command is kept because it is the intended shape — a project-level verification
entry point that an adopting repository fills in with its own `format:check`,
`lint`, and `typecheck`. `docs/adoption.md` says which scripts an adopter must add.

## The pipeline

```
validate → security gate → plan → select runtime → dispatch → verify (independent)
        → repair if verification failed and the runtime actually ran, bounded
        → scope check: did it stay inside its declared `paths`?
        → integration record
```

Three invariants are enforced in `src/kernel/pipeline.ts` rather than documented and
hoped for.

### 1. Readiness comes only from independent verification

`buildIntegrationResult` consumes a `VerificationResult`. Nothing in the pipeline
derives readiness from runtime status. `status: "completed"` means the runtime
finished, which is evidence that something ran — not that the Work Unit is correct.

A test asserts this directly: with the runtime green and the checks red, the
outcome is `blocked`. Weakening the implementation to fake a passing verification
fails five tests.

### 2. Verification runs against the executed worktree

The default `--verify-in worktree` points the checks at the tree the runtime
actually produced, not at the factory's checkout. Verifying the checkout would let
a runtime write anywhere and still pass, because the checks would never look at the
work.

**That tree has to still exist when the checks run.** Cleanup therefore belongs to
the pipeline, after verification and repair, not to `executeWorkUnit`. Found by
dogfooding, and worth stating plainly because the unit tests could not see it:
`executeWorkUnit` cleaned up in a `finally`, so every check ran against an
already-deleted directory and failed for reasons unrelated to the work. A fake
runtime returns a fictional path and cannot observe a directory disappearing.

If a runtime reports no worktree, the run **blocks**. It does not fall back to the
checkout. `tests/pipeline.test.ts` covers both, and replacing the target with
`cwd` fails two tests.

`--verify-in repo` is the explicit opt-out, for the case where the factory is
verifying its own checkout.

### 3. Scope is a write boundary

After verification passes and before the integration gate, the pipeline reads the
worktree's diff and compares it against the Work Unit's declared `paths`. A change
outside it is recorded as a durable `scope.violation` event naming every file, and
by default prevents `ready`.

`paths` used to feed conflict detection and nothing else, so an agent could edit
anything and still reach `ready`. Dogfooding found it writing outside its
declaration, including to `package-lock.json`.

Path matching is **shared with the scheduler**. Two notions of "these paths are
related" that disagreed would let work serialize for a conflict it never had, or
pass a boundary it crossed.

This is an audit and a gate, **not a sandbox** — see the scope table above for the
three outcomes and when no gate applies at all.

### What the pipeline does not compose

Two shipped capabilities are composed **as planning, before the pipeline**, and are
still not on its dispatch path. `factory intake` compiles records into a plan file; it
calls no part of the pipeline and dispatches nothing.

| Capability | Module | Who applies it |
| --- | --- | --- |
| Linear and GitHub intake | `src/adapters/linear/`, `src/adapters/github/` | `factory intake`, which writes a plan. Running it is a separate `factory work run`. It declares no `paths`, so such a plan gets no scope gate |
| Linear status reflection | `src/adapters/linear/status.ts` | The caller. No CLI command proposes a status transition |

The security gate **is** composed into dispatch. It runs before dispatch and refuses
`untrusted` and `destructive` work, because no adapter offers the `sandbox`
isolation those classes require. Risk signals are declared on the plan, never
inferred from the goal text — see [security-policy.md](security-policy.md). Intake
infers none either, so an accepted Work Unit still faces the security gate, the
scheduler, independent verification and the integration gate.

**The scope gate is the exception, and a plan from `factory intake` gets none.** Intake
declares no `paths`, so `checkScope` reports `undeclared` and the pipeline's scope
strictness follows an empty `outOfScope` — there is no gate to fail. That is the correct
consequence of refusing to infer a write boundary from an issue's content, but it means
`factory work run --work-units plan.json` alone is **not** the scope-checked run. Add
`paths` to the plan entries before running one; see
[Scope enforcement](#scope-enforcement) for the outcomes.

The scheduler's refusal in the pipeline is a different thing entirely: `runPipeline`
reads `planSchedule` decisions, so it reports a Work Unit the *scheduler* refused — an
unsatisfied dependency or a missing capability — not a record intake refused.

### Schema resolution

The Work Unit schema is resolved relative to the installed factory first
(`src/cli/index.ts` walks up from the module), falling back to the cwd. An adopting
project does not ship the factory's `schemas/`, and `doctor` does not require it,
so a cwd-only lookup would make `doctor` report a healthy environment and then fail
the moment `work validate` ran. Check and action have to agree on where the contract
lives.

## Scope enforcement

A Work Unit's declared `paths` are a **write boundary**, not a hint. After verification passes and
before the integration gate, the pipeline reads the worktree's diff and compares it against the
declaration. A change outside it is recorded as a durable `scope.violation` event naming every file,
and by default prevents `ready` — the reason names the files, because the worktree is cleaned up by
the time an operator looks.

Ordering is deliberate: checks decide whether the work is correct, and only a correct run is worth
asking whether it stayed inside its boundary. A run that is both broken and out of scope reports
both, with the failed checks leading.

Three outcomes, none of them a silent pass:

| Situation | Result |
|---|---|
| Changes within `paths` | `ready` |
| Changes outside `paths` | Blocked, files named. `--no-strict-scope` downgrades to a warning |
| No `paths` declared | No gate; recorded as `undeclared`, never as "in scope" |
| Diff unreadable | The run **fails**. A scope check that degrades to "no changes" is the false green this replaces |

**This is an audit and a gate, not a sandbox.** A determined agent can still do damage inside a
declared path, and it can damage a worktree it is not supposed to reach before the diff is read.

## Scheduling semantics

The scheduler's batches are honoured:

- Units inside a batch were proven conflict-free, so they may run together.
  `maxParallel` bounds how many do at once.
- Batches run in order.
- A blocked integration halts its batch and every batch after it, because later
  units may depend on it. Those units are listed as `not dispatched`.

A parallel group that fails does not retroactively cancel a peer that already
dispatched. That is inherent to concurrency, and the tests assert it rather than
leave it ambiguous.

## Runtimes

`fake` is always available, so a fresh clone can run the CLI with nothing
installed. `opencode`, `herdr`, and `hermes` appear only when their binary is on
`PATH`; a runtime that cannot be constructed is not offered rather than offered and
failing mid-run.

`fake` cannot pass real shell checks, because it creates a fictional worktree
path. That is correct behaviour: it proves the pipeline blocks, not that it works.
To see a `ready` run against real checks, use a runtime that creates a real tree,
or `--verify-in repo` on a repository whose checks you trust.

## The work-unit file

`--work-units` takes a **plan**: a JSON array whose entries wrap a Work Unit with
the scheduling facts the scheduler needs.

```json
[
  {
    "workUnit": {
      "id": "PROJECT-001",
      "goal": "Add a health endpoint",
      "repository": "example/project",
      "capabilities": ["backend", "testing"],
      "acceptance_criteria": ["GET /health returns 200"]
    },
    "paths": ["src/health"],
    "dependsOn": []
  }
]
```

The Work Unit inside is the published wire contract — snake_case, matching
`schemas/work-unit.schema.json` — and is parsed through `workUnitFromWireForm`
rather than cast. A malformed Work Unit must not become a half-populated object
that happens to validate.

| Wrapper field | Meaning |
| --- | --- |
| `paths` | Repository paths this unit may touch; drives conflict detection |
| `dependsOn` | Work Unit ids that must complete first |
| `contracts` | Shared API/schema identifiers it modifies |
| `runtimes` | Runtime identifiers it assumes |
| `protectedResources` | Exclusive resources it needs, e.g. a protected branch |

All wrapper fields are optional. A unit that declares no `paths` is treated as
having uncertain ownership and serialized against everything — see
[scheduling.md](scheduling.md).

`examples/example-plan.json` is a runnable one-unit plan, and
`examples/example-work-unit.json` is the same Work Unit in isolation.

`workUnitFromWireForm` and `workUnitToWireForm` live in the same file on purpose.
The snake_case/camelCase mapping is the thing most likely to drift, and having
both directions together is what makes the round trip checkable.

## No new dependencies

Argument parsing is hand-rolled. The factory has added zero dependencies across
nineteen units, `package-lock.json` has been byte-identical throughout, and a CLI
framework is not worth breaking that for.

## Build

| Script | Purpose |
| --- | --- |
| `npm run build` | `tsc --noEmit` — typecheck only |
| `npm run build:cli` | `tsc -p tsconfig.build.json` — emit `dist/` for the `bin` |
| `npm test` | `vitest run` |
| `npm run verify` | build, build:cli, test |

Note that `npm run verify` and `factory verify` are different things: the first is
the repository's own gate, the second shells out to per-project scripts and does not
currently pass here.

The repository typechecks with `noEmit`, so a runnable CLI needs a real emit
target. `tsconfig.build.json` provides one for `src/` and excludes `tests/`.
`dist/` is gitignored.

## Build output and the trace

`dist/bin.js` is the `bin` target. `.factory/events.jsonl` receives the run trace and
is gitignored, so a clean clone starts with no history — the log is local evidence,
not a committed artifact. `git worktree list` should show only the main checkout
after a run; `work run` cleans up the worktrees it creates, and a leftover one is a
real condition the reader should investigate rather than delete blindly.