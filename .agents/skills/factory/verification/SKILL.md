---
name: verification
description: Verify Work Unit results independently from the producing agent's claim of completion.
---

# Verification Skill

Treat implementation output as untrusted until checks produce evidence.

Verify:
1. acceptance criteria;
2. deterministic repository checks;
3. scope;
4. relevant security/accessibility/regression constraints.

Do not infer correctness from agent status alone.

The required CI contract is defined in `docs/verification-and-merge-gates.md`; verify against it rather
than against whatever checks happen to exist. Runtime state such as `idle`, `done`, or process exit is
operational evidence only — a worker reporting completion has not established correctness.
