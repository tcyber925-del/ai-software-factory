---
name: scope-review
description: Detect unauthorized scope expansion and architecture drift before integration.
---

# Scope Review

Compare actual changes against the Work Unit scope and acceptance criteria.

Flag:
- unrelated files;
- new architecture;
- new services/dependencies;
- changed contracts;
- product-direction changes;
- security-boundary changes.

Material expansion requires a change request and approval.

The authoritative boundaries are `AGENTS.md` and `docs/architecture.md`; in particular a Git worktree is
developer isolation and not a security boundary, and no expansion may introduce a hosted control
plane, database, or scheduler under the V1 boundary.
