# AI Software Factory — Agent Contract

## Mission
Build a reusable, provider-neutral coordination layer for safe AI-assisted software engineering.

## Authority
Use this precedence:
1. Approved product/architecture specifications
2. Work Unit acceptance criteria and dependencies
3. Repository code/tests
4. This file and local agent guidance

If authoritative sources conflict, **STOP**. Do not invent a resolution.

## Agent role
AI agents are implementation workers, not product owners. They may implement bounded work, run verification, and report evidence. They may not silently change requirements, architecture, scope, security posture, or release policy.

## Autonomy
### Automatic
- Bounded implementation within an approved Work Unit
- Tests and deterministic verification
- Documentation corrections
- Mechanical formatting/lint fixes

### Human review required
- Normal user-facing behavior changes
- New dependencies with meaningful maintenance/security impact
- Changes to public contracts

### Explicit approval required before implementation
- Architecture changes
- Authentication, credentials, security boundary changes
- Production infrastructure/deployment
- Database or hosted control plane
- New paid/external service dependency
- Major scope or product-direction changes

## Stop conditions
Stop and report when:
- requirements conflict;
- acceptance criteria are ambiguous;
- implementation requires unapproved architecture;
- scope materially expands;
- a security/privacy boundary is unclear;
- a public claim lacks evidence;
- a V1 non-goal would be introduced;
- verification cannot establish correctness.

## Execution contract
Every meaningful task should be traceable to a Work Unit and, where applicable, an issue and branch.

Preferred lifecycle:
**Discover → Assess → Specify → Approve → Implement → Verify → Review → Merge → Release → Observe → Learn → Repeat**

Branch naming should include the work identifier. Do not write directly to protected main during normal feature work.

## Verification
The producing agent is not the sole authority for correctness. Independent/deterministic verification is mandatory before integration.

Automatic repair is bounded to **2 attempts by default**. After that, stop for human intervention.

## Runtime boundary
Runtime systems such as OpenCode and Herdr execute agents. They do not own factory authority. Runtime status must never be treated as proof of Work Unit completion.

## Git and integration
- Prefer isolated Git worktrees for concurrent work.
- A worktree is isolation, not a security sandbox.
- No direct protected-main writes for normal work.
- Integration occurs only after verification and required human approval.
- Preserve traceability from Work Unit → workspace/worktree → commits → verification → PR.

## Change discipline
If implementation reveals a material conflict:
**STOP → Change Request → Founder Decision → Update Specification → Update issue/Work Unit → Continue**

Do not optimize for agent count. Optimize for safe throughput.
