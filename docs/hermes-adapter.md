# Hermes Adapter

## Purpose

This documents FCT-009: Hermes as an **optional** orchestration/runtime entry point, without
transferring factory authority to it.

Hermes is a full agent harness with its own tools, worktrees, sessions, gateway, and provider
plumbing. That makes it powerful and makes it a governance risk. The adapter's job is to use it for
execution while keeping it structurally unable to decide that work is finished.

## Interface

Discovered from `hermes --help` (v0.21.5) rather than assumed. All Hermes-specific invocations are
assembled in `src/adapters/hermes/process.ts` and nowhere else.

| Purpose | Invocation |
|---|---|
| One-shot dispatch | `hermes -z <prompt>` |
| Working directory | `hermes --in <dir>` / runner `cwd` |
| Isolated worktree | `hermes --worktree` |
| Toolset restriction | `hermes --toolsets <a,b>` |
| Usage evidence | `hermes --usage-file <path>` |
| Version / health | `hermes --version` |

## Three enforced invariants

**1. Runtime state is not factory completion.** `waitAgent` returns Hermes' exit status and nothing
else. `inspectAgent` returns only `{ status }` — there is no field on this adapter through which a
Hermes run can assert correctness. The `worker.finished` event even carries
`note: "Hermes exit status is runtime state, not verification success"`, and no runtime event type
contains the string `verification`.

**2. Hermes cannot bypass the integration gate.** This adapter produces runtime evidence only.
`VerificationResult` and `IntegrationResult` are produced by `runShellVerification` and
`buildIntegrationResult`, which **never receive Hermes state as an input**. `runShellVerification`
takes no execution record at all, so there is no path from a Hermes run to an integration verdict.

**3. Least privilege by default.** Toolsets are passed only when the caller specifies them — a
Work Unit that does not ask for a toolset does not get one. `--yolo` and `--accept-hooks` are
**never** passed, so Hermes' own approval prompts stay in force. A test asserts neither flag ever
appears in an invocation.

## Parent Work Unit identity

The parent Work Unit id is captured at `createWorkspace` and carried into every agent created in that
workspace, so evidence ties a dispatched run back to what requested it:

- `AgentRef.runtimeId` is `"<workUnitId>:<workerId>"`;
- the Hermes session id is derived from the same pair;
- every `ExecutionEvent` on the run carries the parent `workUnitId`.

Identity survives multiple agents in one workspace, which is the case a naive per-agent id would get
wrong.

## Failure mapping

`unavailable`, `protocol_incompatible`, `timeout`, `blocked`, `workspace_failed`, `cleanup_failed`,
and `agent_exited` are mapped explicitly. Evidence collected before a failure is **preserved** — a
failed run remains inspectable rather than erasing what happened. A blocked Hermes run surfaces as
`blocked` on `inspectAgent` and as `exited` through the protocol tri-state, matching the Herdr adapter.

## Optional, and non-displacing

`capabilities()` includes `orchestration` and deliberately **excludes** `verification`: this adapter
can run checks, but it cannot establish that they passed. Adding Hermes did not change, wrap, or
degrade the direct OpenCode or fake runtimes — a test constructs all three against the same interface.

Nothing in the module requires the `hermes` binary to exist. The injected command runner is the only
entry point, so every test runs without Hermes installed and remains deterministic.

## Verification

Unit tests use an injected runner exclusively. A separate **read-only** live check confirmed
`health()` against the real binary (`Hermes Agent v0.21.5+5635.g5bba024`) without dispatching a model
or invoking a provider; that check is not committed, because CI must not depend on a developer's
local Hermes install.

## Boundary

No remote infrastructure, no mandatory Hermes, no replacement for `WorkerRuntime`, no autonomous merge
or release. Hermes is a runtime the factory may use, never an authority over the work.