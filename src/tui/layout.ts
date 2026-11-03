/** Responsive regions of the dashboard. Pure: tests assert that regions never overlap and always fit the screen. */
export interface Region { x: number; y: number; w: number; h: number }
export type LayoutMode = "large" | "medium" | "small";

export interface DashLayout {
  mode: LayoutMode;
  header: Region;
  /** Agent navigator (null in small mode: replaced by `strip`). */
  agents: Region | null;
  network: Region;
  /** Inspector for the selected agent (null when collapsed). */
  inspector: Region | null;
  /** One-line selected-agent summary used when there is no agent panel. */
  strip: Region | null;
  activity: Region | null;
  /** 1-3 lines of agent-bus traffic above the chat, in layouts that have no activity panel (medium, small). */
  busStrip: Region | null;
  chat: Region;
  input: Region;
}

/** Rows the bus strip may take. */
export const MAX_BUS_ROWS = 3;

/** Rows the input box may grow to (a notice line above and a key hint below come on top). */
export const MAX_INPUT_ROWS = 6;

export function computeLayout(W: number, H: number, o: { inspector?: boolean; inputRows?: number; /** bus strip rows wanted (0 = none); only medium and small layouts have room for it */ busRows?: number; /** minimal chrome: neighbouring panels share one rule (their regions overlap by the border cells) */ shared?: boolean } = {}): DashLayout {
  const L = baseLayout(W, H, o);
  if (!o.shared) return L;
  // Shared rules: a panel's frame is drawn on its edge cells, so the neighbour's frame must be the same cells. Interiors keep their size.
  const { agents, network, inspector, activity, chat, strip, busStrip } = L;
  if (agents) {
    network.x -= 1; network.w += 1;
    if (activity) { activity.x -= 1; activity.w += 2; } else { chat.x -= 1; chat.w += 1; if (busStrip) { busStrip.x -= 1; busStrip.w += 1; } }
  }
  if (inspector) { network.w += 1; inspector.h += 1; }
  network.h += 1; // the network's bottom rule is the band's top rule
  void strip;
  return L;
}

function baseLayout(W: number, H: number, o: { inspector?: boolean; inputRows?: number; busRows?: number } = {}): DashLayout {
  const mode: LayoutMode = W >= 150 && H >= 30 ? "large" : W >= 100 && H >= 22 ? "medium" : "small";
  const inputH = 2 + Math.max(1, Math.min(MAX_INPUT_ROWS, o.inputRows ?? 1));
  const header: Region = { x: 0, y: 0, w: W, h: 1 };
  const input: Region = { x: 0, y: H - inputH, w: W, h: inputH };
  const body = H - 1 - inputH;
  const leftW = mode === "small" ? 0 : mode === "large" ? 40 : 36;
  // The inspector only opens when the network keeps at least 60 columns.
  const wantInspector = (mode === "large" ? o.inspector !== false : mode === "medium" ? Boolean(o.inspector) : false) && W - leftW - (mode === "large" ? 38 : 32) >= 60;
  const rightW = wantInspector ? (mode === "large" ? 38 : 32) : 0;
  const bandH = mode === "large" ? Math.max(8, Math.min(14, Math.round(body * 0.3))) : mode === "medium" ? Math.max(6, Math.min(10, Math.round(body * 0.3))) : Math.max(5, Math.min(8, Math.round(body * 0.35)));
  const strip: Region | null = mode === "small" ? { x: 0, y: 1, w: W, h: 1 } : null;
  const topY = 1 + (strip ? 1 : 0);
  const netH = Math.max(3, body - bandH - (strip ? 1 : 0));
  const centerX = leftW;
  const centerW = W - leftW - rightW;
  const network: Region = { x: centerX, y: topY, w: centerW, h: netH };
  const agents: Region | null = leftW ? { x: 0, y: topY, w: leftW, h: body - (strip ? 1 : 0) } : null;
  const inspector: Region | null = rightW ? { x: W - rightW, y: topY, w: rightW, h: netH } : null;
  const bandY = topY + netH;
  const bandX = leftW;
  const bandW = W - leftW;
  const actW = mode === "large" ? Math.floor(bandW * 0.4) : 0;
  // In large mode the left panel runs full height; the band sits under network + inspector.
  const activity: Region | null = actW ? { x: bandX, y: bandY, w: actW, h: bandH } : null;
  const chat: Region = { x: bandX + actW, y: bandY, w: bandW - actW, h: bandH };
  if (agents) agents.h = body - (strip ? 1 : 0);
  // The strip takes rows off the top of the chat band, and only if the chat keeps at least 4 rows.
  let busStrip: Region | null = null;
  const want = Math.max(0, Math.min(MAX_BUS_ROWS, o.busRows ?? 0));
  if (!activity && want > 0) {
    const rows = Math.min(want, chat.h - 4);
    if (rows > 0) { busStrip = { x: chat.x, y: chat.y, w: chat.w, h: rows }; chat.y += rows; chat.h -= rows; }
  }
  return { mode, header, agents, network, inspector, strip, activity, busStrip, chat, input };
}

export const overlaps = (a: Region, b: Region) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
