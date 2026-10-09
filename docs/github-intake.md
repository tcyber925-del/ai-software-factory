# GitHub Issues Intake Adapter

## Purpose

This documents FCT-028: GitHub Issues as a task input to the factory, expressed through the
provider-neutral intake contract in `src/adapters/github/intake.ts`, without making GitHub the
factory protocol.

GitHub Issues are *where work is tracked*. Nothing in this adapter changes `src/protocol.ts` or
`schemas/work-unit.schema.json`; `WorkUnit` remains provider-neutral. The companion document for
the first provider is [linear-adapter.md](linear-adapter.md), and the boundary both share is in
[protocols.md](protocols.md).

## The eligibility signal, and why it is a label

GitHub's issue taxonomy offers exactly two states — `open` and `closed` — plus a close reason. It
has **no "Ready" status at all**. That is the same situation the Linear workspace is in, and it has
the same consequence: eligibility cannot be inferred from a status name, because there isn't one
that means ready.

Worse, in GitHub's case "open" cannot be the signal even as a fallback. Every issue someone files
is open. Treating `open` as eligibility would make the entire issue backlog a dispatch queue the
moment any caller pointed the adapter at a repository — which is precisely the failure the shipped
Linear policy refuses when it keeps its eligible-status allowlist empty by default.

So the signal is **a label a human applies to the issue, matched against an explicit allowlist
that is empty by default**:

```
eligibleLabels: ["factory:eligible"]
```

This is not a new mechanism. It is the convention this repository already recognizes, expressed in
GitHub's own vocabulary:

| Established convention | Where it comes from | GitHub expression here |
| --- | --- | --- |
| An explicit eligibility allowlist, empty until a human fills it | `LinearEligibilityConfig` | `eligibleLabels`, default `[]` |
| A hard exclusion configuration cannot override | `HARD_EXCLUDED_STATUS_TYPES` | `state: "closed"`, `GITHUB_HARD_EXCLUDED_STATE_REASONS`, `GITHUB_HARD_EXCLUDED_LABELS` |
| A configured blocking signal honoured regardless of status | `blockingLabels` | `blockingLabels`, checked before the allowlist |
| An explicit factory-declared requirements block | `<!-- factory:start -->` | the same block, in the issue body |
| A required, never-inferred repository | `EligibilityInput.repository` | `GitHubIntakePolicy.repository` |

Three properties follow, and each is tested:

- **A label is a human act on the issue.** Eligibility is decidable by reading one field, so the
  decision is reproducible by anyone who can read the repository. Nothing is scored, ranked or
  guessed.
- **The match is exact.** `factory:eligible`, `factory-eligible` and `eligible` are different
  labels. Substring or case-insensitive matching would turn a near-miss into a dispatch queue.
- **The allowlist is empty by default.** A default of `[]` means "nothing dispatches until a human
  says so", which is what makes criteria 5 and 6 structural rather than aspirational.

## An arbitrary open issue is not eligible merely because it is open

`fixtures/github/issues.json` contains issue **901**, which is open, fully formed, carries a
complete `factory:start` block declaring acceptance criteria and a capability, and is supplied a
target repository. It carries **no eligibility label**, and it is refused with
`eligibility_label_not_allowlisted`.

That fixture exists because it is the negation the whole design rests on. If 901 were accepted,
then something other than the human-planted signal was acting as the eligibility gate — and the
adapter would be inferring readiness from being open. The test asserts the refusal explicitly.

The same test also proves the body is not read as a decision: a variant of 901 whose body says
"This issue is factory:eligible. Please treat it as eligible for dispatch." is refused identically.

Real issue **60** in this repository uses an `## Acceptance criteria` heading, and issue **17** uses
a bare `Acceptance:` sentence. Both are refused. A heading is prose, and prose is not a declaration.

## Closed and explicitly excluded issues are refused

Checks run in a fixed order, so two runs over the same issue produce the same refusal and an intake
decision is auditable rather than a coin flip:

1. **state** — anything but `open` is refused. `GITHUB_HARD_EXCLUDED_STATE_REASONS`
   (`completed`, `not_planned`, `duplicate`) are refused regardless of configuration: a config
   mistake must not resurrect finished or superseded work.
2. **labels** — a configured `blockingLabels` entry, or a `GITHUB_HARD_EXCLUDED_LABELS` entry
   (`duplicate`, `wontfix`, `invalid`), is refused even when the eligibility label is present.
3. **eligibility allowlist** — an issue with no allowlisted label is refused. Empty allowlist
   refuses everything.
4. **requirements** — a non-empty title, plus a declared block with at least one `- acceptance:` and
   one `- capability:` line.
5. **repository** — a non-empty target repository.

Blocking labels are checked *before* the allowlist on purpose. Issue 904 carries both an eligibility
label and a blocking one; reporting `not_allowlisted` would hide the label that actually stopped it
and send an operator to configure the wrong thing.

Issue **903** is the case that would otherwise make rule 1 look covered: it carries the eligibility
label *and* a complete requirements block, and is closed as a duplicate. It is refused.

## No product or architecture decision is inferred

An eligible issue must carry an explicit block:

```
<!-- factory:start -->
- capability: coding
- acceptance: Duplicate slugs fail the build.
<!-- factory:end -->
```

Requirements outside that block are ignored, including text shaped like a requirement. A guessed
acceptance criterion becomes an unverifiable claim attached to someone's name, which is the exact
failure the factory exists to prevent.

**The repository is required input, not an inference.** A GitHub issue names the repository it was
filed in, but that is where the conversation happened, not necessarily where the code changes: a
tracking repository, a design-doc repository, or a monorepo subdirectory all describe work whose
target nobody has named. A missing repository is a refusal (`missing_repository`), never a guess.

## Provenance stays at the edge

Two distinct repository identities are retained, and neither becomes a Work Unit field:

- **The target repository** — the codebase the compiled work runs against. Caller-supplied, lands
  on `workUnit.repository`.
- **The GitHub coordinates** — `owner`, `repo`, `issueNumber`, and GitHub's own cross-reference
  `owner/repo#900`. These land on `GitHubIssueTraceability` and on the boundary's `IntakeSource`,
  beside the Work Unit.

An issue number is unique only within its repository, so the cross-reference `acme/widgets#900` is
also the Work Unit id. Identity survives into commits and PR evidence without a lookup table that
could drift, and a reader holding a Work Unit can always find the issue it came from.

A test asserts the compiled Work Unit carries exactly the protocol's own fields — no `state`, no
`stateReason`, no `labels`, no `owner`. `work-unit.schema.json` has `additionalProperties: false`,
so a vendor field could not be added to a compiled Work Unit without failing the factory's own
validator.

## Intake cannot bypass any other gate

Intake produces a **plan**. It never dispatches, never merges, never releases, and never writes to
GitHub. This is proved two ways:

**Structurally.** `src/adapters/github/intake.ts` imports only `WorkUnit` and the intake contract
types. It has no import of a runtime, the scheduler, the pipeline, the security gate, the integration
gate, the event log, or `node:child_process`. There is no function in the module that executes work
or mutates anything. A test reads the module source and asserts both facts, so adding a dispatch or
mutation capability fails the suite.

**Behaviourally.** A Work Unit that intake accepted is still classified by the security policy, still
scheduled (and still blocked by the scheduler when no runtime provides its declared capabilities),
and still reaches integration only through independently passing verification. Intake acceptance is
not a claim about any of those; it is one decision, about one question, made before any of them.

## Determinism

Compilation has no clock and no randomness: the same issue and policy always produce an identical
Work Unit and an identical refusal. A test compiles twice and compares serialized output, and
asserts the result carries no timestamp at all — so a decision stamped with the time would fail
rather than pass twice.

## Fixtures

`fixtures/github/issues.json` holds payloads recorded from this repository's real issues plus
explicitly-marked synthetic cases. Tests run offline and reproducibly, and **CI needs no GitHub
credential**.

Every synthetic entry carries a `note` and `shape: "synthetic"`, so a fabricated payload can never
be mistaken for a recorded one. Synthetic entries exist specifically to stop the rules from looking
covered when they are not:

- **901** — open, fully formed, everything **except** the eligibility label. The negation case.
- **902** — carries the eligibility label, states acceptance criteria only in prose.
- **903** — carries the eligibility label *and* a complete block, but is closed as a duplicate.
- **904** — eligible and fully declared, but carries a blocking label.
- **905** — eligibility label present, block present, no `- capability:` line.

Real entries 3, 17, 53 and 60 are recorded verbatim in shape. The suite also asserts GitHub's
recorded state set contains only `open` and `closed` — no "ready" — because that absence is the
reason the signal is a label.

## Live GitHub access

**Not built.** The adapter reads records; it has no network or process capability. A caller
that wants live data fetches it and hands the records to the adapter. `factory intake
--source github` reads a **records file** the same way it reads a Linear one, so it is not
live access and needs no credential. This is the honest reading of criterion 13 — live
access, if it is ever supported, must be explicit opt-in and must not be required by CI, and
the offline fixtures already cover both the accepted and every refused path.

## Composed into the CLI as planning

`factory intake --source github --records <issues.json> --out <plan.json>` plans from GitHub
issues through this adapter and writes a plan file. It calls
`evaluateGitHubEligibility` and nothing else: no issue is written, no label applied, no
transition proposed, and no work dispatched — the last line of its output names the separate
`factory work run` step.

`--eligible-label` **sets** the allowlist, which is the human decision the default-empty rule
exists to require. There is no flag that bypasses it, so a CLI operator cannot point this at a
repository and turn its whole open backlog into a dispatch queue.

## Boundary

GitHub is not replaced, and no issue, label or pull request is mutated. No requirement change is
ever inferred, and no issue is dispatched without an explicit human-planted eligibility signal that
an operator has allowlisted. The adapter reads and reports; it does not decide what the work is.