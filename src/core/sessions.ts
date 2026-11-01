import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionInfo, TokenCause, TokenCounts } from "../contracts/types.js";
import { appendJsonl, atomicWriteJson, ensureDir, nowIso, readJson } from "../util/fsx.js";

/** One logical agent session, kept per agent identity for the whole project. Persisted so a daemon restart resumes it. */
export interface SessionRecord {
  agentId: string;
  role: string;
  adapterId: string;
  model: string | null;
  /** Hash of everything that defines the agent (role prompt, protocol, skills). A change starts a new session. */
  promptHash: string;
  nativeSessionId: string;
  /** The CLI confirmed it created the session. Until then the id is reused for a fresh create, never resumed. */
  confirmed: boolean;
  /** Directory the session was created in (matters only for adapters that cannot resume across directories). */
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  turns: number;
  /** Size of the conversation after the latest model call (input + cached), in tokens. */
  contextTokens: number;
  compactions: number;
  /** `turns` value at the last compaction. */
  lastCompactionTurn: number;
  /** What this session has already been told, so later tasks only get the difference. */
  seen: { skills: string[]; others: string; notes: { run: string; lines: number } | null; state: string };
  ledger: Partial<Record<TokenCause, TokenCounts>>;
  /** Set by reset(): the next use creates a new session and logs this reason. */
  pendingReset?: string;
  /** Why the current native id has not been confirmed yet (e.g. "compacted"). */
  startReason?: string;
  /** The user asked for /compact: done at the next safe point. */
  compactRequested?: boolean;
}

export interface SessionSpec {
  agentId: string;
  role: string;
  adapterId: string;
  model: string | null;
  promptHash: string;
  cwd: string;
  resumeAcrossCwd: boolean;
  supportsResume: boolean;
}

export interface Resolution {
  sessionId: string;
  resume: boolean;
  mode: "new" | "resumed";
  /** Why a new session was created (null when resumed). */
  reason: string | null;
  record: SessionRecord;
}

export type SessionEvent =
  | { ts: string; agent: string; kind: "created"; reason: string; session: string }
  | { ts: string; agent: string; kind: "resumed"; session: string; turns: number }
  | { ts: string; agent: string; kind: "compacted"; session: string; previous: string; compactions: number }
  | { ts: string; agent: string; kind: "reset"; reason: string; session: string };

const emptySeen = (): SessionRecord["seen"] => ({ skills: [], others: "", notes: null, state: "" });

/** agent id -> session, one JSON file each under .hexagon/sessions/. */
export class SessionRegistry {
  private records = new Map<string, SessionRecord>();

  constructor(private dir: string) {
    ensureDir(dir);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const r = readJson<SessionRecord>(path.join(dir, f));
      if (r?.agentId) this.records.set(r.agentId, { ...r, seen: { ...emptySeen(), ...r.seen }, ledger: r.ledger ?? {} });
    }
  }

  get(agentId: string): SessionRecord | undefined {
    return this.records.get(agentId);
  }

  all(): SessionRecord[] {
    return [...this.records.values()];
  }

  private save(r: SessionRecord): void {
    atomicWriteJson(path.join(this.dir, `${r.agentId}.json`), r);
  }

  private log(e: SessionEvent): void {
    appendJsonl(path.join(this.dir, "events.jsonl"), e);
  }

  events(): SessionEvent[] {
    const f = path.join(this.dir, "events.jsonl");
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
  }

  /**
   * Decide whether the identity continues its session. A new session is created only when there is none, the agent
   * itself changed (adapter, model, prompt), the adapter cannot resume from this directory, or it was reset/unrecoverable.
   */
  resolve(spec: SessionSpec): Resolution {
    const cur = this.records.get(spec.agentId);
    const fresh = (reason: string): Resolution => {
      const id = cur && !cur.confirmed && cur.adapterId === spec.adapterId && cur.promptHash === spec.promptHash ? cur.nativeSessionId : randomUUID();
      const r: SessionRecord = {
        agentId: spec.agentId, role: spec.role, adapterId: spec.adapterId, model: spec.model, promptHash: spec.promptHash,
        nativeSessionId: id, confirmed: false, cwd: spec.cwd, createdAt: nowIso(), lastUsedAt: nowIso(),
        turns: 0, contextTokens: 0, compactions: 0, lastCompactionTurn: 0, seen: emptySeen(), ledger: cur?.ledger ?? {},
      };
      this.records.set(spec.agentId, r);
      this.save(r);
      this.log({ ts: nowIso(), agent: spec.agentId, kind: "created", reason, session: id });
      return { sessionId: id, resume: false, mode: "new", reason, record: r };
    };
    if (!cur) return fresh("first use of this agent");
    if (cur.pendingReset) return fresh(cur.pendingReset);
    if (cur.adapterId !== spec.adapterId) return fresh(`agent changed from ${cur.adapterId} to ${spec.adapterId}`);
    if (cur.model !== spec.model) return fresh(`model changed (${cur.model ?? "default"} → ${spec.model ?? "default"})`);
    if (cur.promptHash !== spec.promptHash) return fresh("the agent's prompt or skills changed");
    if (!spec.supportsResume) return fresh("this adapter cannot resume sessions");
    if (!cur.confirmed) {
      // The CLI never confirmed this id: create it (again) under the same id.
      return { sessionId: cur.nativeSessionId, resume: false, mode: "new", reason: cur.startReason ?? "the previous start was not confirmed by the CLI", record: cur };
    }
    if (!spec.resumeAcrossCwd && cur.cwd !== spec.cwd) return fresh("this adapter cannot resume a session from another working directory (one session per directory)");
    cur.lastUsedAt = nowIso();
    cur.cwd = spec.cwd;
    this.save(cur);
    this.log({ ts: nowIso(), agent: spec.agentId, kind: "resumed", session: cur.nativeSessionId, turns: cur.turns });
    return { sessionId: cur.nativeSessionId, resume: true, mode: "resumed", reason: null, record: cur };
  }

  /** The CLI confirmed the session exists. */
  confirm(agentId: string): void {
    const r = this.records.get(agentId);
    if (r && !r.confirmed) { r.confirmed = true; this.save(r); }
  }

  /** One model call finished: remember how big the conversation is now. */
  recordUsage(agentId: string, u: { input: number; cache_read: number; output: number; cause: TokenCause; step: boolean }): void {
    const r = this.records.get(agentId);
    if (!r) return;
    const l = (r.ledger[u.cause] ??= { input: 0, cache_read: 0, output: 0 });
    l.input += u.input; l.cache_read += u.cache_read; l.output += u.output;
    if (u.step) {
      r.turns += 1;
      r.contextTokens = u.input + u.cache_read + u.output;
    }
    r.lastUsedAt = nowIso();
    this.save(r);
  }

  /** What the session was told so far, for delta prompts. */
  markSeen(agentId: string, patch: Partial<SessionRecord["seen"]>): void {
    const r = this.records.get(agentId);
    if (!r) return;
    r.seen = { ...r.seen, ...patch };
    this.save(r);
  }

  /** The conversation was replaced by a summary: a new native session, the identity (and its counters) stays. */
  compacted(agentId: string): string {
    const r = this.records.get(agentId);
    if (!r) throw new Error(`no session for ${agentId}`);
    const previous = r.nativeSessionId;
    r.nativeSessionId = randomUUID();
    r.confirmed = false;
    r.startReason = "compacted";
    r.compactRequested = false;
    r.compactions += 1;
    r.lastCompactionTurn = r.turns;
    r.contextTokens = 0;
    r.seen = emptySeen();
    this.save(r);
    this.log({ ts: nowIso(), agent: agentId, kind: "compacted", session: r.nativeSessionId, previous, compactions: r.compactions });
    return r.nativeSessionId;
  }

  requestCompact(agentId: string): boolean {
    const r = this.records.get(agentId);
    if (!r) return false;
    r.compactRequested = true;
    this.save(r);
    return true;
  }

  /** Give up compacting this session for now (the summary failed): avoid retrying on every turn. */
  skipCompaction(agentId: string): void {
    const r = this.records.get(agentId);
    if (!r) return;
    r.compactRequested = false;
    r.lastCompactionTurn = r.turns;
    this.save(r);
  }

  /** The user (or the provider, "unrecoverable") ends the session: the next use creates a new one. */
  reset(agentId: string, reason: string): boolean {
    const r = this.records.get(agentId);
    if (!r) return false;
    r.pendingReset = reason;
    this.save(r);
    this.log({ ts: nowIso(), agent: agentId, kind: "reset", reason, session: r.nativeSessionId });
    return true;
  }

  info(agentId: string, mode: "new" | "resumed", reason: string | null, windowTokens: number): SessionInfo {
    const r = this.records.get(agentId);
    return {
      agent: agentId, mode, reason, turns: r?.turns ?? 0, ctx_tokens: r?.contextTokens ?? 0,
      ctx_pct: r ? Math.min(1, r.contextTokens / windowTokens) : 0, compactions: r?.compactions ?? 0,
    };
  }
}

export interface Lease { agentId: string; release(): void }

/**
 * Agent identities per role. A session cannot run in two processes at once, so parallel tasks of one role get
 * different identities (implementer-1, implementer-2, …); sequential tasks reuse the first free one.
 */
export class IdentityPool {
  private busy = new Set<string>();
  private known = new Map<string, Set<string>>();

  constructor(private registry: SessionRegistry) {
    for (const r of registry.all()) this.add(r.role, r.agentId);
  }

  private add(role: string, id: string): void {
    if (!this.known.has(role)) this.known.set(role, new Set());
    this.known.get(role)!.add(id);
  }

  /** `prefer`: the identity a retried or continued task last used (its context is the most relevant). */
  acquire(role: string, prefer?: string | null): Lease {
    const ids = [...(this.known.get(role) ?? [])].sort((a, b) => num(a) - num(b));
    let pick = prefer && ids.includes(prefer) && !this.busy.has(prefer) ? prefer : ids.find((i) => !this.busy.has(i));
    if (!pick) {
      pick = `${role}-${ids.length ? Math.max(...ids.map(num)) + 1 : 1}`;
      this.add(role, pick);
    }
    this.busy.add(pick);
    const id = pick;
    let released = false;
    return { agentId: id, release: () => { if (!released) { released = true; this.busy.delete(id); } } };
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }
}

const num = (id: string) => Number(/-(\d+)$/.exec(id)?.[1] ?? 0);
