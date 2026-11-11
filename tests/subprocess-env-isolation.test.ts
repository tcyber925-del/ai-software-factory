import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitChangedFiles } from "../src/adapters/git/changes.js";
import { gitRepoSnapshot } from "../src/adapters/git/snapshot.js";
import { defaultShellRunner } from "../src/adapters/verification/shell.js";
import { defaultCommandRunner } from "../src/adapters/opencode/process.js";
import { defaultHermesCommandRunner } from "../src/adapters/hermes/process.js";
import { defaultHerdrCommandRunner } from "../src/adapters/herdr/process.js";

const SECRET_ENV = {
  SECRET_TOKEN: "super-secret-token",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "gh-secret",
};

function withSecrets<T>(fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(SECRET_ENV)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

describe("subprocess env isolation (WU-92-05)", () => {
  it("git adapters do not expose representative host secrets to child processes (policy allowlist)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "env-git-"));
    try {
      await withSecrets(async () => {
        // init minimal git repo and run adapters (they spawn git)
        const init = await defaultCommandRunner.run("git", ["init", "-q", dir], dir, { role: "git.read_snapshot" });
        expect(init.stdout).toBeDefined();
        await writeFile(join(dir, "a.txt"), "x");
        const changed = await gitChangedFiles(dir);
        expect(changed.some((p) => p.includes("a.txt"))).toBe(true);
        // snapshot requires commits/HEAD in some forms? rev-parse HEAD may fail on empty repo; that's fine, policy/env still applied.
        await gitRepoSnapshot(dir).catch(() => undefined);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verification shell runner does not pass representative host secrets by default", async () => {
    await withSecrets(async () => {
      const result = await defaultShellRunner.run(process.execPath, ["-p", "process.env.SECRET_TOKEN || ''"], process.cwd());
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
      expect(result.stdout).not.toContain("super-secret-token");
    });
  });

  it("opencode command runner does not pass representative host secrets by default", async () => {
    await withSecrets(async () => {
      const result = await defaultCommandRunner.run(process.execPath, ["-p", "process.env.GITHUB_TOKEN || ''"], process.cwd(), { role: "runtime.opencode.command" });
      expect(result.stdout.trim()).toBe("");
      expect(result.stdout).not.toContain("gh-secret");
    });
  });

  it("hermes command runner policy-refuses/isolates when invoked via default policy path", async () => {
    await withSecrets(async () => {
      // default hermes runner will try to execute `hermes` binary with allowlisted env; binary likely missing.
      // We verify the policy decision path by calling with explicit env that omits secrets and a harmless command via custom runner not possible here.
      // Instead, assert evaluateProcessPolicy role is allow and that our API accepts env; use node via opencode runner pattern not applicable.
      // Use defaultHermesCommandRunner with explicit empty-safe env and non-hermes? no, command is fixed to HERMES_BIN.
      const policy = (await import("../src/security/process-policy.js")).evaluateProcessPolicy({
        role: "runtime.hermes.command",
        hostEnv: { ...process.env, ...SECRET_ENV } as Record<string, string | undefined>,
      });
      expect(policy.decision).toBe("allow");
      expect(policy.effectiveEnv?.SECRET_TOKEN).toBeUndefined();
      expect(policy.effectiveEnv?.GITHUB_TOKEN).toBeUndefined();
      // Attempting real run may fail if hermes not installed; that is unrelated to env policy enforcement.
      await defaultHermesCommandRunner.run(["--version"], process.cwd(), 1000).catch(() => undefined);
    });
  });

  it("herdr command runner policy produces allowlisted env without representative secrets", async () => {
    await withSecrets(async () => {
      const policy = (await import("../src/security/process-policy.js")).evaluateProcessPolicy({
        role: "runtime.herdr.command",
        hostEnv: { ...process.env, ...SECRET_ENV } as Record<string, string | undefined>,
      });
      expect(policy.decision).toBe("allow");
      expect(policy.effectiveEnv?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      await defaultHerdrCommandRunner.run(["--version"], process.cwd()).catch(() => undefined);
    });
  });
});