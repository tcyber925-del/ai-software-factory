# Project Policy

Adopting the factory means adopting its guarantees. This file is the local
instance of `AGENTS.md` at the factory root; keep it, and edit it to describe
this project's actual boundaries.

## Source hierarchy

1. Approved product/architecture specifications
2. Work Unit acceptance criteria and dependencies
3. Repository code and tests
4. Agent and project guidance

When sources conflict, stop and escalate rather than silently choosing a new
requirement.

## Non-negotiables

These are inherited from the factory and are not optional:

- **Verification is independent.** A worker reporting success has not established
  correctness. Runtime status such as `idle`, `done`, or process exit is
  operational evidence only.
- **Integration cannot bypass verification.** A PR is not integration-ready while
  a required check is failing, missing, or inconclusive.
- **No direct protected-branch writes.** Work lands through a pull request.
- **Bounded repair.** Automatic repair attempts are capped (factory default: 2).
  Reaching the limit escalates for a human rather than retrying.
- **No autonomous merge or release.**
- **A Git worktree is developer isolation, not a security boundary.**

## Project boundaries

Fill these in for this repository:

- **Protected branches:** <!-- e.g. main, release/* -->
- **Deployment authority:** <!-- who may deploy, and under what approval -->
- **Credential policy:** <!-- how secrets are supplied; never commit them -->
- **V1 exclusions:** <!-- what this project deliberately does not build -->

## Runtimes

At least one runtime must be available to dispatch work. Run `factory doctor`
to check.

| Runtime | Role | Required |
|---|---|---|
| OpenCode | direct runtime | yes |
| Herdr | managed runtime | no — a preferred supported runtime, not a mandatory dependency |

A missing optional runtime is a warning, never a blocking error.

## Verification contract

The CI job `contract` is the deterministic gate and must be required before
merge on protected branches. It validates build, tests, JSON schemas, required
documentation, and the portable skill pack.

Do not disable, weaken, or bypass a required check to make a pipeline succeed.
If a check is wrong, change it through a reviewed pull request.