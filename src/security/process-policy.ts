/**
 * Shared subprocess/process-environment policy contract (WU-92-03, proposed #92 design).
 *
 * Deterministic and fail-closed: unknown roles, missing policy, missing required
 * inputs, or unapproved exceptions never execute with the full parent environment.
 * This module authorizes/advises process launch boundaries; it does not deliver
 * credential material and does not claim sandbox/network containment.
 */

export type ProcessPolicyDecision = "allow" | "refuse" | "unsupported";

export type ProcessRole =
  | "git.read_status"
  | "git.read_snapshot"
  | "runtime.opencode.command"
  | "runtime.hermes.command"
  | "runtime.herdr.command"
  | "verification.shell"
  | "doctor.git_probe"
  | "doctor.runtime_version_probe"
  | "doctor.runtime_dispatch_probe"
  | "cli.project_verify_script"
  | "dev.mutation_suite"
  | "dev.mutation_git_init";

export type CredentialScope = "none" | "development" | "staging" | "production";

export interface ProcessPolicyInput {
  /** Known process role; unknown values are refused. */
  role: string;
  /** Host/parent environment snapshot to select from; never returned wholesale. */
  hostEnv: Record<string, string | undefined>;
  /** Requested credential scope for admission context (authorization only). */
  credentialScope?: CredentialScope;
  /** Explicit, reviewed exception record for narrowly justified cases. */
  approvedException?: { id: string; reason: string };
}

export interface ProcessPolicyConstraints {
  /** No implicit timeout implied by this contract unless specified by caller/runner. */
  requireExplicitTimeout?: boolean;
  /** Commands/args may be sensitive and must be represented/redacted in evidence. */
  sensitiveArguments?: boolean;
  /** Captured output may be sensitive and must be bounded/redacted in evidence. */
  sensitiveOutput?: boolean;
}

export interface ProcessPolicyEvidence {
  role: string;
  decision: ProcessPolicyDecision;
  reasonCode: string;
  /** Variable names included in effective env (values never recorded). */
  envKeys: string[];
}

export interface ProcessPolicyResult {
  decision: ProcessPolicyDecision;
  reasonCode: string;
  reason: string;
  role: string;
  /** Present only when decision is "allow"; explicit allowlisted env, never full hostEnv. */
  effectiveEnv?: Record<string, string>;
  constraints: ProcessPolicyConstraints;
  evidence: ProcessPolicyEvidence;
}

const KNOWN_ROLES = new Set<ProcessRole>([
  "git.read_status",
  "git.read_snapshot",
  "runtime.opencode.command",
  "runtime.hermes.command",
  "runtime.herdr.command",
  "verification.shell",
  "doctor.git_probe",
  "doctor.runtime_version_probe",
  "doctor.runtime_dispatch_probe",
  "cli.project_verify_script",
  "dev.mutation_suite",
  "dev.mutation_git_init",
]);

/** Minimal baseline keys commonly required by CLI tools; role rules may narrow further. */
const BASELINE_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TMP", "TEMP"] as const;

type RoleRule = {
  disposition: "allow" | "unsupported";
  allowKeys: readonly string[];
  constraints: ProcessPolicyConstraints;
  reason: string;
  reasonCode: string;
};

const ROLE_RULES: Record<ProcessRole, RoleRule> = {
  "git.read_status": {
    disposition: "allow",
    allowKeys: [...BASELINE_ALLOWLIST, "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES"],
    constraints: { requireExplicitTimeout: false, sensitiveArguments: false, sensitiveOutput: false },
    reason: "git read-only status probe allowed with explicit minimal environment",
    reasonCode: "role_allowed_minimal_env",
  },
  "git.read_snapshot": {
    disposition: "allow",
    allowKeys: [...BASELINE_ALLOWLIST, "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES"],
    constraints: { requireExplicitTimeout: false, sensitiveArguments: false, sensitiveOutput: false },
    reason: "git read-only snapshot probe allowed with explicit minimal environment",
    reasonCode: "role_allowed_minimal_env",
  },
  "runtime.opencode.command": {
    disposition: "allow",
    allowKeys: [...BASELINE_ALLOWLIST, "SHELL", "PWD", "CI", "NODE_ENV", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: true, sensitiveOutput: true },
    reason: "runtime command allowed with explicit allowlisted environment; credential material not delivered by policy",
    reasonCode: "role_allowed_runtime_env",
  },
  "runtime.hermes.command": {
    disposition: "allow",
    allowKeys: [...BASELINE_ALLOWLIST, "SHELL", "PWD", "CI", "NODE_ENV", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: true, sensitiveOutput: true },
    reason: "runtime command allowed with explicit allowlisted environment; credential material not delivered by policy",
    reasonCode: "role_allowed_runtime_env",
  },
  "runtime.herdr.command": {
    disposition: "allow",
    allowKeys: [...BASELINE_ALLOWLIST, "SHELL", "PWD", "CI", "NODE_ENV", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: true, sensitiveOutput: true },
    reason: "runtime command allowed with explicit allowlisted environment; credential material not delivered by policy",
    reasonCode: "role_allowed_runtime_env",
  },
  "verification.shell": {
    disposition: "allow",
    allowKeys: [...BASELINE_ALLOWLIST, "SHELL", "PWD", "CI", "NODE_ENV", "npm_config_user_agent", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: true, sensitiveOutput: true },
    reason: "verification command allowed with explicit allowlisted environment; command/args and output must be treated as sensitive evidence",
    reasonCode: "role_allowed_verification_env",
  },
  "doctor.git_probe": {
    disposition: "unsupported",
    allowKeys: [],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: false, sensitiveOutput: false },
    reason: "doctor git probe has no approved process policy; fail closed",
    reasonCode: "role_unsupported_no_policy",
  },
  "doctor.runtime_version_probe": {
    disposition: "unsupported",
    allowKeys: [],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: false, sensitiveOutput: false },
    reason: "doctor runtime version probe has no approved process policy; fail closed",
    reasonCode: "role_unsupported_no_policy",
  },
  "doctor.runtime_dispatch_probe": {
    disposition: "unsupported",
    allowKeys: [],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: true, sensitiveOutput: true },
    reason: "doctor runtime dispatch probe is blocked by default; fail closed",
    reasonCode: "role_blocked_by_default",
  },
  "cli.project_verify_script": {
    disposition: "unsupported",
    allowKeys: [],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: true, sensitiveOutput: true },
    reason: "project-defined CLI verify scripts have no approved process policy; fail closed",
    reasonCode: "role_unsupported_no_policy",
  },
  "dev.mutation_suite": {
    disposition: "unsupported",
    allowKeys: [],
    constraints: { requireExplicitTimeout: true, sensitiveArguments: false, sensitiveOutput: false },
    reason: "dev mutation suite is excluded from production dispatch policy; fail closed",
    reasonCode: "role_excluded_dev_only",
  },
  "dev.mutation_git_init": {
    disposition: "unsupported",
    allowKeys: [],
    constraints: { requireExplicitTimeout: false, sensitiveArguments: false, sensitiveOutput: false },
    reason: "dev mutation git init is excluded from production dispatch policy; fail closed",
    reasonCode: "role_excluded_dev_only",
  },
};

function isKnownRole(role: string): role is ProcessRole {
  return KNOWN_ROLES.has(role as ProcessRole);
}

function pickEnv(hostEnv: Record<string, string | undefined>, allowKeys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowKeys) {
    const value = hostEnv[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function baseResult(
  role: string,
  decision: ProcessPolicyDecision,
  reasonCode: string,
  reason: string,
  constraints: ProcessPolicyConstraints,
  effectiveEnv?: Record<string, string>,
): ProcessPolicyResult {
  const envKeys = effectiveEnv ? Object.keys(effectiveEnv) : [];
  const result: ProcessPolicyResult = {
    decision,
    reasonCode,
    reason,
    role,
    constraints,
    evidence: { role, decision, reasonCode, envKeys },
  };
  if (effectiveEnv) result.effectiveEnv = effectiveEnv;
  return result;
}

export function evaluateProcessPolicy(input: ProcessPolicyInput): ProcessPolicyResult {
  const role = input.role;

  if (!isKnownRole(role)) {
    return baseResult(
      role,
      "refuse",
      "unknown_role",
      `unknown process role "${role}"; fail closed`,
      { requireExplicitTimeout: true, sensitiveArguments: true, sensitiveOutput: true },
    );
  }

  if (input.credentialScope === "production") {
    return baseResult(
      role,
      "refuse",
      "credential_scope_production_denied",
      "production credential scope is never granted",
      { requireExplicitTimeout: true, sensitiveArguments: true, sensitiveOutput: true },
    );
  }

  const rule = ROLE_RULES[role];
  if (rule.disposition !== "allow") {
    // Explicit exceptions must be reviewed and narrowly scoped; absent/unsupported => fail closed.
    if (!input.approvedException) {
      return baseResult(role, "unsupported", rule.reasonCode, rule.reason, rule.constraints);
    }
    return baseResult(
      role,
      "refuse",
      "exception_not_implemented",
      `approved exception "${input.approvedException.id}" provided but exception application is not implemented; fail closed`,
      rule.constraints,
    );
  }

  // Admission-only posture: no credential material forwarding by policy in this contract.
  if (input.credentialScope && input.credentialScope !== "none") {
    return baseResult(
      role,
      "refuse",
      "credential_material_not_delivered",
      `${input.credentialScope} credential scope requires separate approved delivery path; policy does not forward credential material`,
      { ...rule.constraints, sensitiveArguments: true, sensitiveOutput: true },
    );
  }

  const effectiveEnv = pickEnv(input.hostEnv, rule.allowKeys);
  return baseResult(role, "allow", rule.reasonCode, rule.reason, rule.constraints, effectiveEnv);
}