# Using the Factory

Two guides, because greenfield and brownfield adoption are genuinely different
problems. Greenfield is a copy. Brownfield is a negotiation with a repository that
already exists and already has opinions.

Both were written by running the commands, not by reading the code. Where something
does not work, it says so.

## What the factory is

A coordination layer that dispatches AI engineering work into isolated Git
worktrees and refuses to call that work correct until something other than the
worker has checked it.

It is not an agent, an issue tracker, a CI replacement, or a hosted service.

## The one thing to understand

> The agent that produces an artifact cannot be the sole authority that declares
> it correct.

Everything else follows from that. A worker finishing its session, returning
`idle`, exiting cleanly, or opening a PR establishes nothing. Only independent
verification does.

In practice this means the factory will refuse work that looks fine:

```
factory: blocked — repair limit reached for PROJECT-001
  repair_exhausted PROJECT-001  verification=failed integration=blocked
```

That is the factory working, not failing.

## Before you start

| Requirement | Notes |
|---|---|
| Node 22+ | `factory doctor` checks this |
| Git with worktree support | `factory doctor` checks this |
| One runtime on `PATH` | `opencode` (direct) or `herdr` (managed) |
| A clean working tree | Uncommitted work is not isolated into a worktree |

```bash
npm ci
npm run verify     # typecheck + build the CLI + run the tests
node dist/bin.js doctor
```

`doctor` is read-only and reports per-check. `healthy` or `degraded` means you can
dispatch; `blocked` means fix it first. A missing *optional* runtime is a warning,
never an error.

---

# Greenfield adoption

## 1. Create the repository

```bash
gh repo create my-project --template tcyber925-del/ai-software-factory --public
cd my-project && git remote set-origin origin git@github.com:you/my-project.git
push -u origin main
```

Or start from the template package instead, which is lighter:

```bash
git clone https://github.com/you/my-project.git && cd my-project
# then copy the factory files in — see step 2
```

## 2. Establish the gate before writing code

This is the step everyone skips, and it is the one that decides whether the factory
enforces anything.

```
GitHub → Settings → Branches → Add rule → main
  ☑ Require status checks to pass before merging
      required check: contract
  ☑ Require branches to be up to date before merging
  ☑ Do not allow bypassing the above settings
```

Without this the verification gate is documentation, not enforcement. Everything
else in this guide is optional; this is not.

## 3. Confirm the environment

```bash
npm ci
npm run build:cli
node dist/bin.js doctor
```

Expected: `7 ok, 0 warning(s), 0 error(s)`.

If `project.files` fails, you are missing the five required files:

```bash
ls AGENTS.md package.json docs/architecture.md \
   docs/protocols.md docs/verification-and-merge-gates.md
```

## 4. Add the ignore rule

The factory writes `.factory/` into your repository — the durable event log and
dispatched worktrees. It is build residue, not source.

```bash
printf '.factory/\nnode_modules/\ndist/\n' >> .gitignore
git add .gitignore && git commit -m "chore: ignore factory runtime state"
```

**Verified:** without this, `git status` in a real brownfield project showed
`?? .factory/` as untracked, and the worktree directories inside it can be large.

## 5. Write your project policy

```bash
mkdir -p .factory/policies
cp templates/project/.factory/policies/project-policy.md .factory/policies/
```

Fill in the four placeholders: protected branches, deployment authority, credential
policy, and V1 exclusions. The non-negotiables section is inherited and should not be
edited — it is what makes this the factory rather than a prompt collection.

## 6. Seed your project layout

```bash
mkdir -p src tests docs/work-units
cp templates/project/tsconfig.json .
```

Generate your own lockfile with `npm install`, not `npm ci` — `ci` requires an
existing lockfile.

## 7. Write your first Work Unit

```bash
cp examples/example-work-unit.md docs/work-units/PROJECT-001.md
```

Requirements, never providers:

```jsonc
{ "capabilities": ["coding", "testing"] }   // correct
{ "capabilities": ["run on opencode"] }     // wrong — provider, not requirement
```

Now build the plan the CLI reads. This is a **plan**: an array wrapping the Work
Unit with its scheduling facts.

```json
[
  {
    "workUnit": {
      "id": "PROJECT-001",
      "goal": "Add a health endpoint",
      "repository": "you/my-project",
      "capabilities": ["coding", "testing"],
      "acceptance_criteria": ["GET /health returns 200 with a status field"]
    },
    "paths": ["src/health.ts", "tests/health.test.ts"]
  }
]
```

Declare `paths`. A Work Unit that does not declare what it touches is treated as
having uncertain ownership and serialized against everything.

Validate before dispatching:

```bash
node dist/bin.js work validate --work-units docs/work-units/PROJECT-001.plan.json
```

## 8. Dispatch

```bash
node dist/bin.js work run --work-units docs/work-units/PROJECT-001.plan.json
```

Then review the work and open the PR yourself. The factory records the integration
decision; it does not push branches or open PRs — there is no SCM adapter in V1.

## Greenfield checklist

- [ ] `npm ci` succeeds
- [ ] `npm run verify` passes
- [ ] `factory doctor` reports at least `degraded`
- [ ] Branch protection requires `contract` on `main`, enforced on admins
- [ ] `.gitignore` covers `.factory/`
- [ ] `.factory/policies/project-policy.md` placeholders filled
- [ ] A Work Unit authored and `work validate` accepts it
- [ ] No `node_modules/` or `dist/` committed

---

# Brownfield adoption

Brownfield is not a copy. You are adding guarantees to a repository that has
survived without them, and the risk is that you weaken it.

## 1. Run the doctor first, before changing anything

```bash
node /path/to/ai-software-factory/dist/bin.js doctor
```

Expect `project.files` to fail — a legacy repo has none of them. That is your
worklist, and nothing is broken yet.

## 2. Add the gate first

Same as greenfield. On an existing repository this is the higher-risk step, because
a required check that is slow or flaky will block your team. Run the workflow once
before turning on the requirement, and be honest with yourself about whether the
suite is trustworthy yet.

## 3. Make the factory usable without touching your source

```bash
printf '.factory/\n' >> .gitignore
```

Do **not** copy `schemas/` into your repository. The factory resolves its own
schemas; a stale copy in your repo would drift from the real contract.

## 4. Add only the files the factory requires

```bash
cp /path/to/ai-software-factory/AGENTS.md .
mkdir -p docs
cp /path/to/ai-software-factory/docs/{architecture,protocols,verification-and-merge-gates}.md docs/
```

Then **rewrite `docs/architecture.md` to describe your repository**, not the
factory's. `doctor` only checks the file exists; it cannot check that it is true.
An architecture document that describes the factory while sitting in a legacy
monorepo is worse than an honest stub.

The three required files are a contract, not documentation:

- `AGENTS.md` — what agents may and may not do here
- `docs/protocols.md` — the shapes you actually use
- `docs/verification-and-merge-gates.md` — what proves work is correct

## 5. Tell the factory how you verify

This is the step people miss, and it is the one that matters most.

**V1 hardcodes the verification check to `npm test`.** There is no flag to change it.
So:

- **If your repo runs `npm test`**, you are done — nothing to do.
- **If it does not**, `work run` will run `npm test` in the worktree, which will
  fail or do nothing useful. Add a `test` script to `package.json` that runs your
  real suite:

```jsonc
{ "scripts": { "test": "pytest -q" } }        // Python
{ "scripts": { "test": "go test ./..." } }    // Go
{ "scripts": { "test": "cargo test" } }       // Rust
```

**Verified limitation:** a brownfield repo whose tests run under `npm test`
(`node --test`) works end to end with no changes. A repo that does not needs this
shim, or the pipeline.

## 6. Write Work Units against your real surface

The `goal` is what the agent is asked to do; `paths` is what it is allowed to
touch. Keep `paths` tight and specific — it is how the scheduler knows two units
can run in parallel:

```json
[
  {
    "workUnit": {
      "id": "LEGACY-001",
      "goal": "Add input validation to the user signup handler",
      "repository": "you/legacy-app",
      "base_revision": "a1b2c3d",
      "capabilities": ["coding", "testing"],
      "acceptance_criteria": [
        "malformed email addresses return 400",
        "the existing signup test suite still passes"
      ]
    },
    "paths": ["src/auth/signup.ts", "tests/auth.signup.test.ts"]
  },
  {
    "workUnit": {
      "id": "LEGACY-002",
      "goal": "Document the auth flow in the developer guide",
      "repository": "you/legacy-app",
      "capabilities": ["documentation"],
      "acceptance_criteria": ["the auth section documents the signup path"]
    },
    "paths": ["docs/auth.md"],
    "dependsOn": ["LEGACY-001"]
  }
]
```

`base_revision` pins the starting commit so the resulting diff is unambiguous. For
brownfield work this matters much more than for greenfield — without it the diff
includes whatever else moved on `main`.

## 7. Understand what will serialize

The scheduler is conservative by design:

| Declared | Result |
|---|---|
| Disjoint `paths` | May run in the same batch, each in its own worktree |
| Overlapping `paths` | Serialized |
| `dependsOn` | Serialized, strictly ordered |
| **No `paths`** | Serialized against everything |

Two units touching `src/` at all will not run concurrently. Narrow the paths or
accept serialization.

## 8. Dispatch one unit first

Do not start with five units. Run one, read the event log, confirm the work landed
where you expected:

```bash
node dist/bin.js work run --work-units docs/work-units/LEGACY-001.plan.json
```

Read what happened:

```bash
cat .factory/events.jsonl | tail -20
```

## Brownfield checklist

- [ ] `factory doctor` run before any change, output read
- [ ] Branch protection requires `contract`, enforced on admins
- [ ] `.gitignore` covers `.factory/`
- [ ] The five required files present, and `docs/architecture.md` describes **your** repo
- [ ] `package.json` has a `test` script that runs your real suite
- [ ] First Work Unit uses `base_revision`
- [ ] `paths` are narrow and specific
- [ ] One unit dispatched and reviewed before scaling up

---

# What `work run` actually does

```
validate → plan → select runtime → dispatch → verify (independent)
        → repair if verification failed, bounded → integration record
```

Every stage appends to `.factory/events.jsonl` as it happens, so an interrupted run
stays inspectable rather than becoming a silent gap.

Two invariants are enforced in code, not documented and hoped for:

**Readiness comes only from independent verification.** The integration gate
consumes a `VerificationResult`; nothing derives readiness from runtime status.

**Verification runs against the executed worktree**, not your checkout. This is
what stops a runtime writing anywhere and still passing. A runtime that reports no
worktree blocks rather than falling back.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every Work Unit reached `ready` |
| `1` | Blocked, unknown command, missing file, bad flag, or no arguments |

A blocked run never exits `0`. If you script around this, that is the contract.

## Useful flags

| Flag | Use |
|---|---|
| `--runtime <name>` | Restrict to one runtime. An unknown name is an error, never a silent substitution |
| `--json` | Machine-readable output |
| `--max-parallel <n>` | Bound concurrency inside one batch |
| `--verify-in repo` | Verify your checkout instead of the worktree |
| `--debug` | Include a stack trace on failure |

## Reading the result

```
factory: ready — all work units passed independent verification and the integration gate
batches: [["LEGACY-001"],["LEGACY-002"]]
  ready            LEGACY-001  verification=passed integration=ready (verification_passed)
  ready            LEGACY-002  verification=passed integration=ready (verification_passed)
  not dispatched    LEGACY-003  (blocked earlier in the plan)
```

`not dispatched` means an earlier unit blocked. Those units never ran, so they
produced no execution evidence at all.

---

# Testing the factory

## The suite

Use `npm run verify`, **not** `factory verify`. The latter invokes `format:check`,
`lint`, and `typecheck`, which this repository does not define, so it always fails.

```bash
npm run verify
```

That is exactly what CI runs: typecheck, build the CLI, smoke-run it, run the tests.
**Expected: 301 tests across 20 files.**

If you see a much larger number, something is collecting tests you did not intend.
A stale `.worktrees/` entry does exactly this, which is why `vitest.config.ts` now
scopes discovery to `tests/`.

## Test that it refuses to pass

The strongest property is what it does when work looks fine but is not.

```bash
# Blocked: the runtime reports idle, but there is nothing real to verify.
node dist/bin.js work run --work-units plan.json --runtime fake
# -> factory: blocked — repair limit reached

# Green: identical runtime behaviour, verification pointed at a real tree.
node dist/bin.js work run --work-units plan.json --verify-in repo
# -> factory: ready
```

Same runtime behaviour, different verification target, opposite outcome. That
difference *is* the second invariant.

## Test that it never self-authorises

A repair attempt is judged only by the verification function, never by the worker
that performed it. `tests/repair.test.ts` and `tests/pipeline.test.ts` cover this.

## Test scheduling safety

Two units with overlapping `paths` must not run together, and a blocked unit must
halt the batches that depend on it. Both are covered in
`tests/scheduler.test.ts` and `tests/pipeline.test.ts`.

---

# Known limitations

Read these before you rely on the factory.

| Limitation | Impact |
|---|---|
| **Verification is hardcoded to `npm test`** | Repos verifying with anything else need the `package.json` shim described above |
| **No SCM adapter** | The factory never opens a PR or pushes a branch. You close the loop |
| **`init`, `work create`, `work status`, `workspace list` are not implemented** | The specified CLI surface is narrower than documented in the plan |
| **The security gate is not on the dispatch path** | `src/security/` classifies risk and would refuse `untrusted`/`destructive` work, but `work run` never calls it. **Such work currently runs.** See below |
| **Linear intake is not on the dispatch path** | `src/adapters/linear/` ships and is tested, but no CLI command reads it. Use the library directly |
| **`factory verify` is unusable** | It invokes `format:check`, `lint`, and `typecheck`; this repository defines none, so it always fails. Use `npm run verify` |
| **`factory doctor` omits `hermes`** | Reports `opencode` and `herdr` only, so a Hermes problem surfaces at dispatch, not diagnosis |
| **`docs/architecture.md` is not checked for truth** | `doctor` verifies presence, not accuracy. You own this |
| **Nested dispatch is refused** | Dispatch from the primary repository root, not from a worktree |

## The security gate is implemented but NOT applied

This is the most important limitation in this guide.

`src/security/risk.ts` implements risk classification and admission. Given a Work
Unit that consumes untrusted content, it returns:

```json
{ "risk": "untrusted", "minimumIsolation": "sandbox",
  "providedIsolation": "none", "adequate": false }
```

`adequate: false` means `evaluateSecurityGate` refuses admission.

**But `factory work run` never calls it.** `src/kernel/pipeline.ts` does not import
the security module at all. Verified: a Work Unit whose goal is "execute a script
fetched from an untrusted URL at runtime" was dispatched, the runtime was invoked,
repair ran twice, and the event log contained **zero** security events.

So today, higher-risk work is *not* refused at dispatch. The control exists, is
tested, and is documented — and is not on the path. Treat this as a known gap, not
as a guarantee, and do not rely on the factory to stop you from running untrusted
code.

## A Git worktree is not a sandbox

A worktree separates files. It does not separate privileges, processes, or the
host. Treat it as developer isolation. Because no adapter offers sandbox
isolation, composing the gate today would **refuse** all higher-risk work outright
rather than run it — which is the intended behaviour, but it means adopting the
gate is a real decision with a real cost.

---

# Where to look next

| Question | Document |
|---|---|
| How does the pipeline work? | [`docs/cli.md`](cli.md) |
| What can an adapter do? | [`docs/runtime-adapters.md`](runtime-adapters.md) |
| Why is readiness gated? | [`docs/execution.md`](execution.md) |
| Why does it serialize? | [`docs/scheduling.md`](scheduling.md) |
| What happens on failure? | [`docs/repair.md`](repair.md) |
| Can I reconstruct a run? | [`docs/provenance.md`](provenance.md) |
| What about untrusted code? | [`docs/security-policy.md`](security-policy.md) |
| Full adoption path | [`docs/adoption.md`](adoption.md) |
| Why MIT? | [`docs/licensing.md`](licensing.md) |