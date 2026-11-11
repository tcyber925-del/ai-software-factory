# WU-92-02 — Consolidated design and implementation plan

**Mode:** ARCHITECT → PLAN  
**Status:** Proposed — design and sequencing only. **No implementation, no code/config/runtime changes, and no new GitHub issues have been created.**  
**Repository:** `tcyber925-del/ai-software-factory`  
**Baseline references:** `AGENTS.md`, `docs/security-policy.md`, `docs/security.md`, `docs/runtime-adapters.md`, corrected `docs/security/subprocess-inventory.md` (WU-92-01), issues #89/#90/#92 (and related #80/#21/#91).  
**Prepared:** 2026-11-11 (local planning artifact; uncommitted)

> **Approval gate:** This document is a proposal. Explicit Founder/security approval is required before any security-boundary implementation begins. #90 interim dispatch restrictions remain authoritative.

The recommendation is to implement #92 as a fail-closed process and credential policy layer, not as a partial sandbox. Use the corrected subprocess inventory as the baseline, make environment access explicit by process role, connect credential requests to dispatch admission, and preserve #90’s interim restrictions. Defer OS-enforced sandboxing and network enforcement to separate work.

This follows the factory principle that the system around an agent—not the agent itself—must control tools, execution boundaries, verification, and completion. [SOURCE: Software Factories, Light and Dark.md]

The factory research also emphasizes building gates before increasing agent volume. [SOURCE: How to Build an AI Software Factory: Agents That Open, Review, and Merge PRs]

## 1. What we know and what remains unproven

- [SOURCE] The corrected WU-92-01 report identifies 13 subprocess launch paths across Git helpers, OpenCode, Hermes, Herdr, verification, doctor probes, CLI passthrough, and mutation scripts. The inventory is a local audit artifact; it has not been independently verified by executing those processes.
- [SOURCE] The report found that most launch paths do not specify an `env` option, so Node’s normal child-process environment inheritance applies unless a caller or runtime changes the behavior. The mutation harness constructs an environment from `process.env` but removes only `FORCE_COLOR` and `NO_COLOR`.
- [SOURCE] The inventory distinguishes potential secret exposure through inherited environments, command arguments, and captured output. It does not establish that a secret was actually exposed in a run.
- [SOURCE] `docs/security-policy.md` says production credentials are never granted by the factory, while development and staging scopes require an explicit request. It also records that the current dispatch path does not yet pass credential inputs into the security gate.
- [SOURCE] #92 explicitly excludes OS-enforced sandbox containment and network enforcement. #90 remains binding, and it is not technically enforced merely because it is documented.

Key distinction: environment allowlisting can reduce accidental exposure; credential admission can reject unauthorized requests. Neither establishes process containment, filesystem isolation, or network isolation.

## 2. Proposed architecture

Work Unit + dispatch context → Declared risk, requested credential scope, selected runtime → **Security admission** (validate request and policy; missing or invalid inputs fail closed) → **Shared process-policy layer** (process role → explicit environment rules → safe command/evidence handling) → **Supported** (agent, verification, repair, and approved helper subprocesses) / **Blocked or excluded** (unsupported paths and roles without an explicit policy) → **Secret-safe evidence + independent verification** (record decisions and variable names, never secret values; test the real process boundaries).

[INFERENCE] This is the smallest useful architecture that addresses #92 without pretending to solve the broader containment problem.

### Design decisions proposed

| Decision | Recommendation | Trade-off |
| --- | --- | --- |
| Policy ownership | One shared process-policy contract, with explicit per-role rules | More initial wiring; less policy drift between adapters |
| Default environment | Allowlist, not whole-host inheritance | Some tools may need additional documented variables |
| Missing policy | Refuse execution or explicitly mark the path unsupported | Can temporarily block workflows that have not been classified |
| Credential scope | Validate at admission; production scope always denied | Requires distinguishing authorization from actual secret delivery |
| Command/output evidence | Redacted, bounded, secret-safe representation | Less raw detail in logs; safer persisted evidence |
| Network and sandbox | Separate future work | This issue will not claim stronger isolation than it provides |

### Important design constraint

Do not assume that every environment variable can be removed without breaking a runtime. The exact required variables must be discovered and tested for each process role. But compatibility is not a reason to silently fall back to the complete parent environment: an unclassified path must be explicitly blocked or receive a reviewed, narrowly scoped exception.

## 3. Proposed work-unit sequence

The sequence below is designed to avoid repeated conversational review. Each unit still runs its relevant automated checks; collect results and perform one consolidated independent review at the end.

### 01 — Design: WU-92-02 — Finalize the process-policy contract
**Proposed.** Define process roles, environment rules, credential-scope admission, fail-closed behavior, evidence redaction, and treatment of unsupported subprocess paths. Resolve the interface and compatibility questions below before coding.

- **Acceptance:** Every one of the 13 inventory entries has a proposed disposition; the policy contract and error behavior are specified; tests can distinguish allowed, refused, and unsupported execution; sandbox and network claims are explicitly excluded.
- **Verification:** Review against #92, #90, `AGENTS.md`, `docs/security-policy.md`, and the corrected inventory. No code execution is required for this design unit.

### 02 — Core: WU-92-03 — Implement the shared process-policy contract
Create the smallest shared policy mechanism and its unit tests, using the approved design. It should accept a known process role and explicit inputs, produce a deterministic allow/refuse result, and construct only the environment permitted for that role.

- **Acceptance:** Unknown roles and missing policies fail closed; disallowed environment variables are excluded; the complete parent environment is not passed by default; tests assert outcomes without printing real secrets.
- **Dependency:** WU-92-02 approved.

### 03 — Admission: WU-92-04 — Wire credential policy into dispatch admission
Connect the declared credential request to the actual admission path. Preserve the existing production-credential prohibition and make missing, malformed, and unauthorized requests explicit refusals.

- **Acceptance:** Pipeline-level tests prove the agent does not start on refusal; absent credential policy cannot become permissive; production requests are refused even when requested or approved; durable decision events record scope and reason without secret values.
- **Dependency:** WU-92-02 approved. Coordinate with WU-92-03 to avoid competing interfaces.
- **Important:** Admission authorization is not proof that credential material is safely delivered. Any material delivery path must be identified and tested separately.

### 04 — Integration: WU-92-05 — Apply policy to supported subprocess paths
Wire the shared policy to agent, verification, repair, and helper subprocesses. Use the 13-row inventory as the reconciliation checklist. Unsupported paths must be explicitly blocked or documented with an approved exception.

- **Acceptance:** Every inventory row has a testable disposition; covered paths use explicit environment policy; tests demonstrate that representative sensitive variables do not cross prohibited boundaries; runtime tests verify the actual child environment rather than only the policy helper.
- **Dependency:** WU-92-03 and WU-92-04 interfaces stable.
- **Special case:** The `npm run` CLI passthrough and doctor probes need deliberate decisions; they must not be silently treated as ordinary agent subprocesses.

### 05 — Evidence: WU-92-06 — Harden evidence and documentation
Correct command and output handling where needed, including separate exposure paths for command arguments and captured output. Document the actual guarantees and remaining limitations.

- **Acceptance:** Tests prove secrets are not present in persisted events, test output, or logs for covered paths; commands are represented safely; documentation states that network enforcement and OS-enforced sandboxing are not delivered by #92.
- **Dependency:** Can proceed alongside WU-92-05 only after the evidence contract is agreed.

### 06 — Closeout: WU-92-07 — Consolidated security verification and review
Run the focused tests, TypeScript typecheck, and then broader verification only after inspecting the scripts for side effects. Reconcile code, tests, documentation, and the subprocess inventory.

- **Acceptance:** Each #92 criterion has an evidence reference or a recorded blocker; all launch paths have a disposition; exact commands and results are recorded; an independent review finds no unsupported security claims; any remaining defects are grouped into a bounded remediation batch.
- **Dependency:** Implementation units complete. This unit must not be performed solely by the agent that implemented the changes.

These identifiers are proposed planning identifiers only. They are not GitHub issues, and no issue has been created for them.

## 4. Verification and evidence plan

Use the repository’s existing scripts (recheck against the working tree before execution):

- `npm run build` — TypeScript no-emit check
- `npm run build:cli` — CLI build/typecheck configuration
- `npm test` — Vitest suite
- `npm run verify` — build, CLI build, and tests
- `npm run mutations` — mutation harness

For each implementation unit, capture:

1. Commit SHA and initial/final Git status.
2. Exact commands and exit codes.
3. Test names and results, including relevant negative cases.
4. Evidence that child processes receive the intended environment.
5. Secret-safe logs and decision events.
6. Any skipped check and the reason.
7. Deviations from the approved design.

Do not run mutation or other potentially side-effecting checks automatically just because a script exists. Inspect the script and decide whether it is safe first.

The final review should examine the entire set of changes together rather than repeatedly re-reviewing the same findings after every session.

## 5. The five-gate assessment

| Gate | Current assessment | What this plan changes |
| --- | --- | --- |
| Intake | Not the primary blocker in this issue | No scope expansion or autonomy increase |
| Isolation | Weakest overall security gate | Explicitly remains unresolved by #92 |
| Tools/context | Major gap: subprocess environment and credential policy | Explicit process roles and policy wiring |
| Verification | Existing checks are available, but they do not prove containment | Boundary-specific tests plus independent review |
| Merge/review | Human review remains required | No change to the merge gate |

The weakest gate for this specific work is isolation, with tools/context as the immediate target of #92. #92 can reduce uncontrolled environment and credential exposure, but cannot make a Git worktree a security sandbox.

## 6. Dependencies and stop conditions

The work remains constrained by:

- [#90 — Interim dispatch restriction](https://github.com/tcyber925-del/ai-software-factory/issues/90): OpenCode only for trusted, low-risk autonomous work, automated verification, human review of every PR, and no prohibited dispatch.
- [#91 — Runtime isolation attestation](https://github.com/tcyber925-del/ai-software-factory/issues/91): useful runtime-bound evidence, but not proof of adversarial containment.
- [#80 — Observed worktree escape](https://github.com/tcyber925-del/ai-software-factory/issues/80): remains a separate containment concern.
- [#21 — Broader security/isolation hardening](https://github.com/tcyber925-del/ai-software-factory/issues/21): must be reconciled with future sandbox and network work.
- [#92 — Credential and environment boundary](https://github.com/tcyber925-del/ai-software-factory/issues/92): the scope being designed here.

Stop and prepare a Change Request if implementation requires an unapproved credential-delivery mechanism, a new security architecture, a permissive fallback, a change to the interim dispatch policy, or a claim of containment that the tests cannot establish.

## 7. Repository state discrepancy

The reported local commit `65da35139ab426a65c5d9769a46bc8c8cfbff172` (“Add subprocess and environment inventory documentation”) and the corrected unstaged inventory changes must be preserved.

Do not reset, amend, publish, or otherwise reconcile that commit as part of this plan. Before implementation, record the actual local branch, HEAD, upstream relationship, staged/unstaged changes, and untracked files. The inventory’s local status must be reconciled with the working tree without discarding either the commit or the corrections.

## Consistency check

- **Checked against:** `AGENTS.md`; `docs/security-policy.md`; `docs/security.md`; `docs/runtime-adapters.md`; issues #89/#90/#92 and referenced #80/#21/#91; corrected WU-92-01 report (`docs/security/subprocess-inventory.md`); factory research sources cited above.
- **Conflicts:** Network-enforcement scope explicitly split out of #92; this plan preserves that decision and does not treat environment policy as sandbox containment.
- **Affected:** #92 implementation scope; #90 unchanged; #80/#21 remain separate. If adopted, store canonical design in an explicitly approved location (e.g. this file after approval, or existing ADR/spec convention) and link work-unit drafts to it.
- **Not checked:** current local checkout beyond recorded state, exact corrected inventory contents beyond prior audit, every source line in all callers at runtime, full test behavior, actual runtime env contents, adversarial containment, and available OS/network enforcement capabilities.

## Open questions / proposed selections (pending Founder approval)

1. **Credential material (proposed selection):** **Admission-only in #92.** Implement credential-scope admission/authorization decisions and refusal semantics first; do **not** forward credential material (including via env vars) unless/until a concrete, narrowly scoped, separately reviewed and tested delivery path is explicitly approved. Production credentials are never granted. (This resolves the core contract question for implementation sequencing, but remains **unapproved** for security-boundary implementation until explicit Founder/security approval is recorded.)
2. **Unsupported subprocesses (proposed selection):** **Block/fail closed by default.** Any unclassified subprocess path, and paths without an explicit role policy (including CLI passthrough and doctor probes unless narrowly excepted), must be refused or explicitly marked unsupported — never silently inherited from the full parent environment.
3. **Canonical home (proposed):** Keep this design in `docs/security/wu-92-02-process-policy-design.md` as the working canonical artifact pending confirmation; if the repo adopts an ADR/spec convention for this decision, migrate/link without changing substance.

## Assumptions

- #92’s approved scope split remains authoritative.
- Production credentials are never granted by the factory.
- No implementation begins until **explicit Founder/security approval** is recorded for this security-boundary implementation (including the proposed selections above). Design finalization below is planning only.
- The local commit and corrected inventory are user work and must be preserved.
- Full sandbox and network enforcement will be designed as separate security work, not quietly folded into #92.

## Decision ledger

- **Decided (external):** #90 interim dispatch restriction; #92 scope split (process/environment + credential policy vs future sandbox/network enforcement); streamlined implementation-first workflow with consolidated independent review.
- **Proposed (pending approval):** admission-only credential handling in #92 (no material forwarding without separately approved tested path); fail-closed default for unclassified/unsupported subprocess paths; `docs/security/` as working canonical home.
- **Pending:** explicit Founder/security approval to begin implementation; final confirmation of proposed selections and canonical home; reconciliation plan for local `65da351` + unstaged inventory corrections.
- **Rejected:** Treating worktrees or runtime attestations as sandbox proof; claiming #92 provides network enforcement; weakening the human review gate; permissive fallback to full parent environment for unclassified paths.

## 8. WU-92-02 design finalization (proposed, pending approval)

This section finalizes the **design contract** for #92 without implementing it. All dispositions are source/inventory-based (corrected `docs/security/subprocess-inventory.md`, SP-01–SP-13); runtime behavior remains unverified unless separately tested in implementation.

### 8.1 Process-policy contract (shared, fail-closed)

**Inputs (deterministic, explicit):**
- `processRole` (enum/string): known role bound to an approved launch boundary (see §8.4). Unknown/missing role → **refuse**.
- `workUnitId` / execution context (when applicable), selected runtime, cwd, command identity/class (fixed vs caller-supplied), and purpose.
- Declared `risk`/admission context and requested `credentialScope` (e.g. none/dev/staging/prod, as modeled) — **authorization input only** under the proposed admission-only selection.
- Optional approved exception record (explicit, reviewed, scoped) for narrowly justified compatibility cases.

**Outputs (no secret values):**
- `decision`: `allow | refuse | unsupported` with stable `reasonCode`.
- `effectiveEnv`: explicit allowlisted key/value set (or empty) constructed by policy for `allow`; **never** the full inherited `process.env` by default.
- `constraints`: timeout/kill/buffer/output-capture/redaction requirements applicable to the role.
- `evidence`: redacted/safe representation for audit (role, reason, variable **names** only when necessary, command class/summary — no secret values, no raw sensitive args/output).

**Fail-closed rules:**
- Unknown role, missing policy, missing required inputs, malformed credential scope/request, or inability to construct a compliant env → `refuse` or `unsupported` (never permissive execution).
- Unclassified/unsupported inventory paths must not execute with inherited ambient env.
- Production credential scope is always denied regardless of request/approval state.

### 8.2 Credential admission (proposed: admission-only)

- **Precondition:** credential requests are evaluated at security admission/dispatch integration (WU-92-04 design target) before agent start for covered paths.
- **Allowed scopes (policy intent):** `none` default; dev/staging only if explicitly requested and authorized by policy — but **material delivery is out of scope for #92** under proposed selection (no env injection/forwarding implemented without separate approved tested mechanism).
- **Denied:** production (always), malformed/ambiguous scope, missing policy/context, or any request that cannot be proven compliant.
- **Audit:** durable decision records scope requested, scope granted/denied, role/path, and reason codes; **never** record secret names/values/material. Admission success ≠ safe delivery.

### 8.3 Environment, command, and evidence safety rules (design)

- **Environment:** default-deny inheritance. Start from empty/minimal base; allowlist only variables required for the role (to be discovered/tested in implementation, e.g. PATH/HOME/locale/TMPDIR/git/runtime-specific needs as justified) — document per role. Exclude known secret-bearing classes where feasible; never copy full parent env.
- **Command/args:** prefer fixed argv; treat caller/task-derived args and prompts as sensitive. Verification evidence must use safe command representation/redaction where args may carry secrets (SP-06 exposure path).
- **Output/evidence:** bound and redact captured stdout/stderr/evidence/events/logs; separate handling for command-arg exposure vs output exposure; never persist secret values. Record only what is necessary for audit/diagnosis.
- **Lifecycle:** specify timeout, termination, and (where feasible) process-tree handling per role; document gaps (e.g. SP-03 child-only SIGKILL) as unverified/limited until hardened and tested.
- **Containment claims:** explicitly out of scope for #92 (no sandbox/network enforcement claim).

### 8.4 Inventory disposition (SP-01–SP-13), proposed

| SP | Proposed role | Proposed disposition | Env policy (target) | Credential material | Evidence/arg/output notes | Priority / deps |
|---|---|---|---|---|---|---|
| SP-01 `src/adapters/git/changes.ts:30` | `git.read_status` (helper) | **Supported (cover)** | Explicit minimal allowlist for `git status --porcelain` in repo/worktree cwd | None | Parse stdout only; no secret args; bound errors | P2; role policy + tests |
| SP-02 `src/adapters/git/snapshot.ts:26,27` | `git.read_snapshot` (helper) | **Supported (cover)** | Explicit minimal allowlist for `git rev-parse/status` | None | Repo state only; no secret args | P2 |
| SP-03 `src/adapters/opencode/process.ts:50` | `runtime.opencode.command` | **Supported but high-risk (cover, constrained)** | Explicit per-operation allowlist; no full inherit | **None by #92 admission-only** (separate tested path required for any future delivery) | Args/prompts may be sensitive; temp-file output captured — require redaction/bounds in evidence; process-tree limits noted | P0/P1; core runtime path |
| SP-04 `src/adapters/hermes/process.ts:33` | `runtime.hermes.command` | **Conditionally supported (subject to #90/runtime policy)** | Explicit allowlist; minimize env | None by #92 | Prompt/task may appear in argv; normalize/redact evidence | P1; respect #90/Hermes restrictions |
| SP-05 `src/adapters/herdr/process.ts:17` | `runtime.herdr.command` | **Conditionally supported (subject to #90/runtime policy)** | Explicit allowlist; add timeout/termination requirements | None by #92 | Control/task data in args/output possible | P1; respect #90/Herdr restrictions |
| SP-06 `src/adapters/verification/shell.ts:31` | `verification.shell` (independent verifier) | **Supported (cover, hardened)** | Explicit allowlist for configured checks; no ambient secret inheritance by default | None by #92 | **Command+args and tailed output** captured in evidence — must support safe representation/redaction and bounds | P0; security-sensitive evidence path |
| SP-07 `src/doctor/probe.ts:98` | `doctor.git_probe` | **Blocked by default until explicit policy/exception** (recommended) | Minimal allowlist only if excepted; otherwise refuse | None | Repo/branch state surfaced in report | P2; low value to inherit broadly |
| SP-08 `src/doctor/probe.ts:108` | `doctor.git_probe` | **Blocked by default until explicit policy/exception** | Minimal allowlist only if excepted | None | Version output only | P3 |
| SP-09 `src/doctor/probe.ts:138` | `doctor.runtime_version_probe` | **Blocked by default until explicit policy/exception** | Minimal allowlist/PATH-only if excepted | None | Executes external CLIs from PATH | P2 |
| SP-10 `src/doctor/probe.ts:161-169` via SP-03 | `doctor.runtime_dispatch_probe` | **Blocked by default** (high sensitivity; `--probe` opt-in in UX but must remain policy-gated, #90-aware) | If ever excepted: strict allowlist, redaction, no credential material, explicit operator intent | None | Executes runtime with prompt in inherited env today; refuse unless narrowly approved/tested | P0 to keep blocked |
| SP-11 `src/cli/index.ts:297,318` | `cli.project_verify_script` (project-defined) | **Blocked by default for policy-enforced contexts; requires explicit decision/exception** (cannot be treated as ordinary agent subprocess) | If excepted: explicit, reviewed env contract; prefer isolated/declared context | None by #92; scripts may self-access env/services (risk) | stdout/stderr captured by API (not surfaced by `factoryVerify` in source) but transient; project-defined arbitrary actions | P1; trust-boundary decision required |
| SP-12 `scripts/mutation/evaluate.mjs:141` | `dev.mutation_suite` (supporting/dev) | **Excluded from production dispatch policy; dev-only documented path** (harden if used in sensitive CI) | Today derived from `process.env` minus 2 vars — must not be treated as compliant allowlist; define dev policy or gate usage | None | No stdout/stderr captured; tests may spawn/read env | P3 (dev) |
| SP-13 `scripts/mutation/scratch.mjs:100` | `dev.mutation_git_init` (supporting/dev) | **Excluded from production dispatch policy; dev-only** | Minimal/inherited acceptable only as documented dev utility; not a factory dispatch path | None | Output ignored | P3 (dev) |

**Reconciliation:** all 13 inventory rows have an explicit proposed disposition (cover, conditionally cover, blocked-by-default pending exception, or excluded dev-only) — satisfying the WU-92-02 design acceptance target pending review/approval.

### 8.5 Verification expectations for implementation (design)

- Unit tests for policy: allow/refuse/unsupported, unknown role/missing inputs, env allowlist construction (no full inheritance), no secret values in outputs.
- Admission/pipeline tests: refusal before agent start; production denied; absent policy not permissive.
- Integration/runtime tests per covered role: child receives only intended env (representative sensitive vars absent); covered paths reconciled to inventory.
- Evidence tests: command/arg/output redaction and bounds; no secrets in persisted events/logs/test output for covered cases.
- Record exact commands, exit codes, and deviations; run broader/mutation checks only after side-effect inspection.

**Design completion status:** WU-92-02 design finalization **proposed** (this document).

## 9. Implementation status (local, uncommitted, partial)

**Approval recorded in session context:** user approved proceeding with proposed selections and implementation steps (admission-only credential handling, fail-closed unsupported paths). Independent review, exact consolidated verification, and human merge/release gates remain required.

### Implemented
- **WU-92-03:** shared process-policy contract (`src/security/process-policy.ts`) and exports/tests (`tests/process-policy.test.ts`): deterministic `allow|refuse|unsupported`, known roles, explicit allowlisted env construction (no full host inheritance), production credential scope denied, dev/staging material forwarding refused by policy, unsupported/excluded roles fail closed, evidence carries key names only.
- **WU-92-04:** dispatch admission wiring (`src/kernel/scheduler.ts`, `src/kernel/pipeline.ts`) passes declared credential requests to security gate pre-dispatch; pipeline tests verify refusal before agent start and durable secret-safe `credential_access` decisions.
- **WU-92-05 (partial):** explicit policy-derived env / fail-closed enforcement applied to covered paths and key runners/adapters — SP-01/SP-02 git adapters, SP-03 OpenCode runner+runtime wiring, SP-04/SP-05 Hermes/Herdr default runners, SP-06 verification shell runner; SP-07–SP-10 doctor probes constrained/refused per role policy, SP-11 CLI `factory verify` blocked by default; env-isolation tests added (`tests/subprocess-env-isolation.test.ts`). Some existing tests reconciled to intentional fail-closed behavior (e.g. CLI verify). Exhaustive 13-row call-site audit, exception handling, broader integration coverage, and full regression reconciliation remain.
- **WU-92-06 (partial):** redaction/bounding utilities (`src/security/redaction.ts`), verification evidence hardened (safe command/arg representation + redacted/bounded output tails), runtime prompt events sanitized/bounded in OpenCode/Herdr adapters. Comprehensive persisted-event/log/output redaction coverage and full documentation reconciliation remain.

### Actual guarantees (current, evidence-limited)
- For covered/default-enforced paths above: subprocesses receive explicit allowlisted environments (not full inherited host env) or are refused; representative secret vars shown absent in targeted tests (`tests/subprocess-env-isolation.test.ts`). Credential admission is authorization-only in this implementation path (no material forwarding by policy). Evidence helpers provide best-effort redaction/bounding, not proof of secret absence.
- Source audit (this session): `src/` subprocess launch sites reviewed for explicit env/policy enforcement or policy-gated refusal; dev-only mutation scripts (SP-12/13) remain excluded from production dispatch policy per design.

### Explicit non-guarantees / remaining limits
- **No OS-enforced sandbox, no network/egress enforcement, no containment claim** (#92 out of scope; #80/#90 still relevant). Worktrees/attestation are not sandbox proof.
- Not all call paths are runtime-verified in adversarial conditions; broader integration/CI verification and independent security review required.
- Behavior changes (e.g. SP-11 CLI verify refusal, SP-09/SP-10 doctor probe refusals) require approved exceptions and/or UX/docs alignment if different behavior is desired.
- **WU-92-07 verification (local, this worktree):** `tsc --noEmit`, `npm run build`, `npm run build:cli` exit 0; targeted policy/runtime/pipeline/containment/doctor/cli/env-isolation suites passed (see session evidence); `npm test` reported **750 passed / 5 failed** (1 failed file: `tests/mutation-runner.test.ts`, scratch Vitest module-resolution/corpus-eval issues in this environment) — not claimed green/regression-free without clean rerun. Not merge-ready.