# Schema Contract

Machine-readable protocol definitions live under `schemas/`.

Current schemas:
- work-unit.schema.json
- worker.schema.json
- capability.schema.json
- workspace.schema.json
- verification-result.schema.json
- integration-result.schema.json
- execution-event.schema.json
- conflict.schema.json

Schemas are intentionally small during bootstrap. Implementation may extend them only through a reviewed protocol change.

## Correspondence with TypeScript
Each schema is the snake_case wire form of a TypeScript type in `src/protocol.ts`. The two are kept in
correspondence by test, not by convention: `tests/protocol-schemas.test.ts` validates a conforming
instance, asserts required fields are enforced, asserts `additionalProperties: false` is rejected, and
checks the field names line up. `tests/execution-slice.test.ts` covers the same correspondence for
Work Unit, including the camelCase/snake_case projection.

## Capability and Workspace
`capability.schema.json` encodes a capability as a stable *requirement* (`name`, optional `category`
and `description`). It deliberately carries no provider, command, or runtime field: a capability names
what work needs, never who provides it. A test asserts no such field can be introduced silently.

`workspace.schema.json` mirrors `WorkspaceRef` (`id`, `path`, `worktree_path`) and adds optional
`runtime` and `isolation` fields for auditability. It records which isolation mechanism was used; it
does not assert that a Git worktree is a security boundary, because it is not. Risk classification for
higher-risk execution belongs to FCT-014 (#21).

## Validation
CI verifies every schema file is well-formed and declares `$schema`, `title`, and `type: object`, and
that at least five exist. Instance validation against these schemas is exercised by tests via the
in-repo validator in `src/kernel/json-schema.ts`, which implements only the keyword subset the schemas
use. Adopting a full JSON Schema implementation is deliberately deferred to avoid adding a dependency
for a fixed, small, known set of schemas.

## Compatibility rule
Protocol changes are architecture-level changes when they alter required semantics, lifecycle state, authority, or interoperability.

Such changes require explicit review before implementation.