import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe } from "vitest";
import { ClaudeCodeAdapter } from "../src/agents/claude-code.js";
import { CodexAdapter } from "../src/agents/codex.js";
import { GrokAdapter } from "../src/agents/grok.js";
import { conformance } from "./adapter-conformance.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hex-conf-"));
/** A stand-in CLI: prints one assistant line (and usage if asked) and exits; hangs when FAKE_HANG is set. */
const fake = path.join(dir, "fakecli");
fs.writeFileSync(fake, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
if (process.env.FAKE_HANG) { setInterval(() => {}, 1000); }
else setTimeout(() => {
  const lines = [{ type: "thread.started", thread_id: "th-conf" }, { type: "item.completed", item: { type: "agent_message", text: "hello" } }, { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }];
  process.stdout.write(lines.map((l) => JSON.stringify(l)).join("\\n") + "\\n");
  process.exit(0);
}, 20);
process.stdin.on("end", () => {});
`);
fs.chmodSync(fake, 0o755);

describe("adapter conformance", () => {
  // The fake CLIs end the process themselves; the adapter reports "finished" and nothing waits for "ready".
  conformance({ name: "codex", make: (cmd) => new CodexAdapter("cx", cmd ?? [fake], null), usage: "reported", real: false });
  conformance({ name: "grok", make: (cmd) => new GrokAdapter("gk", cmd ?? [fake], null), usage: "unknown", real: false });

  // Real CLI: only when asked for. `HEXAGON_REAL_CLI=claude npx vitest run test/conformance.test.ts` (spends a few cents).
  const real = (process.env.HEXAGON_REAL_CLI ?? "").split(",").map((s) => s.trim());
  if (real.includes("claude")) {
    conformance({
      name: "claude", real: true, usage: "reported",
      make: (cmd) => new ClaudeCodeAdapter("claude", { command: cmd ?? ["claude"], model: null, args: [] } as never),
      semantic: { first: "Remember the code word PINEAPPLE. Reply with just: noted.", second: "What was the code word? Reply with just the word.", expect: /PINEAPPLE/i },
    });
  }
});
