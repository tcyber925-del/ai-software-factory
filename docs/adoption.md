# Adopting the Factory

This template gives a fresh repository the factory's coordination layer: the protocol contracts,
the deterministic verification gate, the portable skills, and the policies that stop agents from
self-authorizing correctness.

## What you get

| Asset | Purpose |
|---|---|
| `schemas/` | 8 machine-readable protocol contracts |
| `docs/` | Architecture, protocols, security, scheduling, repair, provenance, verification policy |
| `src/cli/`, `src/kernel/pipeline.ts` | The runnable `factory` command and the pipeline it composes |
| `.agents/skills/` | Portable Agent Skills — the operating guarantees |
| `.github/workflows/ci.yml` | The `contract` job: build, tests, schemas, docs, skill pack |
| `.factory/policies/` | Autonomy policy and local project policy template |
| `examples/` | An example Work Unit in human, wire, and plan form |
| `tests/`, `fixtures/` | **The factory's own suite. Delete both** — see step 4 |
| `templates/project/`, `templates/skills/` | Starting points for a new project and skills — see [the template's own README](https://github.com/tcyber925-del/ai-software-factory/blob/main/templates/project/README.md) |

## Requirements

- **Node 22 or newer.** Enforced by the factory and by `factory doctor`.
- **Git** with worktree support.
- **OpenCode** on `PATH`. Required to dispatch work.
- **Herdr** is optional. It is a preferred supported runtime, *not* a mandatory
  dependency; its absence is a warning, never a blocking error.
- **Hermes** is optional and unchecked. `factory doctor` does not report it, so
  verify `hermes --version` yourself if you intend to use it.

### If you use `factory verify`, define these scripts

`factory verify` shells out to five `npm run` targets in order: `format:check`, `lint`, `typecheck`,
`test`, `build`. Your adopting project must define the first three or the command exits `1` on the
first one. The factory's own repository does not define them, which is why `npm run verify` is the
working equivalent there and `factory verify` is not.

Treat `format:check` and `lint` as required signals, not placeholders. A script that runs and reports
success without checking anything turns the gate green without verifying anything, which is the exact
failure this policy exists to prevent.

Verify your environment:

```bash
npm ci
npm run build:cli
node dist/bin.js doctor          # reports healthy / degraded / blocked
```

`degraded` means dispatch can proceed but something is optional-missing.
`blocked` means a required capability is absent — fix before dispatching.

Then dispatch work:

```bash
node dist/bin.js work validate --work-units docs/work-units/PROJECT-001.plan.json
node dist/bin.js work run      --work-units docs/work-units/PROJECT-001.plan.json
```

`work run` exits `0` only when every Work Unit reached `ready`. See [cli.md](cli.md).

## Adoption steps

### 1. Use the template

```bash
gh repo create my-project --template <owner>/ai-software-factory
cd my-project
npm ci
```

### 2. Establish the gate before writing code

Configure branch protection on `main` so the `contract` job is **required**:

```
Settings → Branches → Add rule → main
  ☑ Require status checks to pass before merging
      required check: contract
  ☑ Require branches to be up to date before merging
  ☑ Do not allow bypassing the above settings (enforce on admins)
```

This is the step most often skipped, and it is the one that makes verification
real. Without it the gate is documentation, not enforcement.

### 3. Fill in the local project policy

Edit `templates/project/.factory/policies/project-policy.md` into your repository and record:

- protected branches;
- deployment authority;
- credential policy;
- your V1 exclusions.

Keep `AGENTS.md` at the repository root. It is the agent contract, and
`templates/project` does not replace it.

### 4. Separate the tool from the payload

**This repository is two things at once**, and keeping both in your project is a
real problem rather than untidiness.

| | Files | Keep? |
|---|---|---|
| **The tool** — the `factory` CLI you run | `src/`, `schemas/`, `examples/`, `templates/` | **Yes** |
| **The contracts you adopt** | `AGENTS.md`, `.factory/policies/`, `.agents/skills/`, `docs/`, `LICENSE` | **Yes** |
| **The factory's own test suite** | `tests/`, `fixtures/` | **No** |

Remove the factory's own suite. If you keep it, `npm test` collects *its* 362 tests
instead of yours, because `vitest run` globs `tests/` and that directory is already
occupied. Your verify gate then reports green for work it never did.

```bash
rm -rf tests fixtures
mkdir -p tests
```

Keep `src/`. That is the CLI, and `factory work run` needs it.

Then seed the layout. **Merge these into your existing files rather than copying over
them** — a blind `cp` replaces your dependencies, scripts, and name:

```bash
# greenfield: these are starting points
cp templates/project/tsconfig.json .

# brownfield: read them and take what applies
cat templates/project/package.json
cat templates/project/tsconfig.json

cp templates/project/.factory/policies/project-policy.md .factory/policies/
```

Then `npm install` to generate your own lockfile.

### 5. Make the CI gate yours

`.github/workflows/ci.yml` in this repository tests **the factory**. Left as-is it
will run the factory's checks against your repository, which is not the same thing as
testing your work.

Replace the steps with your project's build, tests, schemas, and documentation. Keep
the parts that are about *your* guarantees: schema validation if you ship schemas,
documentation presence, and whatever proves your own acceptance criteria.

The `contract` job name is referenced by branch protection. Keep the name, or update
the required check to match — otherwise the gate you configured is not the gate that
runs.

### 6. Author your first Work Unit

```bash
mkdir -p docs/work-units
cp examples/example-work-unit.md    docs/work-units/PROJECT-001.md
cp examples/example-work-unit.json docs/work-units/PROJECT-001.json   # the Work Unit alone
cp examples/example-plan.json      docs/work-units/PROJECT-001.plan.json  # what the CLI dispatches
```

The two JSON files differ deliberately. `example-work-unit.json` is the **Work Unit** — the wire
contract from `schemas/work-unit.schema.json`, which is also what Linear intake compiles to.
`example-plan.json` is a **plan**: an array whose entries wrap a Work Unit with the scheduling facts
the scheduler needs (`paths`, `dependsOn`, `contracts`, `runtimes`, `protectedResources`). The CLI
reads the plan form:

```bash
node dist/bin.js work validate --work-units docs/work-units/PROJECT-001.plan.json
```

Requirements, not providers:

```jsonc
{ "capabilities": ["coding", "testing"] }   // correct
{ "capabilities": ["run on opencode"] }     // wrong — provider, not requirement
```

### 7. Write skills for your project

```bash
cp -r templates/skills/project-verification .agents/skills/
```

Edit it to describe this repository's real build, test, and environment setup.
Skills stay portable: plain `SKILL.md` with a `name` and `description`, and no
factory registry metadata (`trust`, `owner`, `permissions`, `provenance`)
inside the skill.

## Adoption checklist

- [ ] The factory's own `tests/` and `fixtures/` are removed, so `npm test` runs **your** tests
- [ ] `npm test` runs your project's tests, not the factory's
- [ ] `.github/workflows/ci.yml` tests your project; the `contract` job name still matches branch protection
- [ ] `npm ci` succeeds on a fresh clone
- [ ] `npm run verify` passes (typecheck, CLI emit, tests)
- [ ] `node dist/bin.js doctor` reports at least `degraded`, ideally `healthy`
- [ ] Branch protection requires the `contract` job on protected branches
- [ ] Branch protection is enforced on admins
- [ ] `AGENTS.md` present at the repository root
- [ ] `.factory/policies/` reflects this project's real boundaries
- [ ] At least one example Work Unit authored
- [ ] `node dist/bin.js work validate` accepts it
- [ ] If you will use `factory verify`: `format:check`, `lint`, and `typecheck` scripts defined and meaningful
- [ ] No `node_modules/` or build output committed
- [ ] Secrets supplied by environment, never committed

## Two gaps to close in your own repository

Neither is fixed for you, and neither is caught by `npm run verify`:

1. **Declare the security signals on your plans.** `work run` refuses `untrusted` and
   `destructive` work, but only from signals you declare — it will not read the goal text and guess.
   A plan with no `risk` block is treated as `trusted`. See
   [security-policy.md](security-policy.md#how-risk-is-declared-and-what-that-means).
2. **`factory verify` runs your project's own scripts.** If it declares none of `verify`,
   `format:check`, `lint`, `typecheck`, `test`, or `build`, the command fails rather than reporting
   a vacuous pass. See [cli.md](cli.md).

---

## What the factory will not do for you

- **It will not verify for you.** The gate is deterministic and reproducible;
  interpreting evidence and judging scope is still a human responsibility.
- **It will not replace review.** A green `contract` run is necessary, not sufficient.
- **It will not enforce a control it has not composed.** A green run proves the code that *is*
  called behaves correctly. It says nothing about a control that exists but has no caller — the
  security gate being the live example.
- **It will not secure untrusted code.** A Git worktree is developer isolation.
  Higher-risk execution needs stronger isolation (see `docs/security.md`), and today the refusal
  is not applied at dispatch.
- **It will not enforce anything you did not turn on.** Branch protection is
  repository configuration, not something the code can assert.

## Non-goals

No hosted control plane, database, web dashboard, custom agent runtime, or
autonomous merge/release. See `README.md` for the full boundary.