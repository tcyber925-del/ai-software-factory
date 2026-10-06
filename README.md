# AI Software Factory

A provider-neutral, GitHub-native coordination layer for safely dispatching AI engineering work across isolated workspaces and heterogeneous coding-agent runtimes.

## Status

**Runnable, released as [`v0.1.0`](https://github.com/tcyber925-del/ai-software-factory/releases/tag/v0.1.0), and verified end to end on itself**

The factory dispatched one of its own Work Units through `factory work run`: a real agent in a real
worktree, `npm ci` + typecheck + the full suite run *inside that worktree*, independent verification
passed, the integration gate reached, and the worktree cleaned up. Reported `ready`.

`work run` validates Work Units, applies the security gate, plans the schedule, dispatches into
isolated worktrees, verifies independently, repairs within a bound, checks the change stayed inside
its declared scope, and records the integration decision.

Still not implemented, by design: hosted control plane, database, scheduler daemon, web dashboard,
custom agent runtime, and autonomous merge or release. See [Non-goals for V1](#non-goals-for-v1).

**Start with [`docs/using-the-factory.md`](docs/using-the-factory.md)** if you want to run it, or
[`docs/adoption.md`](docs/adoption.md) if you want to adopt it.

### What `work run` composes, and what it does not

Being shipped is not the same as being wired into the run. This split matters more than the
feature list, because a reader who assumes a documented control is active in the pipeline will trust
a gate that is not being applied.

Composed by `factory work run`:

- Work Unit validation and wire-form projection
- Scheduling, batching, conflict detection
- Runtime selection and dispatch into an isolated worktree
- Independent shell verification against the executed worktree
- Bounded repair, then escalation at the limit
- Integration gate and durable event log

Shipped as a library, **not** called by `work run`:

| Capability | Module | Consequence |
|---|---|---|
| Linear intake and status reflection | `src/adapters/linear/` | No CLI command reads Linear; intake is a library call |

`docs/linear-adapter.md` documents the intended behaviour. This table records what the CLI actually
does.

## Core invariant

> The agent that produces an artifact cannot be the sole authority that declares it correct.

Every meaningful Work Unit must pass independent verification before integration.

## Architecture

```
Work Unit
   ↓
Capability requirements
   ↓
Worker Registry
   ↓
Runtime Adapter
   ├── Direct OpenCode
   └── Managed Herdr
   ↓
Isolated Git worktree
   ↓
Implementation
   ↓
Independent verification
   ↓
PR / integration gate
   ↓
Release / observe / learn
```

The factory owns policy, Work Units, scheduling semantics, verification evidence, and integration state. Runtime systems own terminal/session/agent execution.

## Design principles

- Problem before technology.
- Evidence before claims.
- Work Units request **capabilities**, not named agents.
- Runtime state is not factory state.
- Git worktrees provide isolation, not a security sandbox.
- Prefer serialization when conflict safety is uncertain.
- Human approval remains required for consequential changes.
- Keep the factory thin; integrate existing agent runtimes rather than replacing them.
- Provider-specific commands belong in adapters, not Work Units.
- Failed execution must leave durable, reconcilable state.
- Automatic repair is bounded; default maximum is two attempts.

## Running it

```
npm ci
npm run verify                        # typecheck, build the CLI, run the suite
node dist/bin.js doctor               # is this environment ready?
node dist/bin.js work validate --work-units examples/example-plan.json
node dist/bin.js work run      --work-units examples/example-plan.json
```

Against the shipped `examples/example-plan.json`, `work run` reports
`blocked — repair limit reached for PROJECT-001` and exits `1`. That is correct, not a failure: the
`fake` runtime creates a fictional worktree path, so `npm test` cannot run there, verification fails
twice, and the repair loop escalates. The run demonstrates that the gate blocks. To see a `ready`
run, use a runtime that creates a real tree, or `--verify-in repo`. See [docs/cli.md](docs/cli.md).

`factory verify` runs this repository's own `verify` script, so `node dist/bin.js verify` and
`npm run verify` are equivalent here. A project that declares none of `verify`,
`format:check`, `lint`, `typecheck`, `test`, or `build` gets a **failure**, not a vacuous pass —
nothing verified must never be reported as verification passed.

## `work run`, end to end

```
validate → security gate → plan → select runtime → dispatch into a worktree
        → independent verification (against the executed worktree)
        → bounded repair, only if the runtime actually ran
        → scope check: did it stay inside its declared `paths`?
        → integration record → durable event log → worktree cleaned up
```

Three invariants are enforced in code rather than documented and hoped for:

1. **Readiness comes only from independent verification.** Nothing derives readiness from runtime
   status.
2. **Verification runs against the executed worktree**, not your checkout — and that worktree still
   exists when the checks run.
3. **Scope is a write boundary.** A change outside the declared `paths` prevents `ready`.

Exit `0` only when every Work Unit reached `ready`. See [docs/cli.md](docs/cli.md).

## The vertical slice

Shipped and verified. `FCT-001` through `FCT-025` with gaps at `017`–`020` and `022`, then the
units that closed the gaps dogfooding found. The count is left to the table — a figure in prose
goes stale the moment a row is added:

| # | Shipped | Evidence |
|---|---|---|
| 1 | Protocol types and schemas | `src/protocol.ts`, 8 files under `schemas/` |
| 2 | A fake runtime for deterministic tests | `src/fake-runtime.ts` |
| 3 | Direct OpenCode, Herdr, and Hermes runtime adapters | `src/adapters/opencode`, `src/adapters/herdr`, `src/adapters/hermes` |
| 4 | Work Unit execution in an isolated worktree | `src/kernel/execution.ts` |
| 5 | Independent verification with a bounded repair loop | `src/adapters/verification/shell.ts`, `src/kernel/repair.ts` |
| 6 | The integration gate and a traceable record | `src/kernel/integration.ts` — records the decision; no SCM adapter opens the PR |
| 7 | Failure, reconciliation, and conflict behaviour | `src/kernel/scheduler.ts`, `src/state/provenance.ts` |
| 8 | Durable event provenance | `src/state/event-log.ts` |
| 9 | A scheduler and a runtime-agnostic pipeline | `src/kernel/scheduler.ts`, `src/kernel/pipeline.ts` |
| 10 | Security classification and an isolation gate | `src/security/` — **composed**, evaluated before dispatch |
| 11 | A `factory doctor` environment check | `src/doctor/` |
| 12 | A runnable CLI composing the execution path | `src/kernel/pipeline.ts`, `src/cli/`, `src/bin.ts` |
| 13 | Linear intake and status reflection | `src/adapters/linear/` — library only, no CLI command |
| 14 | A portable skill pack | `.agents/skills/` — 9 factory skills, 2 runtime skills |
| 15 | Template packaging and an adoption path | `templates/`, `docs/adoption.md` |
| 16 | MIT licensing and repository hygiene | `LICENSE`, `docs/licensing.md` |
| 17 | Dogfooded on a real external repository | `FCT-010`; a false-green verification gate was found and fixed there |
| 18 | Scope-safe test discovery | `vitest.config.ts` — excludes `.worktrees/` and `.tmp-test/` |
| 19 | Factory-relative Work Unit schema resolution | `src/cli/index.ts` — the schema resolves from the installed factory, not the cwd |
| 20 | Bounded runtime calls | `src/adapters/opencode/process.ts` — a prompt is capped at 900s, every other subprocess at 120s |
| 21 | Subprocess output to a file, never a pipe | A runtime agent deadlocks on a pipe; `defaultCommandRunner` redirects to files |
| 22 | Worktree survives until verification reads it | Cleanup belongs to the pipeline, not to `executeWorkUnit` |
| 23 | Repair skipped when the runtime never ran | Repair fixes failing checks against completed work; it is not a retry mechanism |
| 24 | Scope enforcement | `src/kernel/scope.ts`, `src/adapters/git/changes.ts` — `paths` is a write boundary |
| 25 | Adoption payload separated from the tool | `docs/adoption.md`, `templates/project/README.md` |
| 26 | `v0.1.0` released | Adopters can pin a version instead of cloning whatever is on `main` |

Work Unit numbering is not contiguous: `FCT-014` was merged from a branch named
`FCT-021-security-hardening`, and `FCT-017`–`FCT-020` and `FCT-022` were never issued. GitHub issue
and PR titles use the `FCT-0xx` prefix. Released as [`v0.1.0`](https://github.com/tcyber925-del/ai-software-factory/releases/tag/v0.1.0).

## Non-goals for V1

- Hosted SaaS control plane
- Custom database
- Custom agent runtime
- Agent marketplace
- Autonomous production deployment
- Universal web dashboard
- Replacement for OpenCode, Codex, Claude Code, Hermes, or Herdr
- Proprietary skill format

## Repository structure

```
.
├── .agents/skills/       # Portable Agent Skills
├── LICENSE               # MIT (see docs/licensing.md)
├── .factory/             # Factory policies and workflow conventions
├── .github/workflows/    # Deterministic CI gates
├── docs/                 # Durable architecture and protocol documentation
├── schemas/              # Machine-readable protocol contracts
├── src/                  # Factory implementation
│   ├── kernel/           # Protocol logic: validation, execution, scheduling, repair, pipeline
│   ├── adapters/         # Runtime and verification adapters
│   ├── state/            # Durable event log and provenance
│   ├── security/         # Risk classification and the isolation gate
│   ├── doctor/           # Environment diagnostics
│   ├── cli/              # Command dispatch and argument parsing
│   └── bin.ts            # `factory` entry point
├── examples/             # Example Work Units and a runnable plan
├── fixtures/             # Recorded and synthetic payloads for offline tests
├── tests/                # Deterministic and integration tests
├── templates/            # Reusable project/skill templates
└── AGENTS.md             # The agent contract every agent must follow
```

## Verification

`npm run verify` runs `tsc --noEmit`, emits the CLI to `dist/`, and runs Vitest. Current baseline:
`npm run verify` runs typecheck, the CLI emit, and the whole suite. Its output is the
source of truth for the test count — deliberately not written here, because a number in
prose is wrong the moment a test is added.

Test discovery is scoped to `tests/**/*.test.ts` in `vitest.config.ts`. This is deliberate: Vitest's
default glob collects tests from `.worktrees/`, so a stale worktree inflates the reported count.
That is not cosmetic — an inflated count is indistinguishable from real coverage, and it hides the
fact that a worktree was left behind.

The run trace lives at `.factory/events.jsonl`, which is gitignored. It is local evidence, not a
committed artifact; a clean clone starts with no trace.

## Documentation

| Document | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Ownership boundaries, provider neutrality, isolation |
| [docs/using-the-factory.md](docs/using-the-factory.md) | **Start here** — adoption and day-to-day use, greenfield and brownfield |
| [docs/cli.md](docs/cli.md) | The runnable pipeline and its two enforced invariants |
| [docs/protocols.md](docs/protocols.md) | Work Unit, Worker, Capability, and the protocol shapes |
| [docs/schemas.md](docs/schemas.md) | The machine-readable contracts and their TypeScript correspondence |
| [docs/execution.md](docs/execution.md) | The execution slice and the integration gate |
| [docs/scheduling.md](docs/scheduling.md) | Ordering, batching, and conflict detection |
| [docs/repair.md](docs/repair.md) | Bounded repair and escalation |
| [docs/provenance.md](docs/provenance.md) | The append-only event log and reconstruction |
| [docs/runtime-adapters.md](docs/runtime-adapters.md) | The `WorkerRuntime` contract and adapter obligations |
| [docs/hermes-adapter.md](docs/hermes-adapter.md) | Hermes as an optional runtime, not an authority |
| [docs/linear-adapter.md](docs/linear-adapter.md) | Linear intake and status reflection |
| [docs/security.md](docs/security.md) | Threat posture and defaults |
| [docs/security-policy.md](docs/security-policy.md) | Risk classification and the isolation gate |
| [docs/verification-and-merge-gates.md](docs/verification-and-merge-gates.md) | Verification and merge-gate policy |
| [docs/doctor.md](docs/doctor.md) | Environment diagnostics |
| [docs/adoption.md](docs/adoption.md) | Adopting the factory as a template |
| [docs/licensing.md](docs/licensing.md) | The MIT decision and its rationale |

## What dogfooding found

Running the factory on itself surfaced defects that no amount of green tests would have. Each was
fixed and is listed above; recorded here because the pattern matters more than the individual bugs.

| Defect | Why no test caught it |
|---|---|
| A dispatch could hang indefinitely and fail silently | The log stayed frozen at `worker.started`, so the evidence read as work-in-progress rather than as failure |
| Verification ran against a **deleted** worktree | Cleanup happened before the checks. The test written for that invariant used a fake runtime returning a fictional path — it *could not* have observed a directory disappearing |
| A runtime agent deadlocks when its stdout is a pipe | Only reproducible with a real agent and a demanding prompt |
| Repair re-dispatched a runtime that had already failed | Every unit test used a runtime that succeeded |
| `paths` was documented but never checked | Nothing compared the worktree's diff against the declaration |
| A fresh clone's `npm test` ran the factory's own suite | Only visible by cloning and following the guide literally |

The recurring shape: **a green suite proves the parts work, not that they compose.** Four of these
six were invisible to unit tests by construction.

## Known divergences

Recorded rather than quietly reconciled. Each is a real gap between a documented design and the
shipped code.

| Divergence | Detail |
|---|---|
| `factory verify` is narrow | It runs the target project's `verify` script, else the individual steps it declares. A check that is not an npm script is invisible to it |
| Verification defaults to `npm test` | A project verifying another way passes `--checks <file.json>`; an empty list is refused |
| Security risk signals are declared, not detected | The gate refuses `untrusted`/`destructive` work, but only from signals declared on the plan. It does not read the goal text to guess |
| Scope is enforced, not advisory | An out-of-scope change blocks `ready`. A Work Unit declaring no `paths` gets no gate, recorded as `undeclared`. An audit and a gate, **not a sandbox** |
| Linear intake is not composed | `src/adapters/linear/` has no CLI command; the "scheduler blocked" path in the pipeline reads scheduler decisions |
| CLI surface is narrower than the plan | Implemented: `work run`, `work validate`, `verify`, `doctor`. Not implemented: `init`, `work create`, `work status`, `workspace list` |
| No SCM adapter | PR creation and merge stay human-led; the factory records the decision only |
| No sandbox adapter | Nothing offers `sandbox` isolation, so `untrusted` and `destructive` work is **refused** at dispatch rather than run weakly |
| Adapters organised by provider | `src/adapters/{opencode,herdr,hermes,linear,verification}` rather than the plan's role-based directories |
| The plan's skills directory is not used | Skills live under `.agents/skills/`, as the Protocols spec requires |

See [the Reference Implementation Plan](https://app.notion.com/p/3ef1546a1c8581faa863fc3f4ee91879)
for the full spec these were built against.

## Source hierarchy

1. Approved product/architecture specifications
2. Work Unit acceptance criteria and dependencies
3. Repository code and tests
4. Agent/project guidance

When sources conflict, stop and escalate rather than silently choosing a new requirement.

## Adoption

New repository? Start from the template. See [`docs/adoption.md`](docs/adoption.md) for requirements,
the step-by-step path, and a checklist. The step that matters most is requiring the `contract`
job via branch protection — without it the verification gate is documentation, not enforcement.

## License

MIT. See [`LICENSE`](LICENSE) and [`docs/licensing.md`](docs/licensing.md) for the rationale.

The factory is MIT so it can be adopted as a template without licensing friction. Adapter skills
(`runtime/opencode`, `runtime/herdr`) describe how to operate third-party tools and confer no rights
to those tools, which remain under their own licenses.
