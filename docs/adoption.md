# Adopting the Factory

This template gives a fresh repository the factory's coordination layer: the protocol contracts,
the deterministic verification gate, the portable skills, and the policies that stop agents from
self-authorizing correctness.

## What you get

| Asset | Purpose |
|---|---|
| `schemas/` | 8 machine-readable protocol contracts |
| `docs/` | Architecture, protocols, security, scheduling, repair, provenance, verification policy |
| `.agents/skills/` | Portable Agent Skills — the operating guarantees |
| `.github/workflows/ci.yml` | The `contract` job: build, tests, schemas, docs, skill pack |
| `.factory/policies/` | Autonomy policy and local project policy template |
| `examples/` | An example Work Unit in both human and wire form |
| `templates/project/`, `templates/skills/` | Starting points for a new project and skills |

## Requirements

- **Node 22 or newer.** Enforced by the factory and by `factory doctor`.
- **Git** with worktree support.
- **OpenCode** on `PATH`. Required to dispatch work.
- **Herdr** is optional. It is a preferred supported runtime, *not* a mandatory
  dependency; its absence is a warning, never a blocking error.

Verify your environment:

```bash
npm ci
factory doctor          # reports healthy / degraded / blocked
```

`degraded` means dispatch can proceed but something is optional-missing.
`blocked` means a required capability is absent — fix before dispatching.

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

### 4. Seed project layout

```bash
cp templates/project/package.json   .
cp templates/project/tsconfig.json .
mkdir -p src tests
cp templates/project/.factory/policies/project-policy.md .factory/policies/
```

Then `npm install` to generate your own lockfile.

### 5. Author your first Work Unit

```bash
cp examples/example-work-unit.md  docs/work-units/PROJECT-001.md
cp examples/example-work-unit.json docs/work-units/PROJECT-001.json
```

Requirements, not providers:

```jsonc
{ "capabilities": ["coding", "testing"] }   // correct
{ "capabilities": ["run on opencode"] }     // wrong — provider, not requirement
```

### 6. Write skills for your project

```bash
cp -r templates/skills/project-verification .agents/skills/
```

Edit it to describe this repository's real build, test, and environment setup.
Skills stay portable: plain `SKILL.md` with a `name` and `description`, and no
factory registry metadata (`trust`, `owner`, `permissions`, `provenance`)
inside the skill.

## Adoption checklist

- [ ] `npm ci` succeeds on a fresh clone
- [ ] `npm run build` and `npm test` pass
- [ ] `factory doctor` reports at least `degraded`, ideally `healthy`
- [ ] Branch protection requires the `contract` job on protected branches
- [ ] Branch protection is enforced on admins
- [ ] `AGENTS.md` present at the repository root
- [ ] `.factory/policies/` reflects this project's real boundaries
- [ ] At least one example Work Unit authored
- [ ] No `node_modules/` or build output committed
- [ ] Secrets supplied by environment, never committed

## What the factory will not do for you

- **It will not verify for you.** The gate is deterministic and reproducible;
  interpreting evidence and judging scope is still a human responsibility.
- **It will not replace review.** A green `contract` run is necessary, not sufficient.
- **It will not secure untrusted code.** A Git worktree is developer isolation.
  Higher-risk execution needs stronger isolation (see `docs/security.md`).
- **It will not enforce anything you did not turn on.** Branch protection is
  repository configuration, not something the code can assert.

## Non-goals

No hosted control plane, database, web dashboard, custom agent runtime, or
autonomous merge/release. See `README.md` for the full boundary.