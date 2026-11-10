# FCT-PLAT-002 — Runtime isolation attestation

**Issue:** #91
**Branch:** `fix/FCT-PLAT-002-isolation-attestation`
**Base:** `fcf2615`
**Autonomy tier:** approval (scoped security-boundary change approved by the Founder)

## Goal

Replace caller-asserted isolation with a typed, runtime-bound attestation that admission validates
after the worktree exists and before any agent process starts. Preserve #80 containment detection and
the #90 interim restrictions. Do not claim a worktree is a sandbox.

## Design

Two decisions, deliberately separated:

1. **Pre-dispatch policy screen** (`evaluateSecurityGate`) classifies risk and refuses work whose
   minimum isolation is `sandbox`, because no approved sandbox runtime exists. It also applies branch,
   credential, and dangerous-operation checks. It does **not** admit execution on an isolation label.
2. **Pre-agent isolation admission** (`admitExecution`) runs inside `executeWorkUnit` after
   `createWorkspace`/`createWorktree` and before `startAgent`. It consumes a typed
   `IsolationAttestation` and validates it against the required level, the selected runtime, the Work
   Unit, the workspace identity, the worktree path, the agent cwd, the repository root, and freshness.

A literal string such as `"git_worktree"` is not an attestation. Missing, malformed, stale,
mismatched, or insufficient evidence returns `status: "blocked"` with
`failure: "isolation_unattested"` before `startAgent` is called. The pipeline short-circuits before
verification and repair; repair also stops if a repair attempt is blocked, so no unexecuted tree can
be verified or reported ready.

OpenCode attests `git_worktree`; a conformance test proves the agent subprocess cwd equals the
attested path. Hermes and Herdr attest `none` because their agent process runs from the repository
root (Hermes may create a pseudo-worktree, Herdr starts the agent in the root pane). They are refused
by the gate for worktree-required work, which keeps #90 enforced by code rather than by policy text.

## Tasks

### 1. Typed contract and validator (RED → GREEN)

- Add `tests/isolation-attestation.test.ts` for:
  - a valid OpenCode-shaped attestation;
  - a literal `"git_worktree"` label rejected as malformed;
  - missing, malformed, stale, runtime-mismatched, Work-Unit-mismatched, workspace-mismatched,
    worktree-mismatched, agent-cwd-mismatched, repository-root-mismatched, and insufficient (`none`);
  - no secrets in the decision summary.
- Add `IsolationLevel`, `IsolationAttestation`, and `IsolationAttestationRequest` to
  `src/protocol.ts`; extend `WorkerRuntime` with `attestIsolation(request)`.
- Add `src/security/attestation.ts` with `verifyIsolationAttestation`.
- Update `src/security/risk.ts` so `RiskAssessment` carries required isolation only and
  `admitExecution` consumes the attestation.

### 2. Pre-dispatch screen and admission tests (RED → GREEN)

- Rewrite `tests/security.test.ts` gate tests to use `evaluateSecurityGate` without
  `providedIsolation`.
- Prove a caller cannot obtain admission by passing a literal label to `admitExecution`.
- Prove trusted work passes the screen but still needs attestation; untrusted/destructive work is
  refused before dispatch because it requires `sandbox`.
- Keep branch, credential, dangerous-operation, and no-downgrade tests.

### 3. Execution enforcement (RED → GREEN)

- Add `tests/execution-slice.test.ts` cases for missing/forged/mismatched/stale attestation:
  blocked, no `worker.started`, no `worker.prompted`, `failure: "isolation_unattested"`.
- Implement admission in `src/kernel/execution.ts` after `createWorktree`, before `startAgent`.
- Persist a security decision with runtime, attestation outcome, required/provided level, workspace
  identity, and reason. Record `isolation` on the execution record.
- Implement `FakeRuntime.attestIsolation` with the request's paths and observation time.

### 4. Adapter conformance (RED → GREEN)

- OpenCode: real temporary Git repository + real `git worktree add`; a stub `opencode` executable
  records its cwd. Assert the cwd equals the attested `agentCwd` and worktree path.
- Hermes: attestation is `none` with `agentCwd` at the repository root, both with and without
  `useHermesWorktree`; `executeWorkUnit` blocks before `startAgent`.
- Herdr: attestation is `none` with `agentCwd` at the repository root even though a worktree path was
  created; `executeWorkUnit` blocks before `startAgent`.
- No adapter inherits another adapter's evidence: the expected runtime name must match.

### 5. Pipeline and repair (RED → GREEN)

- Pass risk and repository root into every `executeWorkUnit` call (initial and repair).
- After execution, if `status === "blocked"`, run the early containment check and then return a
  blocked run without settling, verifying, repairing, or integrating.
- In `runRepairLoop`, stop before verification when a repair attempt is blocked.
- Add tests:
  - invalid attestation never reaches `verification.started` or `integration.ready`;
  - a runtime mismatch cannot reach ready;
  - #80 containment escape still blocks readiness even with valid attestation;
  - durable events contain runtime identity, attestation outcome, required/provided level, and
    reason, with no credential values.

### 6. Documentation

- `docs/security-policy.md`: replace the `providedIsolation` claim with the two-stage contract;
  state that a worktree is not a sandbox; distinguish verified evidence, post-hoc containment, and a
  real sandbox.
- `docs/architecture.md`: update the gate ordering diagram/text.
- `docs/execution.md`: add attestation to the path and boundary notes.
- `docs/runtime-adapters.md`: add `attestIsolation`, per-adapter evidence, and the Hermes/Herdr
  refusal.
- `docs/verification-and-merge-gates.md`: confirm containment remains independent.

### 7. Verification

- `./node_modules/.bin/tsc --noEmit`
- Focused Vitest run over the touched suites.
- Full `npm test` after inspecting the script (it is `vitest run`, no side effects).
- Report exact commands, results, skipped checks, and remaining risks.

## Non-goals

No container/VM/remote sandbox, no network isolation, no Hermes/Herdr re-enablement, no change to
verification, human review, or merge gates.
