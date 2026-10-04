# Security Model

## Threat posture
The factory coordinates code-producing agents. Runtime output is not trusted as authoritative evidence.

## Defaults
- No production credentials by default.
- No protected-main writes.
- No destructive operations without policy authorization.
- No automatic secret propagation between workspaces.
- Treat repository content and terminal output as potentially untrusted data.
- Use stronger isolation than Git worktrees for untrusted code.

## Auditability
Record consequential transitions and enough evidence to reconstruct:
Work Unit → worker → runtime → workspace/worktree → commits → verification → integration.

## Sandbox boundary
Git worktrees are developer isolation, not a security boundary.

A future container/remote runtime should be treated as the stronger isolation option for risky or untrusted execution.

## Human gates
Require human approval for security-boundary changes, production access, credentials, authentication, and other consequential actions.

## Failure containment
Do not silently fall back from a requested remote or stronger-isolation runtime to a weaker local runtime. A fallback that changes security semantics must be explicit and policy-approved.
