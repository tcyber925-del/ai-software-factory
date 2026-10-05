---
name: worktree
description: Create and use isolated Git worktrees for bounded Work Units, and recognize when worktree isolation is insufficient.
---

# Worktree

A worktree gives a Work Unit its own checkout, so concurrent units do not collide in a shared
working tree.

## Rules
- Create one worktree per Work Unit, from an explicit base revision.
- Keep the worktree's branch name tied to the Work Unit id.
- Clean up the worktree when the Work Unit reaches a terminal state.
- Record the worktree path in execution events so the isolated location is auditable.
- Never assume two units touching the same paths are safe to run concurrently.

## A worktree is not a sandbox
A Git worktree is **developer isolation, not a security boundary**. Per `docs/security.md`, untrusted
or destructive code needs stronger isolation such as a container or remote sandbox. Do not describe
worktree isolation as protection against untrusted code.

## Preconditions
Confirm before dispatch that:
- the directory is inside a Git repository with worktree support;
- the working tree is clean, so the base revision is unambiguous;
- HEAD is not detached;
- the current directory is not itself a nested linked worktree.

`factory doctor` reports these conditions; treat a `blocked` report as blocking dispatch.

## Conflicts
Parallel execution is only safe when the units are independent. When paths, contracts, runtime
assumptions, or protected resources overlap — or when a unit does not declare what it touches —
serialize instead. See `docs/scheduling.md`.