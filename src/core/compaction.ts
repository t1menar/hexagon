import type { ContextConfig } from "./config.js";
import type { SessionRecord } from "./sessions.js";

/** The message that asks a session to summarise itself. Adapters (and the mock) recognise the tag. */
export const COMPACT_TAG = "<hexagon_compact_request>";

export function compactRequest(): string {
  return `${COMPACT_TAG}
Hexagon is compacting this conversation to save context. Reply with ONE message and run no tools or commands. Use exactly these sections, at most 350 words in total:
## Decisions — choices made and why (names, interfaces, trade-offs)
## Done — what is finished and verified
## Open — what is unfinished or uncertain
## Gotchas — pitfalls found (commands that fail, files to avoid, conventions)
Facts only; the task card, acceptance criteria and changed files are re-sent separately.
</hexagon_compact_request>`;
}

export interface CompactDecision { compact: boolean; why: string }

/**
 * Should this session be compacted before its next turn? Pure, so it is unit-tested without an adapter.
 * `requested` is the user's /compact; it overrides the threshold (but not mode "off" for automatic runs).
 */
export function shouldCompact(cx: ContextConfig, rec: Pick<SessionRecord, "contextTokens" | "turns" | "lastCompactionTurn" | "windowTokens">, requested: boolean): CompactDecision {
  if (requested) return { compact: true, why: "requested with /compact" };
  if (cx.mode !== "auto") return { compact: false, why: `mode is ${cx.mode}` };
  const pct = rec.contextTokens / (rec.windowTokens ?? cx.assumed_window_tokens);
  if (pct < cx.compact_at) return { compact: false, why: "below the threshold" };
  if (rec.turns - rec.lastCompactionTurn < cx.min_turns_between) return { compact: false, why: "compacted recently" };
  return { compact: true, why: `context at ${Math.round(pct * 100)}% (limit ${Math.round(cx.compact_at * 100)}%)` };
}
