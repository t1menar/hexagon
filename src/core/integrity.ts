import { git } from "./git.js";
import { matchesAny } from "../util/fsx.js";

/** Per-language defaults for "this file is a test". Replaced by `[run] test_globs` when set. */
export const DEFAULT_TEST_GLOBS = [
  "**/*.test.*", "**/*.spec.*", "**/__tests__/**", "test/**", "tests/**", "**/test/**", "**/tests/**",
  "**/test_*.py", "**/*_test.py", "**/*_test.go", "**/*Test.java", "**/*Tests.java", "**/*_spec.rb", "**/*_test.rb",
];

export interface IntegrityFlag { kind: "deleted_test" | "skip_added" | "assertions_removed"; file: string; detail: string }

const SKIP = /\b(?:it|test|describe|context)\.(?:skip|todo|only)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bt\.Skip(?:Now)?\(|@Disabled\b|@Ignore\b|\bpending\s*\(|\.only\s*\(/;
const ASSERT = /\bexpect\s*\(|\bassert[A-Za-z_]*\s*[(.]|\bassert\s|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\b|\brequire\.\w+\(|\bshould\b|\bXCTAssert/;

/**
 * Tests that were deleted, skipped or weakened between `base` and HEAD. These are not failures (a test can be removed for a
 * good reason); they are shown to the reviewer and in the report so that they are looked at.
 */
export async function testIntegrity(cwd: string, base: string, testGlobs: string[] = DEFAULT_TEST_GLOBS): Promise<IntegrityFlag[]> {
  const flags: IntegrityFlag[] = [];
  const ns = await git(cwd, ["diff", "--name-status", "--no-renames", `${base}...HEAD`]);
  if (!ns.ok) return flags;
  const status = new Map<string, string>();
  for (const line of ns.stdout.split("\n")) {
    const [s, f] = line.split("\t");
    if (s && f && matchesAny(f, testGlobs)) status.set(f, s);
  }
  for (const [f, s] of status) if (s === "D") flags.push({ kind: "deleted_test", file: f, detail: "test file deleted" });
  const changed = [...status].filter(([, s]) => s !== "D").map(([f]) => f);
  if (!changed.length) return flags;
  const d = await git(cwd, ["diff", "-U0", "--no-color", "--no-renames", `${base}...HEAD`, "--", ...changed]);
  let file = "";
  const removed = new Map<string, number>(), added = new Map<string, number>();
  for (const line of d.stdout.split("\n")) {
    const h = /^\+\+\+ b\/(.+)$/.exec(line);
    if (h) { file = h[1]!; continue; }
    if (!file || line.startsWith("---") || line.startsWith("+++")) continue;
    const body = line.slice(1);
    if (line.startsWith("+")) {
      if (SKIP.test(body)) flags.push({ kind: "skip_added", file, detail: `skip/only marker added: ${body.trim().slice(0, 80)}` });
      if (ASSERT.test(body)) added.set(file, (added.get(file) ?? 0) + 1);
    } else if (line.startsWith("-") && ASSERT.test(body)) removed.set(file, (removed.get(file) ?? 0) + 1);
  }
  for (const [f, n] of removed) {
    const net = n - (added.get(f) ?? 0);
    if (net > 0) flags.push({ kind: "assertions_removed", file: f, detail: `${net} more assertion line(s) removed than added` });
  }
  return flags;
}

export const describeFlags = (flags: IntegrityFlag[]): string[] => flags.map((f) => `${f.kind.replace(/_/g, " ")} — ${f.file}: ${f.detail}`);
