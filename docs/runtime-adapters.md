# Runtime Adapters

## Purpose
Adapters isolate factory semantics from execution-provider details.

## The interface
`WorkerRuntime` in `src/protocol.ts` is the whole contract. Ten methods, all camelCase:

| Method | Purpose |
|---|---|
| `capabilities()` | What this runtime can do, as stable capability names |
| `health()` | Availability and version |
| `createWorkspace(workUnit)` | An isolated workspace for one Work Unit |
| `createWorktree(workspace, baseRevision?)` | A Git worktree from a specific revision |
| `startAgent(workspace, worker)` | An agent identity bound to that workspace |
| `promptAgent(agent, prompt)` | Deliver work |
| `waitAgent(agent, timeoutMs)` | `"running"` \| `"idle"` \| `"exited"` — status only, never correctness |
| `inspectAgent(agent)` | `{ status, failure? }` |
| `collectRuntimeEvidence(agent)` | Operational evidence for the provenance log |
| `cleanupWorkspace(workspace)` | Release the workspace |

The shape is deliberately small and deliberately says nothing about whether work succeeded. There
is no method through which a runtime can report success, because a runtime does not own that
judgement.

## Required behavior
Every runtime adapter should expose equivalent factory-level semantics for:
- capability discovery
- health
- workspace/worktree creation
- agent start/prompt/wait/inspection
- runtime evidence
- cleanup

## Shipped adapters

| Adapter | Kind | Notes |
|---|---|---|
| `fake` | Test double | Deterministic; the default in tests and always available to the CLI |
| `opencode` | Direct | Runs OpenCode without a managed terminal runtime |
| `herdr` | Managed | Uses Herdr as an execution/workspace substrate |
| `hermes` | Managed | Optional agent-native orchestration; see [hermes-adapter.md](hermes-adapter.md) |

Herdr and Hermes are preferred supported runtimes, not mandatory factory dependencies. The CLI
offers a runtime only when its binary is on `PATH`, and reports an unknown runtime name as an error
rather than silently substituting another.

### Doctor coverage is not the same as the runtime list

The CLI offers all four; `factory doctor` checks two. `src/doctor/doctor.ts` declares `opencode` as
required and `herdr` as optional, and has no entry for `hermes`. So `doctor` reports `healthy` on a
machine with no Hermes while the CLI would offer it — the omission is in the diagnostic, not in
dispatch. Documented in [doctor.md](doctor.md) so the runtime table above is not read as a claim that
all four are verified before a run.

## Agent-native orchestration
An agent may request bounded orchestration actions when policy permits. Such actions remain children of a parent Work Unit, are traceable, and cannot bypass verification or integration gates. The Hermes adapter is the shipped example: it can run checks, but its `capabilities()` deliberately exclude `verification`, and neither `VerificationResult` nor `IntegrationResult` is ever computed from its state.

## Every call is bounded

No shipped adapter may wait indefinitely on a process. `opencode run` is a
subprocess that can wedge — a provider that stalls, a lock held, a socket that
never closes — and an unbounded call turns a stuck runtime into a dispatch that
hangs forever **with no error recorded**. A log that never resolves is worse than a
crash, because it reads as work-in-progress indefinitely.

| Bound | Default | Where |
|---|---|---|
| One agent prompt | 900s | `DEFAULT_PROMPT_TIMEOUT_MS`, overridable per runtime |
| Any other subprocess (`git`, `--version`) | 120s | `DEFAULT_COMMAND_TIMEOUT_MS` |
| Waiting for an agent to settle | `timeoutMs` from `waitAgent` | the caller's budget |

An expired call raises the `timeout` `RuntimeFailure`, which `execution.ts` records
as a `runtime.failure` **factory** event before cleanup runs. The timeout is
detected from Node's own kill signal rather than a raced timer, so the child
process is genuinely killed instead of being orphaned.

`--prompt-timeout-ms` exposes the prompt ceiling, because a ceiling an operator
cannot move is indistinguishable from a hang.

**A defect found by dogfooding:** `waitAgent` declared a `timeoutMs` parameter and
the OpenCode adapter discarded it (`_timeoutMs`), and `promptAgent` had no timeout
at all. A real dispatch hung for 25 minutes and produced no evidence. Herdr and
Hermes were checked and already honoured theirs.

## Failure semantics
Adapters must distinguish at least:
- unavailable
- startup_failed
- prompt_failed
- timeout
- blocked
- agent_exited
- workspace_failed
- cleanup_failed
- protocol_incompatible

Runtime failures must not erase factory state.

## Future runtimes
Containers, remote sandboxes, Codex, Claude Code, and other runtimes can be added as adapters without changing Work Unit semantics.

No container or remote sandbox adapter ships today, which is why higher-risk work is **refused**
rather than run weakly: `untrusted` and `destructive` Work Units require a `sandbox` isolation
level, and no adapter offers one. See [security-policy.md](security-policy.md). Adding an adapter is
therefore how that refusal would become a capability — not by loosening the gate.

Two things about that refusal, stated plainly because the doc set would otherwise imply otherwise:
the gate is not called by `factory work run`, and there is no sandbox adapter that could satisfy it
even if it were. The refusal is reachable only through a caller that invokes
`evaluateSecurityGate`. See [security-policy.md](security-policy.md#not-enforced-at-dispatch).


## Herdr adapter boundary

Herdr exposes machine-readable automation for workspaces, Git worktrees, recognized agents, prompts, waits, and optional remote-machine routing. The factory adapter consumes these automation surfaces rather than Herdr UI state. Herdr runtime state is evidence about execution, not authority for verification or integration. Remote machine routing is intentionally deferred; when added, the target machine must be explicit and unavailable remote targets must fail rather than silently falling back to local execution.
