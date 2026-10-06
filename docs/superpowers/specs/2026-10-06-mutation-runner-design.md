# Mutation runner — design

Date: 2026-10-06
Status: approved, ready for planning
Source baseline: `17bc3a8` (includes #57)
Relates to: the gap recorded at `docs/verification-and-merge-gates.md:16-18`

### Note on line references

This spec cites file and line anchors. Those were written against `3708b84`; #57 rewrote
`README.md`, `cli.md`, `using-the-factory.md` and `verification-and-merge-gates.md`, so
line numbers in `docs/` have shifted. Verify each anchor by reading the file before editing
it — the quoted *text* is the reliable part, the line number is not.

## Problem

`docs/verification-and-merge-gates.md` states:

> A green suite is necessary but not sufficient: a test that cannot fail proves nothing. Each
> unit's tests were proven non-vacuous by deliberately weakening the implementation and
> confirming the tests then failed.

That is a claim about the test suite in `tests/`. Nothing in the repository enforces it, and
nothing records which check caught which weakening. The claim is credible only because it was
done by hand, once, by someone who then remembered to write it down.

The suite size is deliberately not quoted here, and `main` no longer quotes it either. #57
removed the hardcoded count for the same reason this spec must avoid it: a number in prose
cannot be checked by a reader, and this project has published three different ones. The
authoritative value is `npm run verify`.

That is the same failure mode `coleam00/ai-software-factory` documents repeatedly in its
incident log: a guarantee that exists as prose and not as a mechanism decays silently. The
specific form relevant here is the one where a check "evaporates in exactly the condition it
exists to detect" — a vacuous test reads as a passing test.

This spec adds a mechanism that makes the claim re-checkable on every run.

## Scope

**In scope.** A hand-authored defect corpus targeting the factory's own `src/`, and a runner
that proves the existing test suite catches each defect. Five defects, one per kernel module.

**Out of scope (deferred).** Mutating a *target project* to prove the factory's verification
adapter catches injected defects. That is the more valuable end state — it verifies the
product rather than the factory — but it needs a fixture application and per-check
attribution, and it is a separate subsystem. Tracked as follow-on work, not silently dropped.

**Explicitly rejected.** An off-the-shelf mutation engine (Stryker and similar). It would be
the first dependency in a project whose zero-dependency posture is a documented, reasoned
decision held in two places (`src/kernel/json-schema.ts`, and the lockfile invariant in
`docs/verification-and-merge-gates.md`). Exchanging that for exhaustive-but-unattributable
coverage is a bad trade. The hand-authored corpus's blind spot — "only defects you thought of"
— is bounded and visible, which a mutation *score* would hide behind a single number.

## Approach

Three approaches were considered:

1. **Automatic operators, zero deps.** Hand-roll an AST mutation engine. Real coverage, but a
   large piece of infrastructure whose output is a score, and it re-derives what
   `typescript` already exposes. Rejected: high cost, low attribution.
2. **Automatic operators, new devDependency.** Rejected: breaks the dependency invariant.
3. **Hand-authored corpus.** Chosen.

### Why the corpus is hand-authored

Each defect is a named, human-understood degradation aimed at a specific check, and the runner
reports *which check caught it*. That attribution is the point. A mutation score tells you the
gate is 83% effective; a corpus with per-defect intended-rung tells you the integration gate's
`verification_passed` branch is unmeasured while the security gate's refusal path is not.

## Design

### Corpus format — `defects/mutations.json`

```json
{
  "defects": [
    {
      "id": "integration-gate-ignores-scope",
      "aimsAt": "tests/pipeline.test.ts",
      "why": "Blocking on a scope violation is a promise in docs/execution.md. If it silently stops, a Work Unit writes outside its boundary and reports ready.",
      "file": "src/kernel/integration.ts",
      "find": "const blocker = options.scopeReason ?? blockingReason(execution, verification);",
      "replace": "const blocker = blockingReason(execution, verification);",
      "expected": "caught"
    }
  ]
}
```

No `$comment` key: the corpus is machine-read, and a field nothing reads is a place for
instructions to rot. The rationale lives in `defects/README.md` and in this spec.

`expected` is always `"caught"` in V1. It is present anyway because the alternative — a defect
recorded as expected to escape — is the only honest way to record a *known* gap, and the format
should not need redesigning when that first happens.

`find` is an exact string match. A defect whose anchor does not match its target file exactly
once is a **corpus error**, reported as such, and never silently skipped: an unmatched mutation
that reports "escaped" would be indistinguishable from a real hole.

### The runner — `scripts/mutation/run.mjs`

Plain ESM JavaScript, Node 22, no dependencies, outside `src/` so it is never emitted into
`dist/` and never imported by the library.

Per defect, sequentially, **inside a scratch copy of the repository**:

1. **Read** the target file in the scratch tree. Confirm `find` occurs **exactly once**. Zero
   or multiple → corpus error, exit non-zero.
2. **Write** the mutated file into the scratch tree.
3. **Run** the suite against the scratch tree.
4. **Record** pass/fail.
5. **Discard** the scratch tree.

### Why mutate a copy, not the working tree

The obvious design mutates `src/` in place and restores afterwards. That is one interrupted run
away from committing a mutation, and the recovery is manual — a `finally` block does not run
when the process is `SIGKILL`ed or the machine loses power.

So the working tree is never written at all. Each defect is evaluated in a throwaway copy of
the repository (`node_modules` symlinked rather than copied), which costs a few seconds per
defect and makes the failure mode structural rather than procedural: **a killed runner can
only ever damage a temp directory the OS reclaims.** The working tree's immutability is a
property of the design, not of a cleanup handler.

Consequence for CI: because the working tree is untouched, the rung is safe to run in the same
job as `contract` as well as a separate one. It runs as a separate job so that a corpus problem
and a real regression are distinguishable in the CI UI.

### Ratchet

`defects/ratchet.json` records the last fully-passing corpus. The rung fails if the corpus
shrinks or any defect becomes uncaught — so the guarantee cannot be traded away silently, and
*adding* a defect that fails is caught immediately.

### CI integration

A `mutation` job, separate from `contract`, running after it. **Non-blocking initially**, and
the reason is stated in the workflow file itself:

```yaml
# Non-blocking while the corpus is being calibrated. Make it blocking once the
# corpus is known to pass reliably; until then a red here may mean the corpus
# drifted, not that a control regressed. Those need different responses.
continue-on-error: true
```

Flipping this to blocking is a one-line change and is the intended end state. Recording the
intent in the file prevents the `continue-on-error` from becoming permanent by inattention —
the same class of decay this whole design exists to catch.

`npm run mutations` is the local entry point.

## Error handling

| Condition | Behaviour |
|---|---|
| `find` anchor absent or ambiguous | Corpus error, exit non-zero, name the defect |
| Mutated file fails to parse | Caught (the suite cannot run), reported as caught-by-build |
| Suite passes on a mutated tree | **Escaped.** Reported loudly, ratchet fails |
| Runner killed mid-run | Working tree untouched by construction (copy-based) |
| Scratch copy fails to build | Corpus error, exit non-zero — never reported as an escape |

The last row matters most. A mutation that cannot be evaluated is **not** evidence that the
check missed it. Reporting "escaped" for a run that never executed produces the most misleading
number this system can produce.

## Testing the runner itself

The runner gets its own tests, because a check for the checker that cannot fail is the same
defect one level up:

- applying a known defect makes the named test file fail
- restoring returns the file byte-for-byte
- an unmatched anchor is a corpus error, not an escape
- an intentionally uncaught defect is reported as escaped
- the ratchet fails on a shrinking corpus

## Success criteria

1. `npm run mutations` reports all five defects caught, naming the catching check for each.
2. Every defect's `aimsAt` corresponds to a test file that exists.
3. `src/` is byte-identical before and after a run, including after a forced kill.
4. The ratchet fails when a defect is removed from the corpus.
5. Zero new dependencies; `package-lock.json` unchanged.
6. The rung runs in CI and its output names the catching check per defect.

## The corpus

Each defect's anchor was read against `src/` and verified unchanged by #57, which touched
`README.md`, `docs/` and `tests/documentation.test.ts` but no `src/` file. Two
initial candidates were rejected during that check, and the reasons generalise to the rest of
the corpus.

| Defect | File | Anchor | Aimed at | Degradation |
|---|---|---|---|---|
| `integration-gate-ignores-scope` | `kernel/integration.ts:52` | `options.scopeReason ?? blockingReason(...)` | `tests/pipeline.test.ts` | drop the `scopeReason` override, so a scope violation reports `ready` |
| `repair-limit-never-reached` | `kernel/repair.ts:23` | `DEFAULT_MAX_REPAIR_ATTEMPTS = 2` | `tests/repair.test.ts` | raise to 1000 so the loop cannot escalate |
| `security-destructive-needs-no-sandbox` | `security/risk.ts:106` | `case "destructive":` fall through to `"git_worktree"` | `tests/security.test.ts` | a `destructive` Work Unit is admitted in an ordinary worktree |
| `scope-undeclared-not-flagged` | `kernel/scope.ts:69` | `undeclared: true` | `tests/scope.test.ts` | a Work Unit declaring no `paths` looks identical to a narrowly-scoped one |
| `verification-failure-reads-as-pass` | `adapters/verification/shell.ts` | status derived from exit code | `tests/*` | a failing check is recorded as passing |

**Rejected candidates.**

- *Make `checkScope` return `outOfScope: []` always* — too coarse. It breaks the assertion but
  not the reasoning; the defect should be one an engineer could plausibly introduce, not one
  that damages the module beyond recognition.
- *Delete the `adequate` check in `admitExecution`* (`security/risk.ts:137`) — rejected in
  favour of the `minimumIsolationFor` mutation above. Both are caught by `tests/security.test.ts`,
  but the `minimumIsolationFor` version degrades exactly the documented promise: *"Higher-risk
  work requires a sandbox. This is the control that stops a higher-risk Work Unit from quietly
  running in an ordinary worktree."*

The selection rule this produced: **aim the defect at a promise the module documents in prose,
and let the test that encodes that promise be the catcher.** A defect that damages a module
beyond recognition proves the suite has an assertion somewhere; it does not prove the assertion
guards the control.

The fifth defect's anchor is not yet fixed — the exact line in `adapters/verification/shell.ts`
that derives status must be read before the corpus entry is written. That is implementation
work, not spec work.

## Work Unit

New Work Unit, suggested `FCT-026-mutation-corpus`. Per `AGENTS.md` this requires a Work Unit
and a branch. The current branch is `docs/correct-stale-verification-claims`; it should be
merged or renamed before implementation starts, so the two changes are not conflated in review.

Per `AGENTS.md`, "Explicit approval required before implementation" covers changes to CI and the
verification contract. The rung ships **non-blocking** for that reason as well as the calibration
one — flipping it to blocking is a separate decision that needs a human.

## Follow-on work (deferred, not dropped)

- **Target-project mutations.** Mutate a sample application and prove
  `runShellVerification` catches defects in *the product*, not just in the factory. Requires a
  fixture app and per-check attribution. This is the more valuable end state; it is deferred
  because a corpus that proves the factory's own gate is load-bearing must be trustworthy
  before it is used to judge anything else.
- **`docs/incidents.md`.** Neither project can manufacture this. Ours begins when this factory
  runs unattended; before then, the honest entry is the empty file and its reason.
