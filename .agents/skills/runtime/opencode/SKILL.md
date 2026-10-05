---
name: runtime-opencode
description: Operate the direct OpenCode runtime adapter while preserving factory-level semantics.
category: runtime
provider: opencode
---

# OpenCode Runtime

OpenCode is an execution provider, not the factory authority.

Keep provider-specific commands inside the adapter. Report runtime evidence to the factory, but do not mark a Work Unit complete without independent verification.

## Adapter boundary
- The integration surface is the provider-neutral `WorkerRuntime` contract in `src/protocol.ts`.
- `WorkUnit` carries no OpenCode-specific fields; capabilities name requirements, not this provider.
- Runtime failure maps to an explicit `RuntimeFailure`, never to a silent success.
- Runtime status (`idle`, `done`, `exited`) is operational evidence only.

## Optional runtime skills
`runtime-opencode` and `runtime-herdr` are adapter skills rather than entries in the factory skill pack
list. They describe how to operate one provider without transferring factory authority to it, and
they carry `category` and `provider` frontmatter to make that distinction explicit. This is a
recorded divergence from the flat pack list in the approved plan, not an omission.