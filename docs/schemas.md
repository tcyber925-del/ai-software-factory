# Schema Contract

Machine-readable protocol definitions live under `schemas/`.

Current schemas:
- work-unit.schema.json
- worker.schema.json
- verification-result.schema.json
- execution-event.schema.json
- conflict.schema.json

Schemas are intentionally small during bootstrap. Implementation may extend them only through a reviewed protocol change.

## Compatibility rule
Protocol changes are architecture-level changes when they alter required semantics, lifecycle state, authority, or interoperability.

Such changes require explicit review before implementation.
