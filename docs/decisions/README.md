# Decision records

A factory makes claims about what it will and will not do. When one of those claims is a **choice**
rather than a consequence, the choice needs a recorded origin, or the next reader inherits a decision
nobody remembers making.

This directory holds those records. One file per decision, numbered, never rewritten — a decision
that changes gets a new record that supersedes the old one.

## Why this exists

Work Unit completion and policy approval are separate states.

FCT-028 shipped a GitHub intake adapter whose eligibility signal #62 explicitly required "an explicit
decision" — and closed as complete without one. The adapter's documentation read as though the choice
were settled. That gap is what this directory closes: an implementation can be merged and verified
while the policy behind it is still unratified, and without a record the two states get confused.

The test suite cannot catch this. `npm run verify` proves the adapter behaves as written; it cannot
prove the written behaviour was *chosen*.

## Format

Every record carries these fields:

| Field | Meaning |
| --- | --- |
| **Status** | `proposed`, `accepted`, or `superseded by <record>` |
| **Context** | The constraint that forced a choice, not a preference |
| **Decision** | What was chosen, in one sentence |
| **Alternatives** | What else was viable and why it was not chosen |
| **Consequences** | What this makes true, and what it deliberately does not allow |
| **Ratified by** | Who decided, and *how* — a deliberation is not the same as a delegation |

`Ratified by` is the field that keeps this honest. A record that says only "accepted" has hidden
whether anyone actually considered the options.

## Naming

`NNNN-short-slug.md`, zero-padded to four digits, describing the decision rather than the work unit —
a decision outlives the unit that prompted it.
