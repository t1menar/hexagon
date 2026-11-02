/**
 * The environment an agent process gets: an allow-list, not a copy of the daemon's. A key that is not named here
 * (cloud credentials, tokens for other services, whatever the user exported) never reaches the model's tools.
 * Names ending in `*` are prefixes.
 */
const BASE = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_*", "TERM", "COLORTERM", "TMPDIR", "TZ", "NO_COLOR", "FORCE_COLOR",
  "XDG_*", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "__CF_USER_TEXT_ENCODING",
];

const matches = (name: string, pattern: string): boolean => (pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

/** `ctxEnv` (HEXAGON_* variables) always passes; `auth` is the integration's own login variables; `extra` is [agents.x].env_passthrough. */
export function agentProcessEnv(ctxEnv: Record<string, string>, auth: readonly string[] = [], extra: readonly string[] = [], source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allow = [...BASE, ...auth, ...extra];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && allow.some((p) => matches(k, p))) out[k] = v;
  return { ...out, ...ctxEnv };
}
