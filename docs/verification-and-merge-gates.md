# Verification and Merge-Gate Policy

## Purpose

The factory treats verification as an independent integration gate.

A worker completing its runtime session, producing commits, or opening a pull request does **not** establish correctness.

The authoritative sequence is:

**Implement → Verify → Review → Merge → Release**

## Required verification

Every factory change intended for integration must have deterministic evidence appropriate to its scope.

A green suite is necessary but not sufficient: a test that cannot fail proves nothing. Each unit's
tests were proven non-vacuous by deliberately weakening the implementation and confirming the tests
then failed.

For the factory repository baseline, the CI contract requires:

1. TypeScript build (`tsc --noEmit`)
2. CLI emit and a smoke run of `node dist/bin.js --help`
3. Unit tests
4. JSON schema validation — all eight schemas well-formed, `additionalProperties: false`
5. Required documentation, fixtures, templates, and licence presence
6. Portable skill pack validation

Step 2 exists because a CLI that typechecks but cannot start is not a CLI.

A green CI run is necessary evidence for this repository baseline, but it is not by itself a substitute for human review where policy requires review or approval.

## Merge gate

Pull requests must not be considered integration-ready when the required CI contract is failing, missing, or inconclusive.

The GitHub branch protection/ruleset for `main` requires the CI job `contract`, is enforced on admins, and disallows force-pushes and branch deletion. Zero approvals are required, because a single-maintainer repository would otherwise deadlock on its own gate.

An adopting repository must establish the same rule. If GitHub repository settings are unavailable to the factory automation, this remains an explicit repository-owner configuration item; the factory must not pretend that documentation alone enforces the gate.

## Scope gate

A Work Unit's declared `paths` are a **write boundary**, not a hint. After verification passes and
before the integration gate, the factory reads the worktree's diff and compares it against the
declaration. A change outside it is recorded as a durable `scope.violation` event naming every file,
and by default prevents `ready`.

The reason names the files, because the worktree is cleaned up before an operator can look. A
dependency lockfile appearing in that list is called out specifically, per the policy below.

Ordering is deliberate: the checks decide whether the work is correct, and only a correct run is worth
asking whether it stayed inside its boundary. A run that is **both** broken and out of scope reports
both, with the failed checks leading — reporting either alone hides the other.

Three outcomes, none a silent pass:

| Situation | Result |
| --- | --- |
| Changes within `paths` | `ready` |
| Changes outside `paths` | Blocked, files named. `--no-strict-scope` downgrades to a warning |
| No `paths` declared | No gate; recorded as `undeclared`, never as "in scope" |
| Diff unreadable | The run **fails** |

**This is an audit and a gate, not a sandbox.** A determined agent can still do damage inside a
declared path, and it can reach a worktree it should not before the diff is read. Mid-run enforcement
was deliberately rejected: killing an agent mid-write risks a half-applied change, which is worse
than a detectable boundary crossing.

## Independence rule

The agent or runtime that performs implementation must not be the sole authority that declares the result correct.

Runtime state such as `idle`, `done`, or process exit is operational evidence only.

Verification must be performed through an independent deterministic mechanism whenever practical.

Independence is structural where it can be. `runShellVerification` takes no execution record, so
verification cannot consult runtime state even if asked to. A repair attempt is judged only by the
separately supplied `verify` function, never by the worker that performed it. See
[cli.md](cli.md) and [repair.md](repair.md).

## Failed verification

A failed verification result blocks integration.

Automatic repair is limited to the factory repair policy — two attempts by default. After the allowed repair attempts, execution stops for human intervention. In the CLI a run that exhausts repair exits `1` and reports `repair_exhausted`; it never degrades to a warning.

A merged change with subsequently discovered failed verification is treated as an integration defect and must be repaired through a new change; the original merge is not retroactively treated as verified.

## Evidence

A verification record should identify:

- Work Unit
- revision/commit tested
- checks performed
- pass/fail status
- relevant command output or durable evidence
- verification timestamp
- repair attempt, if applicable

## Current repository baseline

Re-verified against live `main` on 2026-10-06, after #57 merged. Earlier revisions of this
document named a commit here; that number was a claim a reader could not check, and it was wrong
within a day of being written. The settings below are the things worth recording, and they are
re-confirmed against the GitHub API when this section is next reviewed rather than trusted from
prose.

The GitHub Actions workflow at `.github/workflows/ci.yml` is the deterministic contract gate. It runs on pull requests and pushes to `main`. The job is named `contract`, and that is the name branch protection requires.

Branch protection on `main` is live and confirmed by the GitHub API, not merely documented:

| Setting | Value |
|---|---|
| Required status checks | `contract`, strict (branch must be up to date) |
| Required approvals | 0 |
| Enforce on admins | **enabled** |
| Allow force pushes | disabled |
| Allow deletions | disabled |

Zero approvals is deliberate: a single-maintainer repository would otherwise deadlock on its own
gate. Enforce-on-admins is the setting that makes the gate real, since without it the rule is
advisory for the only person who can merge.

`npm run verify` is the local equivalent: `tsc --noEmit`, a CLI emit, and the full test suite.

`factory verify` is **not** the same gate and does not currently pass — it invokes `format:check`,
`lint`, and `typecheck`, none of which this repository defines. See [cli.md](cli.md).

## The gate is a floor, not a ceiling

A green `contract` run is necessary and not sufficient, and the gap is worth being concrete about:
the gate does not check whether a shipped control is *composed*. Two gaps in this repository pass CI
cleanly because they are absence-of-a-caller, not absence-of-code:

- `evaluateSecurityGate` is implemented and tested but never called from the pipeline, so higher-risk
  work is not refused at dispatch;
- the doctor does not check `hermes`.

Neither is visible to a test suite that verifies what exists. Detecting them required reading the
call graph. Treat this as the reason human review stays required even on a green run.

Dependencies are installed with `npm ci`, and `package-lock.json` has been byte-identical through every unit shipped so far: the factory has zero runtime dependencies and no devDependency has been added or upgraded. Nineteen Work Units have shipped; numbering is not contiguous, and `FCT-014` merged from a branch named `FCT-021-security-hardening`.

### The mutation rung

`docs/verification-and-merge-gates.md` states that the suite's non-vacuity was proven by
deliberately weakening the implementation and confirming the tests then failed. `npm run mutations`
re-checks that claim on every run: `defects/mutations.json` holds five named degradations of this
repository's own controls, each naming the check meant to catch it, and
`scripts/mutation/run.mjs` applies them one at a time in a scratch tree and records which test
file failed.

It runs as a **separate, non-blocking** `mutation` job. Making it blocking requires the settings
in the previous section to hold for it as well, and that is a decision for a person, not a default.

Two properties are deliberate. The working tree is never written — mutations are applied to a
throwaway copy — so an interrupted run cannot leave a degraded `src/` behind, which is the failure
mode that makes an in-place mutation unsafe in CI. And a mutation that cannot be evaluated is
reported as a corpus error, never as an escape: an escape claims a check missed something, and a
defect that never ran is not evidence.

The scope-control composition — a violation detected by `checkScope`, passed through the pipeline
as `scopeReason`, and read by `buildIntegrationResult` — has no test that asserts the whole path.
The two halves are tested separately and the wire between them is not. This is the same
absence-of-a-caller shape as the Linear intake gap above, one level down, and it is recorded rather
than left for a reader to discover.

## Dependency installation

CI installs dependencies with `npm ci` against the committed `package-lock.json`.

The lockfile must be regenerated whenever `package.json` dependency metadata changes. `npm ci` fails by design when the two are out of sync; that failure is the intended signal and must be resolved by synchronizing the lockfile.

Replacing `npm ci` with `npm install` to make CI pass is not an acceptable repair. It removes the reproducibility guarantee while leaving a green run, which is the specific condition this policy exists to prevent.

The lockfile is part of the verification contract, so it is reviewed and changed like source: an unexplained dependency change is a scope finding.

This policy intentionally does not introduce a scheduler, database, hosted control plane, or provider-specific runtime behavior.
