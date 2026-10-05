import { defineConfig } from "vitest/config";

/**
 * Test discovery is scoped deliberately.
 *
 * Without this, Vitest globs the whole repository and happily collects tests from
 * `.worktrees/`. A stale worktree then runs its tests alongside the real ones, so
 * the suite reports a larger number than the repository actually has. That is not a
 * cosmetic problem: an inflated count is indistinguishable from real coverage, and
 * it hides the fact that a worktree was left behind at all.
 *
 * `.tmp-test` is excluded for the same reason — scratch fixtures created by the
 * test suite itself must never be collected.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".worktrees/**", ".tmp-test/**"],
  },
});