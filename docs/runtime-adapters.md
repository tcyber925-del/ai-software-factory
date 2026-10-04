# Runtime Adapters

## Purpose
Adapters isolate factory semantics from execution-provider details.

## Required behavior
Every runtime adapter should expose equivalent factory-level semantics for:
- capability discovery
- health
- workspace/worktree creation
- agent start/prompt/wait/inspection
- runtime evidence
- cleanup

## Direct OpenCode
The direct adapter runs OpenCode without requiring a managed terminal runtime.

## Herdr
The Herdr adapter uses Herdr as an execution/workspace substrate. Herdr may manage terminals, panes, workspaces, worktrees, remote machines, and supported agents.

Herdr is a preferred supported runtime, not a mandatory factory dependency.

## Agent-native orchestration
An agent may request bounded orchestration actions when policy permits. Such actions remain children of a parent Work Unit, are traceable, and cannot bypass verification or integration gates.

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
