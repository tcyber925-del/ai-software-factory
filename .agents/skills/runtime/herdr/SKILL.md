---
name: runtime-herdr
description: Operate Herdr as a managed execution/workspace runtime without transferring factory authority to Herdr.
---

# Herdr Runtime

Use Herdr for terminal/workspace/agent lifecycle when selected by the runtime adapter.

Important:
- Herdr runtime state is not factory state.
- A Herdr agent becoming idle/exiting does not prove correctness.
- Keep the parent Work Unit traceable.
- Never bypass factory verification or integration gates.
