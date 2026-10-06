# Security and Isolation Policy

## Purpose

This documents FCT-014: minimum isolation controls for higher-risk execution, implemented so they
are enforced rather than described.

## The central claim

**A Git worktree is developer isolation, not a security boundary.** It separates files. It does not
separate privileges, processes, or the host. Every refusal in this policy says so explicitly, because
the failure mode this prevents is precisely a worktree being *assumed* sufficient.

## Risk classification

| Class | Signal | Minimum isolation |
|---|---|---|
| `trusted` | First-party code in the user's own repositories | `git_worktree` |
| `untrusted` | Consumes content the factory did not author, or runs commands that cannot be enumerated in advance | **`sandbox`** |
| `destructive` | Touches production, credentials, or deployment | **`sandbox`** |

Classification is deterministic: the highest-severity signal wins, so the same inputs always produce
the same class and an assessment can be audited.

**A declared risk may raise the class, never lower it.** A Work Unit asserting `trusted` cannot
downgrade genuinely untrusted work, and the *refusal* is recorded too — a silently dropped downgrade
request would leave no trace that weaker isolation was ever asked for.

## Higher-risk work cannot silently use an ordinary worktree

`admitExecution` compares the isolation a Work Unit requires against the isolation actually offered.
When it is insufficient, the Work Unit is **blocked**. Two things it deliberately does not do:

- it does not downgrade the risk class to fit the isolation available;
- it does not warn and proceed.

The refusal names the reason: *"`untrusted` work requires `sandbox` but only `git_worktree` is
available; a git worktree isolates files, not privileges."*

## Protected branches

`evaluateBranchWrite` refuses a **direct push** to `main`, `master`, or `release*`, for everyone
including the factory and its owner. Those branches are reachable only through a pull request and the
merge gate. This is data, so it can be recorded as evidence rather than trusted to a code path someone
might bypass.

## Credentials

Production credentials are **never granted by the factory** — not on request, not with approval, not
ever. Lower scopes (`development`, `staging`) are granted only when the Work Unit explicitly requires
them. Anything production must be supplied out of band by a human, which keeps the decision outside
the factory's authority.

## Dangerous-operation screen

Detects recursive force deletes, force pushes, hard resets, history rewrites, privileged containers,
`chmod 777`, and credential reads.

**This is explicitly best-effort and is not a security boundary.** A determined command can evade a
regex. It exists to surface a finding and record it, not to contain an adversary, and it never
substitutes for sandbox isolation of untrusted work. The constant
`DANGEROUS_OPERATION_SCREEN_IS_BEST_EFFORT` states this in code so it cannot be quietly forgotten.

## Adapter boundary for stronger isolation

`IsolationLevel` is a three-value scale — `none` < `git_worktree` < `sandbox` — with an explicit
ordering function. That is the seam a container or remote-sandbox adapter implements: it reports the
level it provides, and admission compares levels rather than checking for one specific provider. No
container platform, remote execution service, or secrets manager is built here; this only defines the
boundary such an adapter must satisfy.

## Not enforced at dispatch

This policy is implemented and tested, but it is not wired into the run path.

`evaluateSecurityGate` has no caller in `src/kernel/pipeline.ts`, and no CLI command applies it. So
the refusals described above — a `untrusted` Work Unit requiring `sandbox`, a direct push to a
protected branch, a production credential request — are available to a caller that chooses to use the
library, and are **not** currently applied by `factory work run`.

That is the most consequential gap in the factory, and it is the one most likely to be misread. The
policy above describes what the code *can* do; a reader who assumes `work run` applies it would
believe higher-risk work is being refused when it is not. There is no sandbox adapter, so the
`untrusted` refusal is the one that would actually fire.

Composing the gate into the pipeline is a change to the run path and belongs in its own Work Unit.
See [cli.md](cli.md#what-the-pipeline-does-not-compose) and [architecture.md](architecture.md).

## Auditability

Every decision is a value, and every applied control produces a `SecurityDecisionRecord` recorded as a
durable factory event (`security.allowed` / `security.blocked`). A decision that exists only in a
terminal is not auditable. `evaluateSecurityGate` applies admission, branch-write, credential and
dangerous-operation checks together, so a caller cannot accidentally apply only some of them — it
returns one decision per control, including when everything passed.

## Least privilege

The factory requests nothing by default. No credential scope is granted unless asked for, no
production access exists, and higher-risk work is refused rather than downgraded. Admitting less is
the default; widening requires an explicit, recorded decision.

## Boundary

No container platform, remote execution service, secrets manager, or hosted security product. This is
policy and admission logic that a stronger adapter can plug into — not the stronger isolation itself.