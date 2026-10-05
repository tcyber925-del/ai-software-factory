# AI Software Factory

A provider-neutral, GitHub-native coordination layer for safely dispatching AI engineering work across isolated workspaces and heterogeneous coding-agent runtimes.

## Status

**Runnable — the vertical slice is complete and composed**

The factory is implemented and can be run: `factory work run` validates Work Units, plans the
schedule, selects a runtime, dispatches into isolated worktrees, verifies independently, repairs
within a bound, and records the integration decision.

Still not implemented, by design: hosted control plane, database, scheduler daemon, web dashboard,
custom agent runtime, and autonomous merge or release. See [Non-goals for V1](#non-goals-for-v1).

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

`factory work run` is the composition layer: it validates Work Units, plans the
schedule, selects a runtime, dispatches into isolated worktrees, verifies
independently, repairs within a bound, and records the integration decision.

Readiness comes only from independent verification, never from runtime status, and
the checks run against the tree that was actually executed. See
[docs/cli.md](docs/cli.md).

## The vertical slice

Shipped and verified:

1. Protocol types and schemas.
2. A fake runtime for deterministic tests.
3. Direct OpenCode, Herdr, and Hermes runtime adapters.
4. Work Unit execution in an isolated worktree.
5. Independent verification with a bounded repair loop.
6. The integration gate and a traceable PR.
7. Failure, reconciliation, and conflict behaviour.
8. Durable event provenance.
9. A scheduler and a runtime-agnostic pipeline.
10. Security classification and an isolation gate.
11. A `factory doctor` environment check.
12. A runnable CLI composing all of the above.
13. Dogfooded on a real external repository.

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

## Documentation

| Document | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Ownership boundaries, provider neutrality, isolation |
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
