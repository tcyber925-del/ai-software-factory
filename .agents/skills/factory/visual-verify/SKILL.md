---
name: visual-verify
description: Verify user-visible and interactive behavior directly, rather than inferring it from a passing build.
---

# Visual Verify

A green build does not establish that a change works for a user. This skill covers changes with a
visual, interactive, or otherwise user-visible surface.

## When it applies
- UI or styling changes.
- Interactive flows, forms, or state transitions.
- Anything whose correctness is observable by a person.

## Rules
- Exercise the change in a real browser or the real client. Do not reason about behavior from source
  alone.
- Verify the changed behavior, not just that the page renders.
- Check the states that are easy to get wrong: loading, empty, error, and permission-denied.
- Confirm accessibility of the result: keyboard reachability, focus order, names and roles, and
  sufficient contrast.
- Check responsive behavior at the widths the product actually supports.

## Evidence
Record what was observed, not what was intended. A screenshot, a recorded interaction, or a
specific assertion of observed state is evidence. "It should work" is not.

## Relationship to verification
Visual verification is one kind of deterministic check within the contract defined in
`docs/verification-and-merge-gates.md`. It does not replace the rest of the CI contract, and a passing
visual check does not make a change integration-ready on its own.

## Stop conditions
Report rather than assert when the surface cannot be exercised — no browser is available, the change
is unreachable in the current environment, or the observed behavior contradicts the requirement.
Do not record an unverified surface as passing.