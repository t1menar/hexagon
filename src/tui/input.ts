import { Transform, type TransformCallback } from "node:stream";

/** A mouse event from the terminal (SGR reporting). Coordinates are 0-based screen cells. */
export interface MouseEvent {
  kind: "press" | "release" | "drag" | "wheel";
  /** 0 left, 1 middle, 2 right (press/release/drag). */
  button: number;
  /** wheel only: -1 up, 1 down. */
  dir?: -1 | 1;
  x: number;
  y: number;
}

export const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";

const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** The start of a mouse report that has not fully arrived yet. */
const PARTIAL = /\x1b\[<[\d;]*$/;

export function parseMouse(b: number, x: number, y: number, final: string): MouseEvent | null {
  if (b & 64) return { kind: "wheel", button: 0, dir: (b & 1) === 0 ? -1 : 1, x: x - 1, y: y - 1 };
  const button = b & 3;
  if (b & 32) return { kind: "drag", button, x: x - 1, y: y - 1 };
  return { kind: final === "m" ? "release" : "press", button, x: x - 1, y: y - 1 };
}

/**
 * Sits between stdin and the key decoder: takes mouse reports out of the byte stream (so they never reach the input
 * box as stray characters) and emits them as `mouse` events. Everything else passes through unchanged.
 */
export class MouseFilter extends Transform {
  private carry = "";

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    let text = this.carry + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    this.carry = "";
    // A report split across two reads: hold the tail back until the rest arrives.
    const tail = PARTIAL.exec(text);
    if (tail && tail.index > text.length - 24) { this.carry = text.slice(tail.index); text = text.slice(0, tail.index); }
    const rest = text.replace(SGR, (_m, b: string, x: string, y: string, f: string) => {
      const e = parseMouse(Number(b), Number(x), Number(y), f);
      if (e) this.emit("mouse", e);
      return "";
    });
    if (rest) this.push(rest);
    cb();
  }
}
