---
name: project-verification
description: Verify changes in this project against its own contract, using the factory CI job as the deterministic baseline.
---

# Project Verification

Derived from the factory's `verification` skill. Narrowed to this repository.

## Before claiming a change is done

1. `npm ci` succeeds against the committed lockfile.
2. `npm run build` passes with no new diagnostics.
3. `npm test` passes, including the failure paths.
4. Required CI checks passed **on the pushed commit**.
5. Scope matches the Work Unit — no unrelated files, dependencies, or architecture.

## Rules

- Never infer correctness from an agent reporting success. A green local run is
  necessary, not sufficient; a merge is not verification.
- Never weaken or skip a check to get to green. Fix the cause.
- Do not modify tests to make a failing test pass.
- Record what was actually observed, including for UI changes.

## Project specifics

<!-- Fill in: how to build, test, and run this project locally. -->
- Build: `npm run build`
- Test: `npm test`
- Environment setup: <!-- e.g. cp .env.example .env -->

## Escalate rather than assume

Stop and report when acceptance criteria are ambiguous, when the change needs
architecture you do not have approval for, or when a public claim has no
evidence.