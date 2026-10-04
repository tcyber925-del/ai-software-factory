# Architecture

## Purpose
The factory is a thin coordination and governance layer over existing coding-agent runtimes.

## Responsibilities

### Factory owns
- Work Unit protocol
- capability requirements
- policy and autonomy
- scheduling semantics
- conflict detection
- execution events/state
- verification requirements/evidence
- integration gates
- traceability

### Runtime owns
- terminal/session lifecycle
- agent process lifecycle
- prompts and runtime interaction
- runtime-specific workspace mechanics
- runtime health

## Reference architecture

```
Founder / Product Owner
        ↓
Approved specification
        ↓
Work Unit
        ↓
Capability requirements
        ↓
Worker Registry
        ↓
Runtime Adapter
   ┌────┴───────────┐
   │                │
Direct Runtime   Managed Runtime
OpenCode         Herdr
                    ├─ OpenCode
                    ├─ Codex
                    ├─ Claude Code
                    └─ Hermes
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

## Provider neutrality
A Work Unit requests capabilities such as `frontend`, `testing`, or `browser`. It must not require a particular provider command.

Provider-specific behavior belongs in adapters.

## Runtime abstraction
The conceptual runtime interface includes:
- capabilities()
- health()
- create_workspace()
- create_worktree()
- start_agent()
- prompt_agent()
- wait_agent()
- inspect_agent()
- collect_runtime_evidence()
- cleanup_workspace()

The first implementations are direct OpenCode and Herdr adapters. Herdr is supported but not mandatory.

## State invariant
Runtime state and factory state are separate.

Examples:
- runtime `idle` does not mean Work Unit complete;
- runtime disconnect does not automatically mean Work Unit failed;
- agent exit does not establish correctness.

Completion requires factory verification evidence.

## Isolation and concurrency
Two Work Units may run concurrently only when their dependencies, touched paths, APIs, schemas, runtime assumptions, and integration surfaces are sufficiently independent.

When uncertainty exists, serialize.

Git worktrees prevent ordinary working-tree collisions but do not provide a security sandbox.

## V1 boundary
Local-first, no hosted control plane, no custom agent runtime, no database, and no web dashboard.
