# Factory Doctor

## Purpose

This documents FCT-013: making local setup and runtime problems diagnosable **before** dispatch.

`factory doctor` answers one question — can this machine safely run a Work Unit? — and reports
per-check diagnostics rather than a single pass/fail bit.

## Read-only, and proven so

The doctor never writes, stages, cleans, or otherwise mutates the project it inspects. All
environment access is read-only, and this is verified against a **real Git repository** rather than
asserted in prose: `tests/doctor-readonly.test.ts` snapshots `git status`, `HEAD`, branches,
registered worktrees, and the file tree before and after a full diagnostic pass, and requires them
to be identical. It also proves inspecting worktree support does not register a worktree, and that
a full pass does not create a branch.

## Determinism and CI independence

All environment access goes through the injected `DoctorProbe`, so diagnostics depend on the
environment being *described*, not on the machine the doctor runs on. `tests/doctor.test.ts` drives
the doctor entirely from a fixture probe, which is what keeps CI independent of developer-specific
local configuration. Repeated runs over the same environment produce byte-identical reports.

## Severities

| Severity | Meaning |
|---|---|
| `error` | Dispatch is unsafe; a required capability is missing |
| `warning` | Dispatch can proceed, but something is degraded |
| `ok` | The check passed, and is reported so the absence of an error is evidenced |

Passing checks are reported rather than omitted, so a clean report is affirmative evidence rather
than silence.

Overall status is `blocked` if any error exists, `degraded` if any warning exists, otherwise
`healthy`.

## Required vs optional runtimes

This distinction is the point of the doctor, and it follows the documented policy in
`docs/runtime-adapters.md`:

| Runtime | Required | Missing means |
|---|---|---|
| `opencode` (direct) | yes | `error` — dispatch is blocked |
| `herdr` (managed) | **no** | `warning` — degraded, dispatch still allowed |

Herdr is a preferred supported runtime but explicitly *not* a mandatory factory dependency, so
treating its absence as an error would contradict the architecture. Every non-`ok` diagnostic carries
an actionable `remedy`.

## Unsafe conditions detected before execution

| Check | Severity | Condition |
|---|---|---|
| `git.worktree` | error | Worktree isolation unavailable |
| `git.repository` | error | Not inside a Git repository |
| `git.clean` | warning | Uncommitted changes would not be isolated |
| `git.head` | warning | Detached HEAD, so new branches have no base |
| `git.nested_worktree` | error | Already inside a linked worktree; nested dispatch is unsafe |
| `node.version` | error | Below the minimum supported major |
| `project.files` | error | Required protocol/policy files missing |

The nested-worktree check distinguishes a *legitimate* linked worktree (the probe reports the
current directory among registered worktrees) from an unsafe *nested* one, so dispatching from an
existing worktree is not falsely blocked.

## Boundary

Local diagnostics only. The doctor reports; it does not install, repair, configure, or dispatch. It
introduces no hosted service, scheduler, or runtime abstraction, and it is not a substitute for
verification — it reports whether the environment is ready, never whether work is correct.

`factory doctor` is currently a library (`runDoctor` / `createSystemProbe`). Wiring it to the
`factory` CLI entry point belongs with the CLI boundary work.