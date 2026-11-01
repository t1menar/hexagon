/** A character grid with per-cell SGR styles, rendered to ANSI lines. */

import { buildStyles, detectCaps, type Caps } from "./theme.js";

/** Process-wide capabilities, detected once. Tests build their own with buildStyles/detectCaps. */
export const CAPS: Caps = detectCaps();
/** Style table: every entry resolves a semantic design token for this terminal (see theme.ts). */
export const S = buildStyles(CAPS.color);

export const st = (...codes: string[]) => codes.filter(Boolean).join(";");

export class Canvas {
  readonly chars: string[][];
  readonly styles: string[][];

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
      let line = "";
      let cur = "";
      for (let x = 0; x < this.w; x++) {
        const s = this.styles[y]![x]!;
        if (color && s !== cur) {
          line += `\x1b[0m${s ? `\x1b[${s}m` : ""}`;
          cur = s;
        }
        line += this.chars[y]![x];
      }
      out.push(color ? line + "\x1b[0m" : line.replace(/\s+$/, ""));
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
  for (const para of s.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      let w = word;
      while ([...w].length > width) {
        if (line) { out.push(line); line = ""; }
        out.push([...w].slice(0, width).join(""));
        w = [...w].slice(width).join("");
      }
      if (!line) line = w;
      else if ([...line].length + 1 + [...w].length <= width) line += " " + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}
