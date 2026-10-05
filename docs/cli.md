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
factory verify
factory doctor
```

| Flag | Meaning |
| --- | --- |
| `--work-units <path>` | A plan: JSON array of `{ workUnit, dependsOn?, paths?, contracts?, runtimes?, protectedResources? }` |
| `--runtime <name>` | Restrict dispatch to one runtime. An unknown name is an error, never a silent substitution |
| `--max-parallel <n>` | Bound concurrency inside one batch |
| `--verify-in <where>` | `worktree` (default) or `repo` — see below |
| `--json` | Machine-readable output |
| `--debug` | Include a stack trace on failure |
| `--help` | Usage |

Exit code is `0` only when the run reached `ready`. A blocked run, an unknown
command, a missing file, and a bare `factory` all exit `1`.

## The pipeline

```
validate → plan → select runtime → dispatch → verify (independent)
        → repair if verification failed, bounded → integration record
```

Two invariants are enforced in `src/kernel/pipeline.ts` rather than documented and
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

If a runtime reports no worktree, the run **blocks**. It does not fall back to the
checkout. `tests/pipeline.test.ts` covers both, and replacing the target with
`cwd` fails two tests.

`--verify-in repo` is the explicit opt-out, for the case where the factory is
verifying its own checkout.

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
sixteen units, and a CLI framework is not worth breaking that for.

## Build

| Script | Purpose |
| --- | --- |
| `npm run build` | `tsc --noEmit` — typecheck only |
| `npm run build:cli` | `tsc -p tsconfig.build.json` — emit `dist/` for the `bin` |
| `npm run verify` | build, build:cli, test |

The repository typechecks with `noEmit`, so a runnable CLI needs a real emit
target. `tsconfig.build.json` provides one for `src/` and excludes `tests/`.
`dist/` is gitignored.