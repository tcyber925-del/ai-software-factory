/**
 * Evidence/log redaction and bounding helpers (WU-92-06).
 *
 * Best-effort: reduces accidental secret exposure in persisted command/arg/output
 * evidence and events. It cannot prove absence of secrets in arbitrary tool output.
 * Never log environment values or credential material through these helpers.
 */

const REDACTED = "[REDACTED]";

const SECRET_PATTERNS: Array<{ re: RegExp; replace: string | ((m: string, ...groups: string[]) => string) }> = [
  // key=value or key: value forms for common secret-like names
  { re: /\b(authorization)\s*[:=]\s*(bearer\s+)?[^\s"',;]+/gi, replace: "$1: $2" + REDACTED },
  { re: /\b(api[_-]?key|token|secret|password|passwd|pwd|session[_-]?id|cookie|private[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*([^\s"',;]+)/gi, replace: "$1=" + REDACTED },
  // URL userinfo
  { re: /([a-z][a-z0-9+.-]*:\/\/)([^@\s\/]+)@/gi, replace: "$1" + REDACTED + "@" },
  // common token prefixes
  { re: /\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, replace: REDACTED },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace as any);
  }
  return out;
}

export function boundText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  // truncate by bytes while keeping valid-ish utf8 boundary
  let buf = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes));
  // trim trailing partial multibyte sequence
  while (buf.length > 0) {
    const b = buf[buf.length - 1];
    if (b === undefined || (b & 0b1100_0000) !== 0b1000_0000) break;
    buf = buf.subarray(0, buf.length - 1);
  }
  const truncated = buf.toString("utf8");
  return `${truncated}\n…[truncated ${Buffer.byteLength(text, "utf8") - Buffer.byteLength(truncated, "utf8")} bytes]`;
}

export function sanitizeEvidence(text: string, maxBytes = 4096): string {
  return boundText(redactSecrets(text), maxBytes);
}

export function safeCommandInvocation(command: string, args: string[] = []): string {
  // Redact each token to avoid leaking secrets passed as args; preserve structure.
  return redactSecrets([command, ...args].join(" "));
}