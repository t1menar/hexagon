import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { atomicWriteJson, appendJsonl } from "../src/util/fsx.js";
import { redact, redactDeep } from "../src/util/redact.js";

// Built from parts so this file does not itself look like a leaked credential.
const SHAPES: Record<string, string> = {
  anthropic: "sk-" + "ant-api03-" + "A1b2C3d4E5f6G7h8I9j0K1l2",
  openai: "sk-" + "proj-" + "A1b2C3d4E5f6G7h8I9j0K1l2",
  stripe: "sk_" + "live_" + "A1b2C3d4E5f6G7h8I9j0K1l2",
  github: "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3",
  githubPat: "github_pat_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3",
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  google: "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5",
  slack: "xoxb-" + "1234567890-abcdefghij",
  jwt: "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dBjftJeZ4CVPmB92K27uhbUJU1p1r",
  bearer: "Bearer " + "abcdEFGH1234ijklMNOP5678",
  urlCreds: "postgres://admin:hunter2pass@db.example.com/app",
  envLine: "STRIPE_SECRET_KEY=" + "abcdef123456",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----",
};

describe("redaction", () => {
  for (const [name, s] of Object.entries(SHAPES)) {
    it(`removes a ${name} shaped secret`, () => {
      const out = redact(`before ${s} after`);
      expect(out).toContain("[redacted]");
      expect(out).not.toContain(s.slice(8));
    });
  }

  it("leaves ordinary text, hashes and token counters alone", () => {
    const v = { text: "run npm test in src/auth", hash: "a".repeat(40), input_tokens: 4000, cache_read_tokens: 12, budget_tokens: 100000, note: "the token budget is low" };
    expect(redactDeep(v)).toBe(v);
  });

  it("redacts values under secret-looking keys but not numbers", () => {
    expect(redactDeep({ api_key: "abcdefgh1234", password: "x" , n: 1 })).toEqual({ api_key: "[redacted]", password: "x", n: 1 });
  });

  it("events, transcripts and status are written redacted, and stay valid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hx-red-"));
    const ev = path.join(dir, "events.jsonl"), st = path.join(dir, "status.json");
    appendJsonl(ev, { type: "tool", command: `curl -H "Authorization: ${SHAPES.bearer}" password=hunter22222` });
    atomicWriteJson(st, { activity: `export ${SHAPES.envLine}`, env: { GITHUB_TOKEN: SHAPES.github } });
    for (const f of [ev, st]) {
      const raw = fs.readFileSync(f, "utf8");
      expect(() => JSON.parse(raw.split("\n")[0]!.startsWith("{") && f === ev ? raw.split("\n")[0]! : raw)).not.toThrow();
      for (const s of ["hunter22222", "abcdef123456", SHAPES.github!.slice(8), "abcdEFGH1234"]) expect(raw).not.toContain(s);
    }
  });
});
