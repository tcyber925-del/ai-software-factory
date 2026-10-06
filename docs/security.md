# Security Model

## Threat posture
The factory coordinates code-producing agents. Runtime output is not trusted as authoritative evidence.

The shipped gate is [security-policy.md](security-policy.md): deterministic risk classification and a
required isolation level per class. This document is the posture; that one is the enforcement.

## Defaults
- No production credentials by default.
- No protected-main writes.
- No destructive operations without policy authorization.
- No automatic secret propagation between workspaces.
- Treat repository content and terminal output as potentially untrusted data.
- Use stronger isolation than Git worktrees for untrusted code.

`untrusted` and `destructive` work is **refused** rather than run weakly, because no shipped adapter
provides the `sandbox` isolation those classes require. Adding an adapter is how that refusal becomes
a capability.

The refusal is **enforced at dispatch**: `evaluateSecurityGate` runs in `runOne` before any
workspace, worktree, or runtime is created, so a refusal is of the work rather than of its
consequences. Every decision — admitted or refused — is persisted as a durable factory event. See
[security-policy.md](security-policy.md#enforced-at-dispatch).

What remains a caveat is *what* it enforces: declarations, not content. Absence of a declaration is
not evidence of safety, so an operator who declares nothing gets `trusted`, which a Git worktree
satisfies.

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
