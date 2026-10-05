# Work Unit: <stable id, e.g. PROJECT-001>

> Example Work Unit shipped with the factory. Replace the bracketed fields. Keep
> capabilities declarative — never name a provider, agent, or command.

## Goal
<!-- One sentence. What observable outcome does this deliver? -->

## Repository
<!-- owner/name of the repository this Work Unit changes. -->

## Base revision
<!-- The commit or ref the work starts from, so the diff is unambiguous. -->

## Capabilities
<!-- Requirements, not providers. Valid examples: coding, testing, documentation,
     frontend, backend, browser, accessibility.
     "Runs on OpenCode" is NOT a capability; "coding" is. -->
- coding
- testing

## Scope
<!-- Paths this Work Unit may touch. Anything outside this list is out of scope
     and needs a change request. The scheduler serializes Work Units whose paths
     or contracts overlap. -->
- src/example/

## Acceptance criteria
<!-- Each item must be objectively checkable. "Works correctly" is not
     checkable; "all tests pass" is. -->
1. <criterion that can be verified mechanically>
2. <criterion that can be verified mechanically>

## Verification
<!-- The deterministic checks that prove the criteria. The factory's CI contract
     already covers build, tests, schemas, and required documentation. -->
- npm run build
- npm test

## Autonomy
<!-- automatic | review | approval -->
review

## Non-goals
<!-- State explicitly what this Work Unit must NOT do, so scope review has
     something concrete to check against. -->
- No architecture change.
- No new dependency unless it is required.