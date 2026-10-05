---
name: git-workflow
description: Create branches and commits with traceable Work Unit identity and no direct protected-branch writes.
---

# Git Workflow

Use `docs/protocols.md` for traceability and `docs/verification-and-merge-gates.md` for the gate.

## Rules
- Name branches with the Work Unit identifier, e.g. `FCT-006-execution-slice`.
- Reference the Work Unit id in the commit message so the commit is traceable to its purpose.
- Never commit directly to a protected branch. Integration happens through a pull request.
- Do not force-push, rewrite history, or delete a branch that has been reviewed.
- Keep a commit focused on one Work Unit. Unrelated changes make scope review impossible.
- Never weaken or bypass a required CI check to make a push succeed.

## Before pushing
- The change builds and its tests pass.
- `git diff --check` reports no whitespace damage.
- The diff contains no unrelated files, no new dependencies, and no credentials.

## Stop conditions
Stop and report rather than proceeding when:
- the branch has drifted from its base and the required checks are stale;
- the change would require touching a protected branch directly;
- unrelated changes have become entangled with the intended change.

## Verify
After pushing, confirm the required CI checks actually ran on the pushed commit and concluded
success. A local green run is not evidence that the pushed commit is green, and neither is a
merge.