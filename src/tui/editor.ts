/** Pure helpers for the multiline input box: wrapping, cursor placement, vertical movement. Indexes are string (UTF-16) indexes, like the input state. */

export interface InputView {
  /** Visual rows of the input, wrapped to the width. */
  rows: string[];
  cursorRow: number;
  cursorCol: number;
}

/** Wrap `text` (which may contain newlines) to `width` columns and find where the cursor lands. */
export function layoutInput(text: string, cursor: number, width: number): InputView {
  const w = Math.max(1, width);
  const rows: string[] = [];
  let cur = "";
  let curLen = 0;
  let cursorRow = 0, cursorCol = 0;
  let idx = 0;
  for (const ch of text) {
    if (idx === cursor) { cursorRow = rows.length; cursorCol = curLen; }
    if (ch === "\n") { rows.push(cur); cur = ""; curLen = 0; idx += ch.length; continue; }
    if (curLen >= w) {
      rows.push(cur);
      cur = "";
      curLen = 0;
      // The cursor sat at the wrap point: it belongs to the start of the new row.
      if (idx === cursor) { cursorRow = rows.length; cursorCol = 0; }
    }
    cur += ch;
    curLen++;
    idx += ch.length;
  }
  if (cursor >= text.length) { cursorRow = rows.length; cursorCol = curLen; }
  rows.push(cur);
  return { rows, cursorRow, cursorCol };
}

/** Start and end of the logical line that contains `cursor`. */
export function lineBounds(text: string, cursor: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", cursor - 1) + 1;
  const nl = text.indexOf("\n", cursor);
  return { start, end: nl < 0 ? text.length : nl };
}

/** Move the cursor one logical line up (-1) or down (1), keeping the column; null when there is no such line. */
export function moveVertical(text: string, cursor: number, dir: -1 | 1): number | null {
  const { start, end } = lineBounds(text, cursor);
  const col = cursor - start;
  if (dir < 0) {
    if (start === 0) return null;
    const prev = lineBounds(text, start - 1);
    return Math.min(prev.start + col, prev.end);
  }
  if (end >= text.length) return null;
  const next = lineBounds(text, end + 1);
  return Math.min(next.start + col, next.end);
}

/** The rows to draw when the input is taller than the room: a window that keeps the cursor row visible. */
export function windowRows(view: InputView, max: number): { rows: string[]; top: number } {
  if (view.rows.length <= max) return { rows: view.rows, top: 0 };
  const top = Math.min(Math.max(0, view.cursorRow - max + 1), view.rows.length - max);
  return { rows: view.rows.slice(top, top + max), top };
}
