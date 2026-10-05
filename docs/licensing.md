# Licensing

## Decision
The factory is licensed under the **MIT License** (see `LICENSE`).

## Why MIT

The factory's purpose is to be **adopted**. FCT-015 (#22) packages it as a reusable GitHub template
that a fresh repository copies in, and the approved plan lists "a fresh repository can adopt it from
a template" as a success criterion. The license therefore optimises for adoption friction, not for
defensive posture.

MIT was chosen because:

- **Maximum adoption.** It places no restriction on commercial use, modification, or redistribution,
  so a team can adopt the template in any context without a legal review flag.
- **Compatible with everything.** MIT is permissively compatible with Apache-2.0, GPL, and proprietary
  code, so adopters are never forced to choose between the factory and their own licensing.
- **No ecosystem friction.** The entire toolchain it builds on (TypeScript, Vitest, Node) is MIT, so
  there is no mixed-licence complication in a template repository.
- **Template-friendly.** There is no copyleft obligation to propagate into adopting repositories,
  which matters for a template meant to be copied rather than depended upon.

Apache-2.0 was the considered alternative. It adds an explicit patent grant, which is genuinely
valuable for a foundation-scale project, but it also adds a NOTICE-file obligation that is pure
friction for someone copying a template into a new repository. That trade was not worth it at this
stage.

## Changing the license

The license is a founder decision and it was delegated to the implementing agent for this step.
Because the repository is public, **this choice is already externally visible** and reliance on it by
third parties is possible. Changing it later is therefore a licensed-code question, not just a file
edit. Any change should be raised as a change request rather than made in passing.

## Scope of the license

The MIT license covers the repository contents: source, schemas, documentation, and the portable
Agent Skills under `.agents/skills/`. It does not grant rights to any third-party runtime the factory
adapts — OpenCode, Herdr, Codex, Claude Code, or Hermes remain under their own licenses — and it does
not license any repository that merely adopts the template.

Adapter skills (`runtime/opencode`, `runtime/herdr`) describe how to operate those tools and confer
no rights to them.