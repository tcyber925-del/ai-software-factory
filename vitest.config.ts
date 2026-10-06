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
    /**
     * Headroom, not correctness.
     *
     * Several tests spawn real `git` and real agent binaries against real temporary
     * repositories. Measured in the full suite those take 2.0-4.1s each, which sits
     * directly on Vitest's 5s default. Two observed failures were both at 5050ms —
     * the default timeout, asserting nothing. Raising the ceiling removes that race.
     *
     * Note on confidence: the failure could not be reproduced on demand (10 clean
     * runs with this removed, on an idle machine), so the evidence is correlational.
     * The change is safe either way — it cannot mask a real assertion failure, only
     * stop a slow test being cut off mid-flight.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * The suite spawns real `git` and real agent binaries against real temporary
     * repositories. Those tests take 2-5s each, which sits directly on Vitest's 5s
     * default: under parallel load `doctor-readonly` intermittently exceeded it and
     * failed as a timeout while asserting nothing wrong. Raising the ceiling removes
     * a scheduling race, not a real assertion.
     */
    exclude: ["**/node_modules/**", "**/dist/**", ".worktrees/**", ".tmp-test/**"],
  },
});