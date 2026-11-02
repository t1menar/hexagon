import type { ReviewVerdict } from "../contracts/types.js";

/**
 * Stable "is this the same failure again?" signals. Free text changes from one attempt to the next (wording, counts,
 * durations, paths), so a signature built from it never matches and a loop never looks stuck. These use only what
 * identifies a failure: the command and the names of what failed, or the files and severities a reviewer flagged.
 */
const FAIL_LINE = /^\s*(?:[✗×✖❌]|FAIL\b|FAILED\b|--- FAIL:|not ok\b|\d+\)\s|E\s+|AssertionError|Error:|error(?:\[\w+\])?:)\s*(.*)$/i;

const norm = (s: string): string =>
  s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\(\d+(?:\.\d+)?\s*m?s\)/g, "").replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds)\b/g, "")
    .replace(/0x[0-9a-f]+/gi, "#").replace(/\b[0-9a-f]{7,40}\b/g, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 120);

export function failureSignature(cmd: string, code: number, output: string): string {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const m = FAIL_LINE.exec(line);
    if (m) { const n = norm(`${line.trim().split(/\s+/)[0]} ${m[1] ?? ""}`); if (n) names.add(n); }
    if (names.size >= 20) break;
  }
  if (!names.size) for (const l of output.split("\n").filter((x) => x.trim()).slice(-3)) names.add(norm(l));
  return `verify:${cmd}:${code}:${[...names].sort().join("|")}`;
}

export function reviewSignature(rv: Pick<ReviewVerdict, "findings">): string {
  const pairs = rv.findings.filter((f) => f.severity !== "low").map((f) => `${f.file ?? "?"}:${f.severity}`);
  return `review:${[...new Set(pairs)].sort().join("|")}`;
}
