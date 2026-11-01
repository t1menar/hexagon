import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Vendor and CLI names belong to the integration that owns them. Everything else (core, daemon, TUI, CLI text, prompts,
// schemas) must read the same whichever agent is configured.
const VENDOR = /\b(claude|anthropic|openai|chatgpt|codex|gemini|grok|copilot|xai)\b/i;
const root = path.join(import.meta.dirname, "..");
const ADAPTER_FILES = new Set(["src/agents/claude-code.ts", "src/agents/codex.ts", "src/agents/grok.ts"]);
// The one place that must list the shipped integrations by file name, and the linter that has to name vendors to forbid them.
const EXEMPT = new Set(["src/agents/registry.ts", "src/core/promptlint.ts"]);

function files(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? files(rel) : [rel];
  });
}

describe("provider neutrality", () => {
  const scanned = [...files("src"), ...files("templates"), ...files("schemas")].filter((f) => /\.(ts|md|json)$/.test(f));

  it("no vendor name outside the integration files, the registry and the config template", () => {
    const hits: string[] = [];
    for (const f of scanned) {
      if (ADAPTER_FILES.has(f) || EXEMPT.has(f)) continue;
      fs.readFileSync(path.join(root, f), "utf8").split("\n").forEach((line, i) => {
        if (VENDOR.test(line) && !line.includes("// legacy-name")) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the shipped integrations are the only ones that name themselves", () => {
    for (const f of ADAPTER_FILES) expect(fs.existsSync(path.join(root, f))).toBe(true);
  });
});

describe("old configs keep working", () => {
  it("[agents.claude] with adapter = \"claude\" loads and still resolves", async () => {
    const os = await import("node:os");
    const { loadConfig } = await import("../src/core/config.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hx-legacy-"));
    const file = path.join(dir, "config.toml");
    fs.writeFileSync(file, '[agents.claude]\nadapter = "claude"\nprovider = "anthropic"\n\n[roles.developer]\nagent = "claude"\n');
    const cfg = loadConfig(file);
    expect(cfg.roles.developer?.agent).toBe("claude");
    expect(cfg.agents.claude?.adapter).not.toBe("claude");
    expect(cfg.agents.claude?.adapter).toBeTruthy();
  });
});
