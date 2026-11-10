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

## Isolation is verified, not asserted

A caller-supplied isolation label is **not** evidence. The factory enforces isolation in two stages:

1. **Pre-dispatch policy screen** (`evaluateSecurityGate`, before any workspace exists). It classifies
   risk and evaluates branch-write policy from the inputs it receives. `evaluateSecurityGate` also
   supports credential and dangerous-operation checks when callers supply `credentials` and `commands`.
   It refuses work whose minimum isolation is `sandbox` because no approved sandbox runtime is
   configured. It does **not** admit execution, because there is nothing to attest until a worktree
   exists.
2. **Pre-agent isolation admission** (`admitExecution`, inside `executeWorkUnit`, after
   `createWorktree` and before `startAgent`). The selected runtime returns a typed
   `IsolationAttestation` bound to that runtime, Work Unit, workspace, repository root, worktree path,
   and the agent's actual working directory. Admission validates the attestation's shape, identity,
   freshness, and level.

**Current dispatch wiring (`src/kernel/pipeline.ts`):** the pipeline calls the pre-dispatch screen with
`risk`, `targetBranch: workUnit.baseRevision ?? "HEAD"`, and `writeMode: "pull_request"`. It does **not**
currently supply `credentials` or `commands`. As a result, credential and dangerous-operation decisions
are not populated/enforced by this dispatch path today, and the branch check screens pull-request mode
against the derived base branch rather than validating an actual direct-push target. Connecting
credential requests, subprocess environment boundaries, and command/network enforcement is tracked
separately (see #89/#92) and is out of scope for this change.

Missing, malformed, stale, mismatched, or insufficient evidence **blocks** the Work Unit with
`failure: "isolation_unattested"` before `startAgent` is called. The pipeline short-circuits before
verification, repair, and integration, so an unattested run is never reported ready.

Passing a literal string such as `"git_worktree"` is refused as malformed evidence.

## Three different controls, not one

| Control | When | What it proves | What it does not prove |
|---|---|---|---|
| **Isolation attestation** | Before `startAgent` | The runtime reported verifiable, runtime-bound evidence for this workspace and agent directory | Adversarial containment, host isolation, or that the runtime told the truth |
| **Post-hoc containment detection** | After the agent stops, and again at the gate | Whether the factory checkout changed during the run | That the agent stayed inside its worktree while running, or anything about privileges |
| **Real sandbox** | Not shipped | Process/privilege/host isolation by construction | N/A — no adapter offers `sandbox` today |

Attestation does not replace containment detection, and neither is a sandbox. A worktree remains
developer isolation: it separates files, not privileges, processes, or the host.

## Higher-risk work cannot silently use an ordinary worktree

`assessExecutionRisk` classifies the work and computes the minimum isolation it requires. The
pre-dispatch screen refuses `untrusted` and `destructive` work before dispatch because they require
`sandbox` and no sandbox adapter exists.

For work that reaches a workspace, `admitExecution` consumes the runtime's attestation. Two things it
deliberately does not do:

- it does not downgrade the risk class to fit the isolation available;
- it does not warn and proceed.

The refusal names the reason, for example: *"`trusted` work requires `git_worktree`; runtime
'herdr' attested none ... a git worktree isolates files, not privileges."*

## Protected branches

`evaluateBranchWrite` refuses a **direct push** to `main`, `master`, or `release*`, for everyone
including the factory and its owner. Those branches are reachable only through a pull request and the
merge gate. This is data, so it can be recorded as evidence rather than trusted to a code path someone
might bypass.

**Dispatch note:** the pipeline currently invokes the screen in pull-request mode with
`targetBranch: workUnit.baseRevision ?? "HEAD"` (`src/kernel/pipeline.ts:431-446`). This records that
screening context; it does **not** by itself validate or authorize an actual direct push to a protected
branch target. Protected-branch enforcement for real writes remains a property of the write/merge path
and human-gated integration policy, not of this pre-dispatch call alone.

## Credentials

`evaluateSecurityGate`/`evaluateCredentialAccess` encode the factory policy: production credentials are
**never granted by the factory** — not on request, not with approval, not ever. Lower scopes
(`development`, `staging`) are granted only when explicitly required. Anything production must be
supplied out of band by a human, which keeps the decision outside the factory's authority.

**Dispatch note:** the current pipeline pre-dispatch screen does not supply a `credentials` input, so it
does not emit or enforce a `credential_access` decision for dispatch requests. This does **not** grant
credentials, wire secrets into subprocess environments, or implement environment/network boundaries;
that work is tracked separately (#89/#92). Until such boundaries are implemented and evidenced, treat
credential handling as outside this dispatch screen's enforced inputs and preserve interim restrictions
(#90).

## Dangerous-operation screen

`detectDangerousOperations` detects recursive force deletes, force pushes, hard resets, history rewrites,
privileged containers, `chmod 777`, and credential reads.

**This is explicitly best-effort and is not a security boundary.** A determined command can evade a
regex. It exists to surface a finding and record it, not to contain an adversary, and it never
substitutes for sandbox isolation of untrusted work. The constant
`DANGEROUS_OPERATION_SCREEN_IS_BEST_EFFORT` states this in code so it cannot be quietly forgotten.

**Dispatch note:** the current pipeline pre-dispatch screen does not supply `commands`, so this screen is
not applied to dispatched runtime/agent commands in that path today. No command, environment, or network
isolation behavior is changed by documenting this. Expanding command/environment enforcement is out of
scope here (#89/#92).

## Adapter boundary for stronger isolation

`IsolationLevel` is a three-value scale — `none` < `git_worktree` < `sandbox` — with an explicit
ordering function. `WorkerRuntime.attestIsolation(request)` is the seam: an adapter reports typed
evidence of the isolation it actually provides for that workspace, and admission validates and
compares levels. No container platform, remote execution service, or secrets manager is built here;
a sandbox adapter must provide verifiable `sandbox` evidence, not a label.

Honest current state:

- **OpenCode** attests `git_worktree` when the agent subprocess runs in the created worktree. A
  conformance test proves the process cwd equals the attested path.
- **Hermes** attests `none` because the agent process runs from the repository root. Hermes may
  create an internal worktree, but the factory cannot name or observe it, so claiming a worktree would
  be unverified.
- **Herdr** attests `none` because it starts the agent in the workspace root pane at the repository
  root, even though it creates a worktree path.

Hermes and Herdr are therefore refused for work that requires a verified worktree, which keeps the
interim restriction in force by code. Re-enabling them requires verified worktree execution, not a
documentation change.

## Enforced at dispatch

The pre-dispatch screen runs in `src/kernel/pipeline.ts` **before** a workspace is created, a
worktree is checked out, or a runtime is invoked. The final isolation admission runs in
`src/kernel/execution.ts` **after** the worktree is created and **before** `startAgent`. A refusal at
either point means the agent never starts.

Each decision is persisted as a durable `factory` event — `security.allowed` or `security.blocked`
— for admitted work as well as refused work. Pre-agent decisions include runtime identity, attestation
outcome, required/provided isolation, workspace/worktree identity, and reason. An audit that recorded
only refusals could not show what was allowed and why.

## How risk is declared, and what that means

Risk signals are **declared, never inferred.** They live on the plan beside the Work Unit, not on the
Work Unit itself, because risk is a property of a dispatch rather than of the portable contract:

```json
{
  "workUnit": { "id": "W-1", "goal": "Summarise customer-uploaded files", "...": "..." },
  "paths": ["src/summarise"],
  "risk": { "consumesUntrustedContent": true }
}
```

The factory does **not** read the goal text and guess. Inferring "consumes untrusted content" from
the word *untrusted* in a goal would be a guess dressed as a control — precisely the failure mode
this factory exists to prevent. A declared risk may raise the classification; it can never lower it,
and a refused downgrade is recorded as a reason.

**The honest limitation: absence of a declaration is not evidence of safety.** An operator who
declares nothing gets `trusted`, which a worktree satisfies. The gate enforces declarations; it is
not content analysis, and it cannot become content analysis without either a reliable classifier or
accepting that the classification is a guess.

## `providedIsolation` is gone

Earlier drafts passed `providedIsolation: "git_worktree"` into the gate. That value was removed because
a caller-supplied level is not evidence. The dispatch path now proves isolation through
`attestIsolation` and admission, or it refuses to start the agent. Passing a literal label to
`admitExecution` is refused as malformed evidence, and a suite of "it refuses untrusted work" tests is
not sufficient — the contract requires tests that show invalid, stale, and mismatched attestations are
rejected before `startAgent`.

## Auditability

Every decision is a value, and every applied control produces a `SecurityDecisionRecord` recorded as a
durable factory event (`security.allowed` / `security.blocked`). A decision that exists only in a
terminal is not auditable. `evaluateSecurityGate` can apply risk/isolation screening, branch-write,
credential, and dangerous-operation checks together when inputs are provided, returning one decision per
control it evaluates (including when everything passed). In the current dispatch path, the pre-dispatch
screen evaluates the risk/isolation and branch-write inputs described above but does not receive
`credentials` or `commands`; pre-agent isolation admission separately records runtime-bound attestation
decisions. Audit records should be read together with the enforced inputs for that path.

## Least privilege

The factory requests nothing by default. No credential scope is granted unless asked for, no
production access exists, and higher-risk work is refused rather than downgraded. Admitting less is
the default; widening requires an explicit, recorded decision.

## Boundary

No container platform, remote execution service, secrets manager, or hosted security product. This is
policy and admission logic that a stronger adapter can plug into — not the stronger isolation itself.