# 0001 — GitHub intake eligibility is a label, not a state

**Status:** accepted — 2026-10-09
**Work unit:** FCT-028 (GitHub Issues intake adapter), prompted by #62
**Implementation:** `src/adapters/github/intake.ts`, shipped in `9ddcb95`

## Context

GitHub Issues offers exactly two states, `open` and `closed`, plus a close reason. It has **no "Ready"
status**. The Linear workspace is in the same position, and that shaped the existing policy: the
eligibility allowlist is **empty by default**, so nothing dispatches until a human explicitly
allowlists a status.

For GitHub, `open` cannot serve even as a fallback signal. Every issue someone files is open, so
treating `open` as eligibility would make the entire backlog a dispatch queue the moment a caller
pointed the adapter at a repository.

Issue #62 required this be "derived from the existing factory policy/contract and established
conventions" and forbade inventing a mechanism "without an explicit decision."

## Decision

The eligibility signal is **a label a human applies to the issue, matched exactly against an
allowlist that is empty by default** (`eligibleLabels`, default `[]`).

This is not a new mechanism. It is the existing Linear policy expressed in GitHub's vocabulary:

| Established convention | Linear expression | GitHub expression |
| --- | --- | --- |
| Eligibility allowlist, empty until a human fills it | `eligibleStatusTypes` / `eligibleStatusNames` | `eligibleLabels`, default `[]` |
| A hard exclusion configuration cannot override | `HARD_EXCLUDED_STATUS_TYPES` | `state: "closed"`, `GITHUB_HARD_EXCLUDED_STATE_REASONS`, `GITHUB_HARD_EXCLUDED_LABELS` |
| A blocking signal honoured regardless of eligibility | `blockingLabels` | `blockingLabels`, checked **before** the allowlist |
| An explicit factory-declared requirements block | `<!-- factory:start -->` | the same block, in the issue body |
| A required, never-inferred repository | `EligibilityInput.repository` | `GitHubIntakePolicy.repository` |

## Alternatives considered

**Match on `open`.** Rejected. It is the one signal every issue carries, which makes the gate
meaningless — this is the exact failure the empty Linear allowlist exists to prevent.

**Match on `assignee`.** Rejected. Assignment records that someone took the issue, not that a human
judged it eligible. It is also routinely set by triage automation, so it does not evidence a decision.

**Match on milestone.** Rejected. Milestones group work for planning and are set for unready work as
often as ready work.

**Infer from issue prose.** Rejected outright. This is the failure mode the whole boundary is built
against: a guessed acceptance criterion becomes an unverifiable claim attached to someone's name.

**Keyword or fuzzy label matching.** Rejected. `factory:eligible`, `factory-eligible` and `eligible`
are distinct labels, and conflating them would let a lookalike authorise work.

**A GitHub-native readiness field.** None exists. Adding one would mean inventing a mechanism, which
#62 forbids.

## Consequences

What this makes true:

- **Eligibility is a human act on the issue.** One field decides it, so any reader of the repository
  can reproduce the verdict. Nothing is scored, ranked or guessed.
- **The default is closed.** With no allowlist configured, all 10 GitHub fixtures are refused —
  including one that is open and fully declared, because *an open issue is not a readiness signal*.
- **Configuration cannot widen it.** Issues closed as `completed`, `not_planned` or `duplicate`, and
  issues labelled `duplicate`, `wontfix` or `invalid`, are refused whatever the allowlist says.
- **A blocking label still wins.** `#904` carries `factory:eligible` *and*
  `needs-founder-approval`, and is refused.
- **The decision is portable.** GitHub and Linear share one policy shape, which is what makes the
  provider-neutral boundary meaningful rather than nominal.

What this deliberately does **not** allow:

- **No automatic eligibility.** Nothing becomes eligible by being open, assigned, or recent.
- **No bypass flag.** No CLI option can clear an issue the allowlist does not name. The allowlist *is*
  the safety property; a bypass would remove it while appearing to keep it.
- **No requirement inference.** Requirements stated only in prose are refused, naming what is missing.
- **No provider mutation.** The adapter imports only types, so it structurally cannot dispatch,
  create PRs, or mutate labels — intake produces a plan, never an action.

## Ratified by

The **founder**, on 2026-10-09, by **delegation**: the recommendation to ratify the convention-derived
label signal as shipped was put to them and answered "proceed with your preference." No deliberation
session was held.

This is recorded rather than smoothed over. The decision follows directly from conventions already in
`src/adapters/linear/intake.ts`, which is why delegation was sufficient — but a reader should know the
trade-off was reasoned, not debated. If a future change alters the signal shape, this record should be
**superseded by a new one** rather than edited.

## Verification this decision rests on

Behavioural, on `main` at `937c375` after merge:

| Check | Result |
| --- | --- |
| `npm run verify` | 27 files, **574 tests passing** |
| No allowlist configured | **0 of 10** GitHub records accepted |
| `--eligible-label factory:eligible` | 1 accepted (`acme/widgets#900`), 9 refused |
| Closed-as-duplicate, allowlisted | refused — `not_dispatchable` |
| Prose-only acceptance criteria | refused — `requirements_undeclared` |
| Missing capabilities | refused — `requirements_undeclared` |
| Eligible + blocking label | refused — `policy_blocked` |
| Determinism | two runs produce byte-identical plans, accepted and refused |
| `src/protocol.ts`, `schemas/` | **0-line diff** — the Work Unit stays provider-neutral |

Tests that encode it directly, in `tests/github-intake.test.ts`:

- *"does not treat an open issue as eligible merely because it is open"*
- *"does not infer the signal from anything written in the issue body"*
- *"does not treat an assignee, a milestone, or issue number as a signal"*
- *"matches the allowlisted label exactly rather than by keyword"*
- *"never dispatches a closed issue, even fully declared and allowlisted"*

## Related

- FCT-026, the provider-neutral intake boundary this signal sits behind: `src/kernel/intake.ts`
- The Linear policy it mirrors: `docs/linear-adapter.md`
- Work unit #62, which raised the question
