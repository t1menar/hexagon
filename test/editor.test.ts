import { describe, expect, it } from "vitest";
import { layoutInput, lineBounds, moveVertical, windowRows } from "../src/tui/editor.js";

describe("multiline input", () => {
  it("wraps long lines and keeps the cursor on the right row", () => {
    const v = layoutInput("abcdefgh", 5, 4);
    expect(v.rows).toEqual(["abcd", "efgh"]);
    expect([v.cursorRow, v.cursorCol]).toEqual([1, 1]);
  });
  it("a cursor at the wrap point is at the start of the next row; at the very end it stays after the last char", () => {
    expect(layoutInput("abcdefgh", 4, 4)).toMatchObject({ cursorRow: 1, cursorCol: 0 });
    expect(layoutInput("abcd", 4, 4)).toMatchObject({ rows: ["abcd"], cursorRow: 0, cursorCol: 4 });
  });
  it("newlines make rows, including empty ones", () => {
    const v = layoutInput("a\n\nb", 3, 10);
    expect(v.rows).toEqual(["a", "", "b"]);
    expect([v.cursorRow, v.cursorCol]).toEqual([2, 0]);
  });
  it("moves between logical lines and keeps the column when it can", () => {
    const t = "hello\nhi\nworld";
    expect(moveVertical(t, 4, 1)).toBe(8); // col 4 → end of "hi"
    expect(moveVertical(t, 12, -1)).toBe(8);
    expect(moveVertical(t, 2, -1)).toBeNull();
    expect(moveVertical(t, 13, 1)).toBeNull();
    expect(lineBounds(t, 7)).toEqual({ start: 6, end: 8 });
  });
  it("shows a window around the cursor when the input is taller than the room", () => {
    const v = layoutInput("1\n2\n3\n4\n5\n6", 11, 10);
    expect(windowRows(v, 3)).toEqual({ rows: ["4", "5", "6"], top: 3 });
    expect(windowRows(layoutInput("1\n2", 0, 10), 3).top).toBe(0);
  });
});
