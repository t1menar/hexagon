import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testIntegrity } from "../src/core/integrity.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
function repo(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "hx-int-"));
  git(d, "init", "-q", "-b", "main");
  write(d, files);
  git(d, "add", "-A"); git(d, "commit", "-qm", "base");
  return d;
}
const write = (d: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } };

describe("test integrity", () => {
  const base = { "src/a.ts": "export const a = 1;\n", "test/a.test.ts": 'it("a", () => {\n  expect(a).toBe(1);\n  expect(a).toBeGreaterThan(0);\n});\n', "test/b.test.ts": 'it("b", () => { expect(1).toBe(1); });\n' };

  it("flags a deleted test, an added skip, and removed assertions — and nothing for an honest change", async () => {
    const d = repo(base);
    const b = git(d, "rev-parse", "HEAD");
    fs.rmSync(path.join(d, "test/b.test.ts"));
    write(d, { "test/a.test.ts": 'it.skip("a", () => {\n  expect(a).toBe(1);\n});\n' });
    git(d, "add", "-A"); git(d, "commit", "-qm", "weaken");
    const flags = await testIntegrity(d, b);
    expect(flags.map((f) => f.kind).sort()).toEqual(["assertions_removed", "deleted_test", "skip_added"]);
    expect(flags.find((f) => f.kind === "deleted_test")!.file).toBe("test/b.test.ts");
  });

  it("adding tests and assertions is clean", async () => {
    const d = repo(base);
    const b = git(d, "rev-parse", "HEAD");
    write(d, { "test/a.test.ts": base["test/a.test.ts"] + 'it("c", () => { expect(2).toBe(2); expect(3).toBe(3); });\n', "src/a.ts": "export const a = 2;\n" });
    git(d, "add", "-A"); git(d, "commit", "-qm", "more");
    expect(await testIntegrity(d, b)).toEqual([]);
  });

  it("knows other languages", async () => {
    const d = repo({ "tests/test_x.py": "def test_x():\n    assert f() == 1\n", "x_test.go": "package x\nfunc TestX(t *testing.T) { t.Fatal(1) }\n" });
    const b = git(d, "rev-parse", "HEAD");
    write(d, { "tests/test_x.py": "import pytest\n@pytest.mark.skip\ndef test_x():\n    pass\n" });
    fs.rmSync(path.join(d, "x_test.go"));
    git(d, "add", "-A"); git(d, "commit", "-qm", "weaken");
    const flags = await testIntegrity(d, b);
    expect(flags.map((f) => `${f.kind}:${f.file}`).sort()).toEqual(["assertions_removed:tests/test_x.py", "deleted_test:x_test.go", "skip_added:tests/test_x.py"]);
  });
});
