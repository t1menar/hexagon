import fs from "node:fs";
import path from "node:path";
import { classifyProviderError, recoveryFor, type ClassifiedError } from "../agents/contracts/errors.js";

export interface RecoveryConfig {
  enabled: boolean;
  auto_resume: boolean;
  /** true: keep waiting for quota resets however long they take. */
  unlimited_quota_wait: boolean;
  allow_provider_failover: boolean;
  initial_backoff_seconds: number;
  max_backoff_seconds: number;
  backoff_multiplier: number;
  backoff_jitter: boolean;
  /** 0 = unlimited. A single wait longer than this fails the task instead (only when unlimited_quota_wait is false or this is > 0). */
  max_wait_seconds: number;
  /** Transient process retries (rate-limit blips) before treating it as a quota wait. 0 = none. */
  max_context_recoveries: number;
}

export const DEFAULT_RECOVERY: RecoveryConfig = {
  enabled: true,
  auto_resume: true,
  unlimited_quota_wait: true,
  allow_provider_failover: false,
  initial_backoff_seconds: 60,
  max_backoff_seconds: 3600,
  backoff_multiplier: 2,
  backoff_jitter: true,
  max_wait_seconds: 0,
  max_context_recoveries: 3,
};

export interface RetryPlan {
  /** ISO time of the next attempt. */
  at: string;
  /** "provider": the CLI reported it. "estimate": computed from backoff. */
  source: "provider" | "estimate";
  delayS: number;
}

/**
 * When to try again. Provider-reported reset/Retry-After wins (plus a small grace so we don't land just before it);
 * otherwise exponential backoff by how many waits this task already had, optionally jittered.
 */
export function planRetry(c: ClassifiedError, waitCount: number, cfg: RecoveryConfig, now: Date = new Date(), rand: () => number = Math.random): RetryPlan {
  const grace = 5;
  let delayS: number;
  let source: RetryPlan["source"] = "estimate";
  if (c.resetAt) {
    delayS = Math.max(0, (new Date(c.resetAt).getTime() - now.getTime()) / 1000) + grace;
    source = "provider";
  } else if (c.retryAfterS !== undefined) {
    delayS = c.retryAfterS + 1;
    source = "provider";
  } else {
    const raw = cfg.initial_backoff_seconds * Math.pow(cfg.backoff_multiplier, Math.max(0, waitCount));
    delayS = Math.min(raw, cfg.max_backoff_seconds);
    // Full jitter in the upper half keeps many waiting tasks from probing the provider at the same instant.
    if (cfg.backoff_jitter) delayS = delayS * (0.5 + rand() * 0.5);
  }
  return { at: new Date(now.getTime() + delayS * 1000).toISOString(), source, delayS: Math.round(delayS) };
}

/** Wait exceeds the configured ceiling? (0 = unlimited) */
export function waitTooLong(totalWaitedS: number, cfg: RecoveryConfig): boolean {
  return cfg.max_wait_seconds > 0 && totalWaitedS > cfg.max_wait_seconds;
}

export type WaitStatus = "waiting" | "resuming" | "resumed" | "cancelled" | "expired";

export interface WaitRecord {
  /** One record per agent run: scheduling again replaces it (idempotent). */
  key: string;
  run_id: string;
  task_id: string;
  agent_run_id: string;
  role: string;
  agent: string;
  provider: string;
  adapter: string;
  execution_id: string;
  cls: ClassifiedError["cls"];
  error: string;
  detected_at: string;
  next_retry_at: string;
  reset_source: RetryPlan["source"];
  waits: number;
  waited_s: number;
  status: WaitStatus;
  resumed_at?: string;
  outcome?: "recovered" | "re-limited" | "cancelled" | "failed";
}

/** Persistent retry schedule: a JSON file replaced atomically on every change. Survives daemon/system restarts. */
export class WaitStore {
  private recs = new Map<string, WaitRecord>();
  constructor(private file: string) {
    try {
      for (const r of JSON.parse(fs.readFileSync(file, "utf8")) as WaitRecord[]) this.recs.set(r.key, r);
    } catch { /* first run, or unreadable: start empty */ }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.recs.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(key: string): WaitRecord | undefined { return this.recs.get(key); }
  all(): WaitRecord[] { return [...this.recs.values()]; }
  pending(): WaitRecord[] { return this.all().filter((r) => r.status === "waiting" || r.status === "resuming"); }

  /** Schedule (or reschedule) a wait. Never creates a second record for the same agent run. */
  schedule(r: Omit<WaitRecord, "status" | "waits" | "waited_s"> & Partial<Pick<WaitRecord, "waits" | "waited_s">>): WaitRecord {
    const prev = this.recs.get(r.key);
    const rec: WaitRecord = { ...r, waits: (prev?.waits ?? r.waits ?? 0) + 1, waited_s: prev?.waited_s ?? r.waited_s ?? 0, status: "waiting" };
    this.recs.set(r.key, rec);
    this.save();
    return rec;
  }

  /**
   * Claim a due wait for resumption. Returns the record only the first time: a second claim (duplicate timer,
   * restart racing a live timer) gets undefined, so a task is never resumed twice.
   */
  claim(key: string, now: Date = new Date()): WaitRecord | undefined {
    const r = this.recs.get(key);
    if (!r || r.status !== "waiting" || new Date(r.next_retry_at).getTime() > now.getTime()) return undefined;
    r.status = "resuming";
    this.save();
    return r;
  }

  finish(key: string, outcome: NonNullable<WaitRecord["outcome"]>, now: Date = new Date()): void {
    const r = this.recs.get(key);
    if (!r) return;
    r.status = outcome === "cancelled" ? "cancelled" : "resumed";
    r.outcome = outcome;
    r.resumed_at = now.toISOString();
    r.waited_s += Math.max(0, Math.round((now.getTime() - new Date(r.detected_at).getTime()) / 1000));
    this.save();
  }

  /** Waits that are due (e.g. after a restart): the caller claims each before acting. */
  due(now: Date = new Date()): WaitRecord[] {
    return this.recs.size ? this.all().filter((r) => r.status === "waiting" && new Date(r.next_retry_at).getTime() <= now.getTime()) : [];
  }

  /** After a restart a "resuming" record whose resume never completed goes back to waiting (due now). */
  recoverInterrupted(): number {
    let n = 0;
    for (const r of this.recs.values()) if (r.status === "resuming") { r.status = "waiting"; n++; }
    if (n) this.save();
    return n;
  }
}

/** Convenience used by the supervisor: classify text and decide. */
export function assess(text: string, now?: Date): { c: ClassifiedError; action: ReturnType<typeof recoveryFor> } {
  const c = classifyProviderError(text, now);
  return { c, action: recoveryFor(c.cls) };
}
