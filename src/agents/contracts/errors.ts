/**
 * Provider failure classification. Each class has its own recovery policy; none of them is a "quality fix cycle".
 * Classification looks at what the CLI printed (text and, when present, structured fields), never at a model name.
 */
export type ProviderErrorClass =
  | "rate_limit"        // temporary: request/token/concurrency throttling; retry soon
  | "quota_exhausted"   // allowance used up; wait for the provider's reset
  | "context_overflow"  // conversation/input too large: compact and resume, do not wait
  | "output_truncated"  // response cut off: continue, never treat as success
  | "auth"              // credentials invalid/expired/revoked: blocked until the user acts
  | "billing"           // payment/plan problem: blocked until the user acts
  | "overloaded"        // provider-side 5xx/overload: short backoff
  | "unknown";

export interface ClassifiedError {
  cls: ProviderErrorClass;
  message: string;
  /** Absolute time the provider says execution can resume (ISO), when it said so. */
  resetAt?: string;
  /** Seconds from Retry-After style hints. */
  retryAfterS?: number;
  /** true when resetAt/retryAfter were not provided and a backoff estimate must be used. */
  estimated: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Extract "retry after 30s", "try again in 2 minutes", "Retry-After: 45". */
export function parseRetryAfter(text: string): number | undefined {
  const m = /retry[-\s]?after:?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?)?\b/i.exec(text)
    ?? /(?:try again|retry|resets?|available)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = (m[2] ?? "s").toLowerCase();
  if (u === "ms") return n / 1000;
  if (u.startsWith("m") ) return n * 60;
  if (u.startsWith("h")) return n * 3600;
  return n;
}

/** Extract an explicit reset moment: epoch seconds ("limit reached|1767225600"), ISO timestamp, or "resets 3pm". */
export function parseResetAt(text: string, now: Date = new Date()): string | undefined {
  const epoch = /\|\s*(\d{10})\b/.exec(text) ?? /reset(?:s|_at)?\D{0,12}(\d{10})\b/i.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/.exec(text);
  if (iso && /reset|available|retry|until/i.test(text)) {
    const d = new Date(iso[1]!);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (clock) {
    let h = Number(clock[1]) % 12;
    if (clock[3]!.toLowerCase() === "pm") h += 12;
    const d = new Date(now);
    d.setHours(h, Number(clock[2] ?? 0), 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const dated = new RegExp(`resets?\\s+(?:on\\s+)?(${MONTHS.join("|")})[a-z]*\\s+(\\d{1,2})`, "i").exec(text);
  if (dated) {
    const d = new Date(now.getFullYear(), MONTHS.indexOf(dated[1]!.toLowerCase()), Number(dated[2]), 0, 0, 0, 0);
    if (d.getTime() < now.getTime()) d.setFullYear(d.getFullYear() + 1);
    return d.toISOString();
  }
  return undefined;
}

export function classifyProviderError(raw: string, now: Date = new Date()): ClassifiedError {
  const text = raw.slice(0, 4000);
  const out = (cls: ProviderErrorClass, extra: Partial<ClassifiedError> = {}): ClassifiedError => {
    const resetAt = extra.resetAt ?? parseResetAt(text, now);
    const retryAfterS = extra.retryAfterS ?? parseRetryAfter(text);
    return { cls, message: text.trim().slice(0, 500), resetAt, retryAfterS, estimated: resetAt === undefined && retryAfterS === undefined, ...extra };
  };

  if (/context (?:window|length|limit)|prompt is too long|input is too long|conversation (?:is )?too long|maximum context|context_length_exceeded|too many tokens in (?:the )?(?:prompt|input)/i.test(text)) return out("context_overflow");
  if (/max[_ ]output[_ ]tokens|output (?:token )?limit|response (?:was )?truncated|stop_reason.{0,5}max_tokens|truncated/i.test(text)) return out("output_truncated");
  if (/billing|payment|credit balance|insufficient (?:credit|funds)|plan (?:does not|doesn't) include|subscription (?:has )?(?:expired|lapsed)/i.test(text)) return out("billing");
  if (/\b401\b|unauthori[sz]ed|invalid (?:api )?key|invalid[_ ]credentials|authentication|not logged in|please (?:run )?\/?login|token (?:has )?expired|permission denied.*(?:api|org)|revoked/i.test(text)) return out("auth");
  // Usage allowance (subscription/daily/weekly/monthly) vs. momentary throttling.
  if (/usage limit|limit reached|quota|(?:daily|weekly|monthly|5-hour|five-hour) (?:limit|allowance)|out of (?:usage|credits|messages)|allowance/i.test(text)
      && !/requests? per minute|tokens? per minute|\bRPM\b|\bTPM\b/i.test(text)) return out("quota_exhausted");
  if (/rate[ _-]?limit|\b429\b|too many requests|throttl|concurrency limit|requests? per minute|tokens? per minute/i.test(text)) return out("rate_limit");
  if (/overload|\b50[0234]\b|temporarily unavailable|service unavailable|capacity/i.test(text)) return out("overloaded");
  return out("unknown");
}

/** What the orchestrator does about each class. Quality cycles are never consumed by any of these. */
export type RecoveryAction = "wait_and_resume" | "compact_and_resume" | "continue_output" | "block_for_user" | "none";

export function recoveryFor(cls: ProviderErrorClass): RecoveryAction {
  switch (cls) {
    case "rate_limit": case "quota_exhausted": case "overloaded": return "wait_and_resume";
    case "context_overflow": return "compact_and_resume";
    case "output_truncated": return "continue_output";
    case "auth": case "billing": return "block_for_user";
    default: return "none";
  }
}
