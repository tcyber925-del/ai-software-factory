---
name: runtime-herdr
description: Operate Herdr as a managed execution/workspace runtime without transferring factory authority to Herdr.
category: runtime
provider: herdr
---

# Herdr Runtime

Use Herdr for terminal/workspace/agent lifecycle when selected by the runtime adapter.

Important:
- Herdr runtime state is not factory state.
- A Herdr agent becoming idle/exiting does not prove correctness.
- Keep the parent Work Unit traceable.
- Never bypass factory verification or integration gates.

## Adapter boundary
- The integration surface is the provider-neutral `WorkerRuntime` contract in `src/protocol.ts`.
- Herdr commands stay inside the adapter; `WorkUnit` carries no Herdr-specific fields.
- Herdr is a **preferred supported runtime, not a mandatory dependency**. Do not fail dispatch when it
  is unavailable, and never silently fall back to a weaker isolation mode than the one requested.
- Remote machine routing is deferred. When it is added, the target must be explicit and an
  unavailable remote target must fail rather than fall back to local execution.

## Optional runtime skills
`runtime-herdr` and `runtime-opencode` are adapter skills rather than entries in the factory skill pack
list. They describe how to operate one provider without transferring factory authority to it, and
they carry `category` and `provider` frontmatter to make that distinction explicit. This is a
recorded divergence from the flat pack list in the approved plan, not an omission.