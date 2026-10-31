import type { StampedEvent } from "../contracts/types.js";
import type { SessionStatus } from "../core/solo.js";
import { S, st, wrap } from "./canvas.js";
import { STATE_COLOR, STATE_GLYPH } from "./dag.js";

export interface ChatItem {
  ts: string;
  kind: "agent" | "user" | "hexagon" | "tool" | "state" | "question" | "error" | "info";
  text: string;
  style?: string;
  messageId?: string;
}

export interface ChatLine { text: string; style: string }

/** Normalize agent events into conversation items. */
export function itemsFromEvents(events: StampedEvent[]): { items: ChatItem[]; acked: Set<string> } {
  const items: ChatItem[] = [];
  const acked = new Set<string>();
  for (const e of events) {
    const ev = e.event;
    const ts = e.ts;
    switch (ev.type) {
      case "chat": items.push({ ts, kind: ev.from, text: ev.text, messageId: ev.message_id }); break;
      case "tool_call": items.push({ ts, kind: "tool", text: ev.summary }); break;
      case "tool_result": if (!ev.ok) items.push({ ts, kind: "tool", text: `✖ ${ev.summary}`, style: st(S.red, S.dim) }); break;
      case "progress": items.push({ ts, kind: "tool", text: ev.text, style: S.gray }); break;
      case "status_report": if (ev.activity) items.push({ ts, kind: "info", text: `${ev.phase ? `[${ev.phase}] ` : ""}${ev.activity}` }); break;
      case "state":
        if (["queued", "starting"].includes(ev.state)) break;
        items.push({ ts, kind: "state", text: `${STATE_GLYPH[ev.state]} ${ev.state.replace("_", " ")}${ev.reason ? ` — ${ev.reason}` : ""}`, style: STATE_COLOR[ev.state] });
        break;
      case "question":
        items.push({ ts, kind: "question", text: `${ev.question.question_id}: ${ev.question.prompt}${ev.question.options?.length ? "\n" + ev.question.options.map((o) => `${o.id}) ${o.label}`).join("   ") : ""}` });
        break;
      case "error": items.push({ ts, kind: "error", text: `${ev.kind}: ${ev.message}` }); break;
      case "message_acked": acked.add(ev.message_id); break;
      case "controller": items.push({ ts, kind: "state", text: ev.controller === "user" ? "you took over this session" : "agent back in control", style: S.magenta }); break;
    }
  }
  return { items, acked };
}

export function itemsFromSession(s: SessionStatus): ChatItem[] {
  return s.feed.map((f) => ({
    ts: f.ts,
    kind: f.kind === "agent" ? "agent" : f.kind === "user" ? "user" : f.kind === "tool" || f.kind === "text" ? "tool" : f.kind === "error" ? "error" : "info",
    text: f.text,
    style: f.kind === "text" ? S.gray : undefined,
  }));
}

const clean = (s: string) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^#+\s*/gm, "");
const hhmm = (ts: string) => new Date(ts).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit" });

/** Render a conversation: speaker headers, wrapped text, folded tool steps. */
export function chatLines(items: ChatItem[], width: number, agentName: string, acked: Set<string> = new Set(), finished = false): ChatLine[] {
  const out: ChatLine[] = [];
  const w = Math.max(10, width - 2);
  let lastSpeaker = "";
  let tools: ChatItem[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    const shown = tools.length > 4 ? tools.slice(-3) : tools;
    if (tools.length > 4) out.push({ text: `  ▸ … ${tools.length - 3} earlier step(s)`, style: S.gray });
    for (const t of shown) out.push({ text: `  ${t.style ? "" : "▸ "}${t.text}`.slice(0, width), style: t.style ?? st(S.blue, S.dim) });
    tools = [];
  };
  const header = (who: string, label: string, style: string, ts: string) => {
    if (lastSpeaker === who) return;
    out.push({ text: "", style: "" });
    out.push({ text: `${label}  ${hhmm(ts)}`, style });
    lastSpeaker = who;
  };
  for (const it of items) {
    if (it.kind === "tool" || it.kind === "info") {
      if (it.kind === "info") { flushTools(); out.push({ text: `  · ${it.text}`, style: S.cyan }); continue; }
      tools.push(it);
      continue;
    }
    flushTools();
    switch (it.kind) {
      case "agent":
        header("agent", `◆ ${agentName}`, st(S.blue, S.bold), it.ts);
        for (const l of wrap(clean(it.text), w)) out.push({ text: `  ${l}`, style: "" });
        break;
      case "user": {
        header(`user${it.ts}`, "› you", st(S.white, S.bold), it.ts);
        const lines = wrap(it.text, w);
        lines.forEach((l, i) => out.push({ text: `  ${l}${i === lines.length - 1 && it.messageId ? (acked.has(it.messageId) ? "  ✓ received" : finished ? "  ✗ not delivered" : "  · queued") : ""}`, style: S.white }));
        lastSpeaker = "user";
        break;
      }
      case "hexagon":
        header(`hex${it.ts}`, "⬡ hexagon", st(S.cyan, S.bold), it.ts);
        for (const l of wrap(it.text, w)) out.push({ text: `  ${l}`, style: S.gray });
        lastSpeaker = "hexagon";
        break;
      case "question":
        out.push({ text: "", style: "" });
        for (const [i, l] of wrap(it.text, w - 2).entries()) out.push({ text: `${i === 0 ? "? " : "  "}${l}`, style: st(S.orange, S.bold) });
        lastSpeaker = "";
        break;
      case "state":
        out.push({ text: `── ${it.text} ──`.slice(0, width), style: it.style ?? S.gray });
        lastSpeaker = "";
        break;
      case "error":
        for (const l of wrap(`⚠ ${it.text}`, w)) out.push({ text: `  ${l}`, style: S.orange });
        break;
    }
  }
  flushTools();
  while (out.length && !out[0]!.text) out.shift();
  return out;
}
