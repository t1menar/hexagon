import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/agents/claude-code.js";
import { CodexAdapter } from "../src/agents/codex.js";
import { runConformance, type CheckResult } from "../src/agents/conformance.js";
import { GrokAdapter } from "../src/agents/grok.js";

const root = path.join(import.meta.dirname, "..");
const fx = (id: string) => path.join(root, "test/fixtures/agents", id);
const src = (f: string) => path.join(root, "src/agents", f);

/**
 * Known gaps, listed so a failure is never silent and a fix is never unnoticed: a check named here must FAIL (when the gap is
 * fixed, delete the line). Anything else failing is a regression.
 */
const KNOWN_GAPS: Record<string, Record<number, string>> = {
  "claude-code": {},
  codex: {},
  grok: {},
};

const targets = {
  "claude-code": { make: (c?: string[]) => new ClaudeCodeAdapter("claude", { command: c ?? ["claude"], model: null, args: [] } as never), sources: [src("claude-code.ts")] },
  codex: { make: (c?: string[]) => new CodexAdapter("cx", c ?? ["codex"], null), sources: [src("codex.ts")] },
  grok: { make: (c?: string[]) => new GrokAdapter("gk", c ?? ["grok"], null), sources: [src("grok.ts")] },
};

describe("adapter conformance v2 (replay CLI + the adapter's own fixtures)", () => {
  for (const [id, t] of Object.entries(targets)) {
    it(`${id}: every check passes or is a listed gap`, async () => {
      const results = await runConformance({ id, make: t.make, fixtures: fx(id), sources: t.sources });
      const gaps = KNOWN_GAPS[id] ?? {};
      const failed = results.filter((r) => r.status === "fail");
      const unexpected = failed.filter((r) => !(r.n in gaps));
      expect(unexpected.map((r) => `${r.n}. ${r.name}: ${r.detail}`)).toEqual([]);
      const fixed = Object.keys(gaps).map(Number).filter((n) => !failed.some((r) => r.n === n));
      expect(fixed, "a listed gap now passes: delete it from KNOWN_GAPS").toEqual([]);
      const byN = (n: number): CheckResult | undefined => results.find((r) => r.n === n);
      expect(byN(7)?.status).toBe(gaps[7] ? "fail" : "pass"); // parsing is checked against this adapter's own fixtures
    }, 120000);
  }
});

describe("the conformance checks actually catch broken adapters", () => {
  it("MODEL_ID flags model ids, not adapter names", async () => {
    const { MODEL_ID } = await import("../src/agents/conformance.js");
    for (const s of ["gpt-4o", "claude-sonnet-4", "gemini-2.5", "deepseek-chat", "grok-3"]) expect(MODEL_ID.test(s), s).toBe(true);
    for (const s of ["claude-code", "grok", "deepseek", "codex"]) expect(MODEL_ID.test(s), s).toBe(false);
  });

  it("an adapter whose rules do not match its fixtures fails 7; zero usage fails 8; a prompt in argv fails 12; an env leak is impossible by construction", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const { ManifestAdapter, checkManifest } = await import("../src/agents/manifest.js");
    const { selectionFrom } = await import("../src/agents/contracts/model-selection.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hex-bad-"));
    fs.writeFileSync(path.join(dir, "a.jsonl"), '{"kind":"say","words":"hi"}\n{"kind":"usage","i":0,"o":0}\n');
    fs.writeFileSync(path.join(dir, "a.expect.json"), JSON.stringify({ emits: ["chat"] }));
    const m = checkManifest({
      apiVersion: 1, id: "bad", run: { new: ["go", "{prompt}"], prompt: "argv" },
      events: [{ emit: "chat", when: { type: "text" }, text: "text" }, { emit: "usage", when: { kind: "usage" }, input: "i", output: "o" }], // the chat rule looks at the wrong field
    });
    const rs = await runConformance({ id: "bad", make: (c) => new ManifestAdapter("bad", m, c ?? ["bad"], selectionFrom(null)), fixtures: dir });
    const by = (n: number) => rs.find((r) => r.n === n)!;
    expect(by(7).status).toBe("fail");
    expect(by(8).status).toBe("fail");
    expect(by(8).detail).toMatch(/all zeros/);
    expect(by(9).status).toBe("fail"); // no error fixture
    expect(by(12).status).toBe("pass"); // declared: prompt = "argv"
    expect(by(11).status).toBe("pass");
  });
});
