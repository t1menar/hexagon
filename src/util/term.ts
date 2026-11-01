import type { AgentState } from "../contracts/types.js";

const env = process.env;

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

export function plainMode(): boolean {
  return env.HEXAGON_PLAIN === "1" || env.CI === "true" || env.TERM === "dumb" || !process.stdout.isTTY;
}

const on = colorEnabled();
const wrap = (open: number, close: number) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);

// Colorblind-safe: blue/orange/magenta carry meaning; glyph + word always accompany color.
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  orange: (s: string) => (on ? `\x1b[38;5;208m${s}\x1b[39m` : s),
  magenta: wrap(35, 39),
  gray: wrap(90, 39),
  inverse: wrap(7, 27),
};

export const STATE_STYLE: Record<AgentState, { glyph: string; color: (s: string) => string }> = {
  queued: { glyph: "◌", color: c.gray },
  starting: { glyph: "◔", color: c.cyan },
  running: { glyph: "●", color: c.blue },
  waiting_input: { glyph: "?", color: c.orange },
  paused: { glyph: "‖", color: c.magenta },
  waiting_quota: { glyph: "⏳", color: c.orange },
  verifying: { glyph: "◑", color: c.cyan },
  reviewing: { glyph: "◐", color: c.cyan },
  merging: { glyph: "⇢", color: c.cyan },
  done: { glyph: "✔", color: c.blue },
  failed: { glyph: "✖", color: c.orange },
  blocked: { glyph: "⊘", color: c.orange },
  cancelled: { glyph: "−", color: c.gray },
};

export function stateLabel(state: AgentState): string {
  const s = STATE_STYLE[state];
  return s.color(`${s.glyph} ${state.replace(/_/g, " ")}`);
}

export function pad(s: string, n: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return visible >= n ? s : s + " ".repeat(n - visible);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
