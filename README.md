# AI Software Factory

A provider-neutral, GitHub-native coordination layer for safely dispatching AI engineering work across isolated workspaces and heterogeneous coding-agent runtimes.

## Status

**Foundation bootstrap — FCT-001**

This repository is establishing the factory contract and first vertical-slice architecture. The scheduler and hosted control plane are intentionally not implemented yet.

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

## Planned first vertical slice

1. Define protocol types and schemas.
2. Implement a fake runtime for deterministic tests.
3. Implement direct OpenCode runtime adapter.
4. Implement Herdr runtime adapter.
5. Run one Work Unit in an isolated worktree.
6. Verify independently.
7. Produce a traceable PR.
8. Prove failure/reconciliation and conflict behavior.
9. Dogfood the factory on a real repository.

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
├── src/                  # Factory implementation (introduced after bootstrap)
├── tests/                # Deterministic and integration tests
└── templates/            # Reusable project/skill templates
```

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
