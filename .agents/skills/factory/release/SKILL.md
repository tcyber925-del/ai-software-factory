---
name: release
description: Prepare and perform a release only after verification and integration evidence exist, and record what shipped.
---

# Release

The factory sequence is **Implement → Verify → Review → Merge → Release**. Releasing is the last
step, never a shortcut around the earlier ones.

## Preconditions
Release only when, per `docs/verification-and-merge-gates.md` and `docs/protocols.md`:
- the Work Unit is merged through the integration gate;
- required CI checks passed on the merged revision;
- human approval exists wherever policy requires it;
- the change is verified, not merely complete.

If any precondition is unmet, stop. A release does not substitute for verification, and merge does
not imply verification.

## Before shipping
- Confirm the revision being released is the verified one. Re-verify if the base moved.
- Check acceptance criteria for the whole release, not only the most recent PR.
- Review scope across all included changes for anything that was never intended to ship.
- Confirm no production credentials, secrets, or debug leftovers are included.
- Prefer a revert to a forward fix for a bad release; do not rewrite published history.

## After shipping
- Record what shipped: Work Units, revisions, and verification evidence.
- Record the outcome. A release with no evidence is not a release, it is a guess.
- Feed failures back as follow-up issues rather than silently patching.

## Boundaries
No autonomous production deployment, no autonomous merge, and no self-authorized release. When
uncertain whether a precondition is met, stop and ask rather than proceeding.