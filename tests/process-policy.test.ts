import { describe, expect, it } from "vitest";
import { evaluateProcessPolicy } from "../src/security/process-policy.js";

const HOST = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/test",
  USER: "test",
  LANG: "C.UTF-8",
  TERM: "xterm",
  SECRET_TOKEN: "do-not-leak",
  AWS_SECRET_ACCESS_KEY: "do-not-leak",
  GITHUB_TOKEN: "do-not-leak",
  CUSTOM_VAR: "keep-out-unless-allowed",
};

describe("process policy contract (WU-92-03)", () => {
  it("refuses unknown roles (fail closed)", () => {
    const result = evaluateProcessPolicy({ role: "unknown.role", hostEnv: HOST });
    expect(result.decision).toBe("refuse");
    expect(result.reasonCode).toBe("unknown_role");
    expect(result.effectiveEnv).toBeUndefined();
  });

  it("never returns the full parent environment for allowed roles", () => {
    const result = evaluateProcessPolicy({ role: "git.read_status", hostEnv: HOST });
    expect(result.decision).toBe("allow");
    expect(result.effectiveEnv).toBeDefined();
    expect(result.effectiveEnv).not.toBe(HOST);
    expect(Object.keys(result.effectiveEnv ?? {})).not.toContain("SECRET_TOKEN");
    expect(Object.keys(result.effectiveEnv ?? {})).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(Object.keys(result.effectiveEnv ?? {})).not.toContain("GITHUB_TOKEN");
    expect(Object.keys(result.effectiveEnv ?? {})).not.toContain("CUSTOM_VAR");
  });

  it("constructs allowlisted env from host values only (no invention)", () => {
    const result = evaluateProcessPolicy({ role: "git.read_status", hostEnv: { PATH: "/bin" } });
    expect(result.decision).toBe("allow");
    expect(result.effectiveEnv).toEqual({ PATH: "/bin" });
  });

  it("allows supported git helper roles with minimal env", () => {
    for (const role of ["git.read_status", "git.read_snapshot"] as const) {
      const result = evaluateProcessPolicy({ role, hostEnv: HOST });
      expect(result.decision).toBe("allow");
      expect(result.reasonCode).toBe("role_allowed_minimal_env");
      expect(result.effectiveEnv?.PATH).toBe(HOST.PATH);
      expect(result.effectiveEnv?.SECRET_TOKEN).toBeUndefined();
    }
  });

  it("allows supported runtime/verification roles with explicit allowlisted env (no secrets)", () => {
    for (const role of [
      "runtime.opencode.command",
      "runtime.hermes.command",
      "runtime.herdr.command",
      "verification.shell",
    ] as const) {
      const result = evaluateProcessPolicy({ role, hostEnv: HOST });
      expect(result.decision).toBe("allow");
      expect(result.effectiveEnv?.PATH).toBe(HOST.PATH);
      expect(result.effectiveEnv?.HOME).toBe(HOST.HOME);
      expect(result.effectiveEnv?.SECRET_TOKEN).toBeUndefined();
      expect(result.effectiveEnv?.GITHUB_TOKEN).toBeUndefined();
      expect(result.constraints.sensitiveArguments).toBe(true);
      expect(result.constraints.sensitiveOutput).toBe(true);
      expect(result.evidence.envKeys).toEqual(Object.keys(result.effectiveEnv ?? {}));
    }
  });

  it("returns unsupported for roles blocked/excluded by default (fail closed)", () => {
    const unsupported = [
      "doctor.git_probe",
      "doctor.runtime_version_probe",
      "doctor.runtime_dispatch_probe",
      "cli.project_verify_script",
      "dev.mutation_suite",
      "dev.mutation_git_init",
    ] as const;
    for (const role of unsupported) {
      const result = evaluateProcessPolicy({ role, hostEnv: HOST });
      expect(result.decision).toBe("unsupported");
      expect(result.effectiveEnv).toBeUndefined();
    }
  });

  it("does not treat absence of exception as permission", () => {
    const result = evaluateProcessPolicy({ role: "cli.project_verify_script", hostEnv: HOST });
    expect(result.decision).toBe("unsupported");
  });

  it("denies production credential scope", () => {
    const result = evaluateProcessPolicy({
      role: "runtime.opencode.command",
      hostEnv: HOST,
      credentialScope: "production",
    });
    expect(result.decision).toBe("refuse");
    expect(result.reasonCode).toBe("credential_scope_production_denied");
    expect(result.effectiveEnv).toBeUndefined();
  });

  it("refuses dev/staging credential material forwarding (admission-only policy)", () => {
    for (const credentialScope of ["development", "staging"] as const) {
      const result = evaluateProcessPolicy({
        role: "runtime.opencode.command",
        hostEnv: HOST,
        credentialScope,
      });
      expect(result.decision).toBe("refuse");
      expect(result.reasonCode).toBe("credential_material_not_delivered");
      expect(result.effectiveEnv).toBeUndefined();
    }
  });

  it("evidence records only role/decision/reason/env key names (no values)", () => {
    const result = evaluateProcessPolicy({ role: "verification.shell", hostEnv: HOST });
    expect(result.evidence).toEqual({
      role: "verification.shell",
      decision: "allow",
      reasonCode: "role_allowed_verification_env",
      envKeys: Object.keys(result.effectiveEnv ?? {}),
    });
    expect(JSON.stringify(result.evidence)).not.toContain("do-not-leak");
  });

  it("is deterministic for the same inputs", () => {
    const input = { role: "git.read_snapshot", hostEnv: { PATH: "/bin", SECRET_TOKEN: "x" } };
    expect(JSON.stringify(evaluateProcessPolicy(input))).toBe(JSON.stringify(evaluateProcessPolicy(input)));
  });
});