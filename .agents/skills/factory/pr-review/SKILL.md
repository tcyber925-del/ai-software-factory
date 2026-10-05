---
name: pr-review
description: Review a pull request against its Work Unit scope, acceptance criteria, and the required CI contract.
---

# PR Review

Review is a verification step, not a formality. Use `docs/verification-and-merge-gates.md` for the
gate definition.

## Confirm first
- The Work Unit is identified and traceable to the PR.
- Required CI checks ran on the PR head commit and concluded success.
- The PR is up to date with its base branch.
- Acceptance criteria are evidenced, not asserted.

## Then review scope
Compare the actual diff against the Work Unit's scope and acceptance criteria. Flag:
- unrelated files or unrelated changes bundled into the same PR;
- new dependencies that were not required;
- new architecture, services, or product direction;
- changed public contracts;
- security-boundary changes;
- removed or weakened tests, or bypassed checks.

Material expansion requires a change request and approval, not a rubber stamp.

## Correctness
- Read the change, do not infer it from the description.
- Check that failure paths are handled and tested, not only the success path.
- Treat agent status, a merged commit, or a green local run as operational evidence only.

## Never
- Approve to unblock a queue.
- Treat a green CI run as proof the change is correct; it is necessary, not sufficient.
- Merge on the agent's say-so.

## Escalate
Stop and report when the diff does not match the stated scope, when acceptance criteria are
ambiguous, or when a public claim lacks evidence.