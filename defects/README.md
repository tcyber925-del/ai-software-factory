# Defect corpus

Five deliberate degradations of this repository's own controls, each paired with the check
that is supposed to notice it. The runner applies them one at a time and records which test
file caught each one.

## Why this exists

`docs/verification-and-merge-gates.md` states that the suite's non-vacuity was proven by
deliberately weakening the implementation and confirming the tests then failed. That was done
by hand, once. This corpus makes it re-checkable on every run.

The claim being defended: **a green `contract` run is evidence, and a check that cannot fail is
not a check.**

## Adding a defect

1. Choose a promise the module documents in prose.
2. Make the smallest change that breaks that promise. Do not damage the module beyond
   recognition — a defect that wrecks a file proves an assertion exists, not that the assertion
   guards the control.
3. Find the exact source text to replace, and confirm it appears **exactly once** in the file.
   Use the surrounding function signature where a bare line is ambiguous.
4. Record the test file that catches it in `aimsAt`. Confirm by running the suite.
5. Add the defect and raise `ratchet.json` in the same commit.

## Rules

- Anchors must match exactly once. Zero matches means the source moved — that is a corpus error,
  and it is reported as one rather than as a defect that escaped.
- `loadCorpus` checks every one of these before anything is applied: that `defects` is an array,
  that each entry is an object, that all seven fields are non-empty strings, that ids are unique,
  that the target file exists, that the anchor matches exactly once, and that `aimsAt` names a real
  test file. It returns the problems as a list rather than throwing, so a caller can refuse to start.
  An empty `defects` array is a real state, not a malformed corpus.
- `expected` must be `caught` or `escaped`. It decides what counts as a pass, so a value the runner
  cannot interpret is rejected instead of quietly matching nothing.
- A mutation that cannot be evaluated is never reported as an escape. An escape means the check
  missed it, and a defect that never ran is not evidence of anything.
- Replacement text is literal. `$1`, `$&` and `$'` are not capture references here.
- Never quote the test-suite size in this directory. `main` removed those numbers deliberately;
  `npm run verify` is the source of truth.

## Running

```
npm run mutations          # evaluate every defect
npm run mutations -- --defect repair-limit-never-reached   # one defect
```

A defect that is not caught is a finding, not a failure of the tool. Report it.

## What this does not prove

**It only finds defects someone thought of.** This is the corpus's real limit and it is not
measurable from inside the tool. Five defects cover five controls; the kernel has more. A mutation
score would put a number here, and the number would be as misleading as the three suite sizes this
project has already published.

**It proves the suite can fail, not that it is correct.** A defect caught by a test that asserts
something adjacent counts the same as one caught by the test that encodes the control. That is why
each defect names the check it aims at, so the attribution is reviewable rather than trusted.

**It does not cover the composition.** `checkScope` is tested directly, and the
pipeline → scopeReason → integration path that uses its result is only exercised indirectly. The
`integration-gate-ignores-scope` defect is caught, but by `tests/scope.test.ts`, which tests the
scoper rather than the wiring. The wiring is the thing that failed in dogfooding. Adding a test
that asserts a scope violation reaches `integration.blocked` is the honest next step, and it is
deliberately not folded in here.
