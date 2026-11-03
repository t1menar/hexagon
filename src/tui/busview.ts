/**
 * What the dashboard shows of the agent bus: a ring buffer of envelopes keyed by id (a state change replaces the
 * entry, it never adds a second one), one-line renderings, and the blocking waits. Pure, so tests can drive it.
 */
import type { DeliveryState } from "../contracts/types.js";
import type { Envelope } from "../core/bus.js";

/** The part of an envelope the dashboard needs. The daemon pushes full envelopes; `bus.read` returns these rows. */
export interface BusRow {
  id: string;
  ts: string;
  kind: string;
  from: string;
  /** Task id, `@role`, `#topic` or `all`. */
  to: string;
  subject: string;
  state: DeliveryState;
  blocking: boolean;
  /** Router messages that carried it: its real recipients (for fan-out). */
  message_ids?: string[];
}

export const rowOf = (e: Envelope): BusRow => ({
  id: e.id, ts: e.ts, kind: e.kind, from: e.from,
  to: e.to.agent ?? (e.to.role ? `@${e.to.role}` : e.to.topic ? `#${e.to.topic}` : "all"),
  subject: e.subject, state: e.state, blocking: Boolean(e.blocking), message_ids: e.message_ids,
});

export const STATE_GLYPH: Record<DeliveryState, [string, string]> = {
  queued: ["⏳", "..."], delivered: ["✓", "ok"], acked: ["✓✓", "ok"], expired: ["⌛", "exp"], rejected: ["✖", "no"],
};

export class BusLog {
  private rows = new Map<string, BusRow>();
  private order: string[] = [];
  constructor(readonly cap = 200) {}

  /** A new envelope is added; one already known has its state (and recipients) updated in place. */
  apply(e: Envelope | BusRow): "new" | "updated" {
    const row = "from" in e && "to" in e && typeof e.to === "string" ? (e as BusRow) : rowOf(e as Envelope);
    const had = this.rows.has(row.id);
    this.rows.set(row.id, row);
    if (!had) {
      this.order.push(row.id);
      while (this.order.length > this.cap) this.rows.delete(this.order.shift()!);
    }
    return had ? "updated" : "new";
  }

  load(rows: Iterable<Envelope | BusRow>): void {
    for (const r of rows) this.apply(r);
  }

  get size(): number { return this.order.length; }
  get(id: string): BusRow | undefined { return this.rows.get(id); }

  list(o: { task?: string; blockingOnly?: boolean } = {}): BusRow[] {
    return this.order.map((id) => this.rows.get(id)!).filter((r) => (!o.task || r.from === o.task || r.to === o.task) && (!o.blockingOnly || r.blocking));
  }
}

const clip = (s: string, n: number) => (n <= 0 ? "" : s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

/** `B-12 T-1 → T-3 question "which format?" ⏳` */
export function busLine(r: BusRow, width: number, unicode = true): string {
  const arrow = unicode ? "→" : "->";
  const g = STATE_GLYPH[r.state][unicode ? 0 : 1];
  const head = `${r.id} ${r.from} ${arrow} ${r.to} ${r.kind}${r.blocking ? "!" : ""} `;
  const tail = ` ${g}`;
  const room = width - head.length - tail.length;
  return `${head}${clip(`"${r.subject}"`, Math.max(6, room))}${tail}`.slice(0, Math.max(0, width));
}

export const waitLine = (w: { from: string; for: string }, unicode = true): string => `${unicode ? "⏳" : "..."} ${w.from} waits for ${w.for}`;

/** The 1-3 line strip under the network in layouts without an activity panel: waits first, then the newest envelopes. */
export function busStrip(log: BusLog, waiting: { from: string; for: string }[], width: number, maxLines: number, unicode = true): string[] {
  const lines: string[] = [];
  for (const w of waiting.slice(0, Math.max(0, maxLines - 1) || 1)) lines.push(waitLine(w, unicode));
  const room = maxLines - lines.length;
  if (room > 0) for (const r of log.list().slice(-room).reverse()) lines.push(busLine(r, width, unicode));
  return lines.slice(0, maxLines).map((l) => clip(l, width));
}

/** Per task: how many messages sit unread in its inbox, and who it waits for. Drives the badge on cards and in the list. */
export function badgeFor(task: string, inboxPending: number, waiting: { from: string; for: string }[], unicode = true): string {
  const w = waiting.find((x) => x.from === task);
  return [inboxPending > 0 ? `${unicode ? "✉" : "m"}${inboxPending}` : "", w ? `${unicode ? "⏳" : ".."}${w.for}` : ""].filter(Boolean).join(" ");
}
