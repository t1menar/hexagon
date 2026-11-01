import { describe, expect, it } from "vitest";
import { MouseFilter, parseMouse, type MouseEvent } from "../src/tui/input.js";

function run(chunks: string[]): { out: string; events: MouseEvent[] } {
  const f = new MouseFilter();
  const events: MouseEvent[] = [];
  let out = "";
  f.on("mouse", (e: MouseEvent) => events.push(e));
  f.on("data", (d: Buffer | string) => { out += d.toString(); });
  for (const c of chunks) f.write(c);
  return { out, events };
}

describe("mouse input", () => {
  it("decodes wheel, press, release and drag with 0-based cells", () => {
    expect(parseMouse(64, 10, 5, "M")).toEqual({ kind: "wheel", button: 0, dir: -1, x: 9, y: 4 });
    expect(parseMouse(65, 1, 1, "M")).toMatchObject({ kind: "wheel", dir: 1 });
    expect(parseMouse(0, 3, 4, "M")).toEqual({ kind: "press", button: 0, x: 2, y: 3 });
    expect(parseMouse(0, 3, 4, "m")).toMatchObject({ kind: "release" });
    expect(parseMouse(32, 3, 4, "M")).toMatchObject({ kind: "drag" });
  });
  it("removes reports from the key stream and keeps the typing around them", () => {
    const { out, events } = run(["ab\x1b[<64;20;7Mcd\x1b[<0;3;4M\x1b[<0;3;4m"]);
    expect(out).toBe("abcd");
    expect(events.map((e) => e.kind)).toEqual(["wheel", "press", "release"]);
  });
  it("handles a report split across reads, and never swallows a lone Escape that is followed by text", () => {
    const split = run(["x\x1b[<65;1", "2;9Mz"]);
    expect(split.out).toBe("xz");
    expect(split.events).toHaveLength(1);
    expect(split.events[0]).toMatchObject({ kind: "wheel", dir: 1, x: 11, y: 8 });
    const keys = run(["\x1b[A", "\x1bq"]);
    expect(keys.out).toBe("\x1b[A\x1bq");
    expect(run(["\x1b"]).out).toBe("\x1b"); // Escape on its own is delivered at once, not held back
  });
});
