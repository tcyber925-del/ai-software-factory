# Project template

Starting points for a repository that adopted the AI Software Factory.

**These files are not a drop-in replacement for your `package.json` or `tsconfig.json`.**
Read them and take what applies. Copying `package.json` over an existing one replaces
your name, your dependencies, and your scripts.

## What belongs in your project

| | Files | Keep? |
|---|---|---|
| The `factory` CLI | `src/`, `schemas/`, `examples/`, `templates/` | Yes |
| The contracts you adopt | `AGENTS.md`, `.factory/policies/`, `.agents/skills/`, `docs/`, `LICENSE` | Yes |
| The factory's own test suite | `tests/`, `fixtures/` | **No — delete these** |

## Why you must delete `tests/` and `fixtures/`

This template ships the factory's own 362-test suite at `tests/`. If you keep it, a
bare `vitest run` collects **those** tests instead of yours — your verify gate goes
green for work it never did, and you pay for 362 irrelevant tests on every push.

```bash
rm -rf tests fixtures && mkdir -p tests
```

Then write your own tests in `tests/`.

## Starting points

| File | Use it for |
|---|---|
| `package.json` | A `verify` script that chains your build and tests. Keep your own dependencies |
| `tsconfig.json` | Strict TypeScript defaults: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| `.factory/policies/project-policy.md` | Copy to `.factory/policies/` and fill in the four placeholders |

## What this template does not give you

- **A CI workflow that tests your project.** The factory's own workflow tests the
  factory. Rewrite the steps; keep the job name if branch protection requires it.
- **A test suite.** Deliberately. That is yours to write.
- **An installable package.** The factory is not published to npm; `package.json`
  carries `"private": true` so it can never be installed by accident. Vendor it by
  cloning, or keep it as a template.