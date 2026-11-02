/** A character grid with per-cell SGR styles, rendered to ANSI lines. */

import { buildStyles, detectCaps, type Caps } from "./theme.js";

/** Process-wide capabilities, detected once. Tests build their own with buildStyles/detectCaps. */
export const CAPS: Caps = detectCaps();
/** Style table: every entry resolves a semantic design token for this terminal (see theme.ts). */
export const S = buildStyles(CAPS.color);

const UP = 1, RIGHT = 2, DOWN = 4, LEFT = 8;
/** One border family: straight rules, rounded corners, tees and a cross. */
const BITS_GLYPH: Record<number, string> = {
  [RIGHT | LEFT]: "─", [RIGHT]: "─", [LEFT]: "─", [UP | DOWN]: "│", [UP]: "│", [DOWN]: "│",
  [RIGHT | DOWN]: "╭", [LEFT | DOWN]: "╮", [UP | RIGHT]: "╰", [UP | LEFT]: "╯",
  [UP | DOWN | RIGHT]: "├", [UP | DOWN | LEFT]: "┤", [LEFT | RIGHT | DOWN]: "┬", [LEFT | RIGHT | UP]: "┴", [UP | DOWN | LEFT | RIGHT]: "┼",
};
const GLYPH_BITS = new Map<string, number>([
  ["─", RIGHT | LEFT], ["│", UP | DOWN], ["╭", RIGHT | DOWN], ["╮", LEFT | DOWN], ["╰", UP | RIGHT], ["╯", UP | LEFT],
  ["├", UP | DOWN | RIGHT], ["┤", UP | DOWN | LEFT], ["┬", LEFT | RIGHT | DOWN], ["┴", LEFT | RIGHT | UP], ["┼", UP | DOWN | LEFT | RIGHT],
]);

export const st = (...codes: string[]) => codes.filter(Boolean).join(";");

export class Canvas {
  readonly chars: string[][];
  readonly styles: string[][];
  private readonly ruleBits = new Map<number, number>();

  constructor(readonly w: number, readonly h: number) {
    this.chars = Array.from({ length: h }, () => Array<string>(w).fill(" "));
    this.styles = Array.from({ length: h }, () => Array<string>(w).fill(""));
  }

  set(x: number, y: number, ch: string, style = ""): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.chars[y]![x] = ch;
    this.styles[y]![x] = style;
  }

  /** Write text; returns the x after the last char. Clips at maxX. */
  text(x: number, y: number, s: string, style = "", maxX = this.w): number {
    let cx = x;
    for (const ch of s) {
      if (cx >= maxX) break;
      this.set(cx, y, ch === "\n" || ch === "\t" ? " " : ch, style);
      cx++;
    }
    return cx;
  }

  fill(x: number, y: number, w: number, h: number, style: string, ch = " "): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, ch, style);
  }

  /** Rounded box. Title is drawn into the top border. */
  box(x: number, y: number, w: number, h: number, style: string, title?: string, titleStyle?: string): void {
    if (w < 2 || h < 2) return;
    this.set(x, y, "╭", style);
    this.set(x + w - 1, y, "╮", style);
    this.set(x, y + h - 1, "╰", style);
    this.set(x + w - 1, y + h - 1, "╯", style);
    for (let i = 1; i < w - 1; i++) {
      this.set(x + i, y, "─", style);
      this.set(x + i, y + h - 1, "─", style);
    }
    for (let j = 1; j < h - 1; j++) {
      this.set(x, y + j, "│", style);
      this.set(x + w - 1, y + j, "│", style);
    }
    if (title) this.text(x + 2, y, ` ${title} `, titleStyle ?? style, x + w - 2);
  }

  /**
   * Horizontal rule of `w` cells. Where it meets another rule the cell becomes the right junction (├ ┤ ┬ ┴ ┼ or a rounded
   * corner); text already on the cell is never overwritten. The ends only point inward, so a rule that ends on a vertical
   * rule makes a tee or a corner, and a free end stays a plain `─`.
   */
  hrule(x: number, y: number, w: number, style: string): void {
    for (let i = 0; i < w; i++) this.join(x + i, y, (i < w - 1 ? RIGHT : 0) | (i > 0 ? LEFT : 0) || (RIGHT | LEFT), style);
  }
  /** Vertical rule of `h` cells; same junction rules as `hrule`. */
  vrule(x: number, y: number, h: number, style: string): void {
    for (let j = 0; j < h; j++) this.join(x, y + j, (j < h - 1 ? DOWN : 0) | (j > 0 ? UP : 0) || (UP | DOWN), style);
  }
  /** Merge line directions into the cell (blank cells and other line glyphs only). */
  private join(x: number, y: number, bits: number, style: string): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const cur = this.chars[y]![x]!;
    const key = y * this.w + x;
    // A free end draws as a full line glyph, so the real directions are remembered instead of read back from the glyph.
    const mem = this.ruleBits.get(key);
    const have = cur === " " ? 0 : mem !== undefined && BITS_GLYPH[mem] === cur ? mem : GLYPH_BITS.get(cur);
    if (have === undefined) return; // text: leave it
    this.ruleBits.set(key, have | bits);
    this.set(x, y, BITS_GLYPH[have | bits] ?? "┼", style);
  }

  /** Copy another canvas into this one (clipped). */
  blit(src: Canvas, x: number, y: number, srcX = 0, srcY = 0, w = src.w, h = src.h): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const sx = srcX + i;
        const sy = srcY + j;
        if (sx >= src.w || sy >= src.h || sx < 0 || sy < 0) continue;
        this.set(x + i, y + j, src.chars[sy]![sx]!, src.styles[sy]![sx]!);
      }
    }
  }

  lines(color = true): string[] {
    const out: string[] = [];
    for (let y = 0; y < this.h; y++) {
      const chars = this.chars[y]!, styles = this.styles[y]!;
      if (!color) { out.push(chars.join("").replace(/\s+$/, "")); continue; }
      // A trailing run of unstyled blanks becomes one "erase to end of line" instead of N spaces.
      let end = this.w;
      while (end > 0 && styles[end - 1] === "" && chars[end - 1] === " ") end--;
      let line = "";
      let cur = "";
      for (let x = 0; x < end; x++) {
        const st = styles[x]!;
        if (st !== cur) { line += st ? `\x1b[0;${st}m` : "\x1b[0m"; cur = st; }
        line += chars[x];
      }
      out.push(line + (cur ? "\x1b[0m" : "") + (end < this.w ? "\x1b[K" : ""));
    }
    return out;
  }
}

/** Cut a string to n visible chars (code points) with an ellipsis. */
export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ");
  const cps = [...one];
  if (cps.length <= n) return one;
  return n <= 1 ? cps.slice(0, n).join("") : cps.slice(0, n - 1).join("") + "…";
}

export function padTo(s: string, n: number): string {
  const len = [...s].length;
  return len >= n ? clip(s, n) : s + " ".repeat(n - len);
}

/** Word-wrap to width (hard-breaks long words). */
export function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  const len = (t: string) => (/^[\x20-\x7e]*$/.test(t) ? t.length : [...t].length);
  for (const para of s.split("\n")) {
    let line = "", lineLen = 0;
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      let w = word, wl = len(w);
      while (wl > width) {
        if (line) { out.push(line); line = ""; lineLen = 0; }
        const cps = [...w];
        out.push(cps.slice(0, width).join(""));
        w = cps.slice(width).join("");
        wl = cps.length - width;
      }
      if (!line) { line = w; lineLen = wl; }
      else if (lineLen + 1 + wl <= width) { line += " " + w; lineLen += 1 + wl; }
      else { out.push(line); line = w; lineLen = wl; }
    }
    out.push(line);
  }
  return out;
}
