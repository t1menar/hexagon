/**
 * Secrets never reach a file Hexagon writes. Applied at the single write path (fsx.ts) and by the bus, so events,
 * transcripts, status and messages share one rule. Patterns are deliberately specific: a false positive costs a
 * little readability, a miss costs a leaked key.
 */
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|ant[-_]|proj[-_])?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /(?<=:\/\/)[^\s/:@]+:[^\s/@]{3,}(?=@)/g,
  /\b(?:password|passwd|secret|token|api[_-]?key|aws_secret_access_key|client_secret)\s*[:=]\s*[^\s"'\\,;}]{6,}/gi,
  /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"'\\,;}]{6,}/g,
];

const SECRET_KEY = /(?:password|passwd|secret|token|api[_-]?key|authorization|private[_-]?key|credential)/i;
const SAFE_KEY = /(?:^|_)(?:tokens?|max_tokens|budget_tokens)$|_tokens$|^tokens?_/i;

export function redact(text: string): string {
  return SECRETS.reduce((t, re) => t.replace(re, "[redacted]"), text);
}

/** Redact every string inside a JSON-able value (and the value of any key that names a secret). Returns the input when nothing changed. */
export function redactDeep<T>(value: T, key = ""): T {
  if (typeof value === "string") {
    if (value.length >= 6 && SECRET_KEY.test(key) && !SAFE_KEY.test(key)) return "[redacted]" as T;
    const r = redact(value);
    return (r === value ? value : r) as T;
  }
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((v, i) => { const r = redactDeep(v, key); if (r !== v) (out ??= value.slice())[i] = r; });
    return (out ?? value) as T;
  }
  if (value && typeof value === "object") {
    let out: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = redactDeep(v, k);
      if (r !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = r;
    }
    return (out ?? value) as T;
  }
  return value;
}
