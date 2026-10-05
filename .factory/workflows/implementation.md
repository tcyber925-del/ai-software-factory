# Implementation Workflow

1. Discover authoritative context.
2. Validate the Work Unit.
3. Select capabilities and a compatible worker/runtime.
4. Create isolated workspace/worktree.
5. Implement within scope.
6. Run independent verification **against that worktree**.
7. Repair failures at most twice.
8. Re-verify from fresh evidence.
9. Open/prepare a traceable PR.
10. Human review when required.
11. Integrate only through the gate.
12. Record outcome and lessons.

Steps 2–8 and 12 are what `factory work run` composes; see [`docs/cli.md`](../../docs/cli.md).
Steps 1, 9, 10, and 11 are human-led and are not automated.

When uncertain about concurrency, serialize.
