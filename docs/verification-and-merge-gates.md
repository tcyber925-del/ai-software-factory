# Verification and Merge-Gate Policy

## Purpose

The factory treats verification as an independent integration gate.

A worker completing its runtime session, producing commits, or opening a pull request does **not** establish correctness.

The authoritative sequence is:

**Implement → Verify → Review → Merge → Release**

## Required verification

Every factory change intended for integration must have deterministic evidence appropriate to its scope.

For the factory repository baseline, the CI contract requires:

1. TypeScript build
2. Unit tests
3. JSON schema validation
4. Required documentation validation

A green CI run is necessary evidence for this repository baseline, but it is not by itself a substitute for human review where policy requires review or approval.

## Merge gate

Pull requests must not be considered integration-ready when the required CI contract is failing, missing, or inconclusive.

Repository administrators should configure the GitHub branch protection/ruleset for `main` so the CI job `contract` is required before merge.

If GitHub repository settings are unavailable to the factory automation, this remains an explicit repository-owner configuration item; the factory must not pretend that documentation alone enforces the gate.

## Independence rule

The agent or runtime that performs implementation must not be the sole authority that declares the result correct.

Runtime state such as `idle`, `done`, or process exit is operational evidence only.

Verification must be performed through an independent deterministic mechanism whenever practical.

## Failed verification

A failed verification result blocks integration.

Automatic repair is limited to the factory repair policy. After the allowed repair attempts, execution stops for human intervention.

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

The GitHub Actions workflow at `.github/workflows/ci.yml` is the deterministic contract gate. It runs on pull requests and pushes to `main`.

## Dependency installation

CI installs dependencies with `npm ci` against the committed `package-lock.json`.

The lockfile must be regenerated whenever `package.json` dependency metadata changes. `npm ci` fails by design when the two are out of sync; that failure is the intended signal and must be resolved by synchronizing the lockfile.

Replacing `npm ci` with `npm install` to make CI pass is not an acceptable repair. It removes the reproducibility guarantee while leaving a green run, which is the specific condition this policy exists to prevent.

The lockfile is part of the verification contract, so it is reviewed and changed like source: an unexplained dependency change is a scope finding.

This policy intentionally does not introduce a scheduler, database, hosted control plane, or provider-specific runtime behavior.
