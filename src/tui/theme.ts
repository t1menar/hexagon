/**
 * Hexagon design system: terminal capabilities, semantic colour tokens, state vocabulary and glyph sets.
 * Components use tokens (via `S` in canvas.ts), never raw colour codes.
 */
import type { AgentState } from "../contracts/types.js";

export type ColorDepth = 0 | 16 | 256 | 16777216;
export type MotionMode = "full" | "reduced" | "off";

export interface Caps {
  color: ColorDepth;
  unicode: boolean;
  ssh: boolean;
  motion: MotionMode;
  /** Frame-rate ceiling for animation. 0 = no animation. */
  fps: number;
  startupAnimation: boolean;
}

type Env = Record<string, string | undefined>;

export function detectCaps(env: Env = process.env, isTTY = Boolean(process.stdout.isTTY), over: { animation?: string; startup?: boolean } = {}): Caps {
  const term = env.TERM ?? "";
  let color: ColorDepth;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") color = 0;
  else if (term === "dumb" || (!isTTY && !env.FORCE_COLOR)) color = 0;
  else if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) color = 16777216;
  else if (/256color/.test(term) || env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "Apple_Terminal") color = env.TERM_PROGRAM === "iTerm.app" ? 16777216 : 256;
  else color = 16;
  const locale = `${env.LC_ALL ?? ""}${env.LC_CTYPE ?? ""}${env.LANG ?? ""}`;
  const unicode = env.HEXAGON_ASCII !== "1" && term !== "linux" && term !== "dumb" && (/utf-?8/i.test(locale) || env.TERM_PROGRAM !== undefined || locale === "");
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  const req = (env.HEXAGON_ANIMATION ?? over.animation ?? "auto").toLowerCase();
  let motion: MotionMode;
  if (req === "off" || env.NO_MOTION || !isTTY || term === "dumb") motion = "off";
  else if (req === "reduced" || env.REDUCE_MOTION || ssh) motion = "reduced";
  else motion = req === "full" ? "full" : "reduced"; // "auto" is deliberately calm: full motion is opt-in
  if (req === "full" && !env.NO_MOTION && isTTY && term !== "dumb") motion = "full";
  const fps = motion === "full" ? 15 : motion === "reduced" ? 8 : 0;
  const startupAnimation = (over.startup ?? true) && env.HEXAGON_STARTUP !== "off" && motion === "full";
  return { color, unicode, ssh, motion, fps, startupAnimation };
}

// ───────────── colour ─────────────

export type Rgb = readonly [number, number, number];

/** Semantic tokens. Restrained, dark-terminal-friendly; provider identity is always text, never colour alone. */
export const TOKENS = {
  brand: [79, 209, 197] as Rgb,      // teal: Hexagon identity, selection accents
  brand2: [139, 124, 246] as Rgb,    // violet: secondary identity (reviewers, integration)
  text: [215, 222, 233] as Rgb,
  muted: [122, 134, 153] as Rgb,
  border: [70, 82, 101] as Rgb,
  surface: [30, 38, 51] as Rgb,      // selected row / header background
  surface2: [24, 30, 41] as Rgb,
  success: [74, 222, 128] as Rgb,
  warning: [246, 176, 74] as Rgb,
  error: [242, 100, 111] as Rgb,
  active: [90, 169, 255] as Rgb,
  waiting: [180, 142, 173] as Rgb,
  info: [125, 207, 255] as Rgb,
};
export type Token = keyof typeof TOKENS;

const BASE16: [Rgb, number][] = [
  [[0, 0, 0], 30], [[205, 49, 49], 31], [[13, 188, 121], 32], [[229, 229, 16], 33], [[36, 114, 200], 34], [[188, 63, 188], 35], [[17, 168, 205], 36], [[229, 229, 229], 37],
  [[102, 102, 102], 90], [[241, 76, 76], 91], [[35, 209, 139], 92], [[245, 245, 67], 93], [[59, 142, 234], 94], [[214, 112, 214], 95], [[41, 184, 219], 96], [[255, 255, 255], 97],
];

const dist = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
function to256(c: Rgb): number {
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  const [r, g, b] = [q(c[0]), q(c[1]), q(c[2])];
  const cube = 16 + 36 * r + 6 * g + b;
  const lvl = [0, 95, 135, 175, 215, 255];
  const cubeRgb: Rgb = [lvl[r]!, lvl[g]!, lvl[b]!];
  const gray = Math.round((c[0] + c[1] + c[2]) / 3);
  const gi = Math.max(0, Math.min(23, Math.round((gray - 8) / 10)));
  const grayRgb: Rgb = [8 + gi * 10, 8 + gi * 10, 8 + gi * 10];
  return dist(c, grayRgb) < dist(c, cubeRgb) ? 232 + gi : cube;
}

/** SGR parameters for an rgb colour at the given depth ("" when colour is off). */
export function sgr(c: Rgb, depth: ColorDepth, bg = false): string {
  if (depth === 0) return "";
  if (depth === 16777216) return `${bg ? 48 : 38};2;${c[0]};${c[1]};${c[2]}`;
  if (depth === 256) return `${bg ? 48 : 38};5;${to256(c)}`;
  const nearest = BASE16.reduce((best, cur) => (dist(c, cur[0]) < dist(c, best[0]) ? cur : best));
  return String(bg ? nearest[1] + 10 : nearest[1]);
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t));
  return [Math.round(lerp(a[0], b[0], k)), Math.round(lerp(a[1], b[1], k)), Math.round(lerp(a[2], b[2], k))];
}

export type Styles = {
  reset: ""; dim: string; bold: string; inverse: string;
  gray: string; blue: string; cyan: string; green: string; magenta: string; orange: string; yellow: string; red: string; white: string;
  bgSel: string; bgBar: string; border: string; brand2: string; info: string;
};

/** The style table the components use. Names are historical; each maps to a semantic token. */
export function buildStyles(depth: ColorDepth): Styles {
  const f = (t: Token) => sgr(TOKENS[t], depth);
  const b = (t: Token) => sgr(TOKENS[t], depth, true);
  return {
    reset: "", dim: "2", bold: "1", inverse: "7",
    gray: f("muted"), blue: f("active"), cyan: f("brand"), green: f("success"), magenta: f("waiting"), orange: f("warning"),
    yellow: f("warning"), red: f("error"), white: f("text"), bgSel: b("surface"), bgBar: b("surface2"), border: f("border"), brand2: f("brand2"), info: f("info"),
  };
}

// ───────────── state vocabulary ─────────────

export interface StateLook { symbol: string; ascii: string; token: Token; label: string }

export const STATE_LOOK: Record<AgentState, StateLook> = {
  queued: { symbol: "○", ascii: "o", token: "muted", label: "QUEUED" },
  starting: { symbol: "◔", ascii: "~", token: "info", label: "STARTING" },
  running: { symbol: "●", ascii: "*", token: "active", label: "WORKING" },
  waiting_input: { symbol: "?", ascii: "?", token: "warning", label: "NEEDS YOU" },
  paused: { symbol: "‖", ascii: "|", token: "waiting", label: "PAUSED" },
  waiting_quota: { symbol: "◷", ascii: "Q", token: "waiting", label: "WAITING · LIMIT" },
  verifying: { symbol: "◑", ascii: "v", token: "info", label: "VERIFYING" },
  reviewing: { symbol: "◐", ascii: "r", token: "brand2", label: "IN REVIEW" },
  merging: { symbol: "⇢", ascii: ">", token: "brand2", label: "INTEGRATING" },
  done: { symbol: "✔", ascii: "+", token: "success", label: "DONE" },
  failed: { symbol: "✖", ascii: "x", token: "error", label: "FAILED" },
  blocked: { symbol: "⊘", ascii: "!", token: "warning", label: "BLOCKED" },
  cancelled: { symbol: "−", ascii: "-", token: "muted", label: "CANCELLED" },
};

/** Lifecycle group used by the agent navigator. */
export type Group = "analysis" | "implementation" | "review" | "integration";
export const GROUPS: { id: Group; title: string }[] = [
  { id: "analysis", title: "ANALYSIS" },
  { id: "implementation", title: "IMPLEMENTATION" },
  { id: "review", title: "REVIEW" },
  { id: "integration", title: "INTEGRATION" },
];
export function groupOfRole(role: string): Group {
  switch (role) {
    case "planner": case "init": case "lead": return "analysis";
    case "reviewer": return "review";
    case "integrator": case "resolver": return "integration";
    default: return "implementation";
  }
}

export interface Glyphs { hexSmall: string; hexSmallActive: string; hexMicro: string; dot: string; arrow: string; bar: [string, string]; ring: string; ellipsis: string }
export function glyphs(unicode: boolean): Glyphs {
  return unicode
    ? { hexSmall: "⬡", hexSmallActive: "⬢", hexMicro: "⬡", dot: "•", arrow: "▸", bar: ["━", "─"], ring: "◌", ellipsis: "…" }
    : { hexSmall: "o", hexSmallActive: "O", hexMicro: ".", dot: "*", arrow: ">", bar: ["=", "-"], ring: "o", ellipsis: "..." };
}

/** Replace non-ASCII characters on a finished frame (used for the ASCII fallback). */
const ASCII_MAP: Record<string, string> = {
  "─": "-", "┌": "+", "┐": "+", "└": "+", "┘": "+", "━": "=", "│": "|", "┃": "|", "╭": "+", "╮": "+", "╰": "+", "╯": "+", "├": "+", "┤": "+", "┬": "+", "┴": "+", "┼": "+",
  "═": "=", "║": "|", "╔": "+", "╗": "+", "╚": "+", "╝": "+", "╠": "+", "╣": "+", "╦": "+", "╩": "+", "╬": "+",
  "╱": "/", "╲": "\\", "╌": "-", "▸": ">", "▌": "|", "•": "*", "●": "*", "◉": "*", "◌": "o", "○": "o", "◔": "~", "◑": "v", "◐": "r", "◷": "Q",
  "✔": "+", "✖": "x", "⊘": "!", "‖": "|", "−": "-", "⇢": ">", "…": "~", "⬡": "o", "⬢": "O", "■": "#", "▪": "+", "▲": "^", "△": "^", "↩": "<", "╎": ":", "┄": "-", "┆": ":", "⏳": "Q", "›": ">", "↵": "<", "·": "-", "→": "->", "↑": "^", "↓": "v", "⠋": "-", "⠙": "\\", "⠹": "|", "⠸": "/", "⠼": "-", "⠴": "\\", "⠦": "|", "⠧": "/", "⠇": "-", "⠏": "\\",
  "◆": "*", "⚒": "#", "⚠": "!", "✉": "@", "↻": "~", "⏱": "t", "━━": "==",
};
export function asciiFold(s: string): string {
  let out = "";
  for (const ch of s) out += ch.charCodeAt(0) < 128 ? ch : ASCII_MAP[ch] ?? "?";
  return out;
}
