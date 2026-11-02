import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/contracts/types.js";
import { createAdapter } from "../src/agents/registry.js";
import { applyRules, checkManifest, expand, loadManifestFile } from "../src/agents/manifest.js";
import { loadPlugins, pluginErrors } from "../src/agents/plugins.js";
import { ADAPTER_API_VERSION, defineAdapter } from "../src/agents/sdk.js";
import { loadConfig } from "../src/core/config.js";
import { ctx } from "./adapter-conformance.js";

const EXAMPLE = path.resolve(import.meta.dirname, "../examples/adapters/example.toml");

/** A project dir with .hexagon/config.toml, a fake `examplecli` and the example manifest copied to ./adapters. */
function project(config: string, extra: Record<string, string> = {}): { root: string; cli: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hex-plugin-"));
  fs.mkdirSync(path.join(root, ".hexagon"), { recursive: true });
  fs.mkdirSync(path.join(root, "adapters"), { recursive: true });
  fs.copyFileSync(EXAMPLE, path.join(root, "adapters/example.toml"));
  const cli = path.join(root, "fake-example-cli");
  fs.writeFileSync(cli, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("examplecli 1.4.2"); process.exit(0); }
if (process.argv[2] === "auth") process.exit(0);
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const out = [{ type: "session", id: "s-1", model: "m-actual" }, { type: "text", text: "args=" + process.argv.slice(2).join(" ") + " prompt=" + input.slice(0, 20) }, { type: "tool", cmd: "ls -la" }, { type: "weird" }, { type: "done", tokens: { in: 10, out: 2 } }];
  console.log(out.map((l) => JSON.stringify(l)).join("\\n") + "\\nnot json at all");
});
`);
  fs.chmodSync(cli, 0o755);
  fs.writeFileSync(path.join(root, ".hexagon/config.toml"), config.replaceAll("$CLI", cli));
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(root, k), v);
  return { root, cli };
}
const cfgFile = (root: string) => path.join(root, ".hexagon/config.toml");

describe("a manifest adapter loaded through [plugins] (no edit to registry.ts)", () => {
  it("registers the adapter, and an agent entry can use it", async () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/example.toml"]\n\n[agents.ex]\nadapter = "example"\ncommand = ["$CLI"]\nmodel = "my-model"\n`);
    const cfg = loadConfig(cfgFile(root));
    expect(cfg.agents.ex!.adapter).toBe("example");
    const a = createAdapter("ex", cfg.agents.ex!);
    expect(a.adapterId).toBe("example");
    expect(a.capabilities).toMatchObject({ supportsSessionResume: true, supportsUsageMetrics: true, supportsRuntimeModelReporting: true, supportsModelDiscovery: true });
    expect(a.security).toEqual({ readOnlyEnforced: false, commandAllowList: false }); // declared, so honest
    const events: AgentEvent[] = [];
    const out = await a.run(ctx({ readOnly: true, prompt: "do the thing" }, events));
    expect(out.kind).toBe("finished");
    const chat = events.find((e) => e.type === "chat");
    expect(chat && chat.type === "chat" && chat.text).toMatch(/args=run --json --model my-model --session [0-9a-f-]+ --sandbox read-only prompt=You are a test agent/); // prompt came on stdin, not argv
    expect(events).toContainEqual({ type: "session_handle", handle: "s-1" });
    expect(events).toContainEqual({ type: "model", model: "m-actual" });
    expect(events).toContainEqual({ type: "tool_call", name: "ls -la", summary: "ls -la" });
    expect(events.filter((e) => e.type === "usage")).toEqual([{ type: "usage", input: 10, output: 2, cache_read: 0, cache_write: 0, cost_usd: 0, step: true }]);
    const diag = await a.detect();
    expect(diag).toMatchObject({ installed: true, version: "1.4.2", auth: "ok" });
  });

  it("resumes with the id the CLI reported, and drops the model group when no model is set", async () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/example.toml"]\n\n[agents.ex]\nadapter = "example"\ncommand = ["$CLI"]\n`);
    const a = createAdapter("ex", loadConfig(cfgFile(root)).agents.ex!);
    const events: AgentEvent[] = [];
    await a.run(ctx({ resume: true, handle: "s-77", followUp: "go on", readOnly: false }, events));
    const chat = events.find((e) => e.type === "chat");
    expect(chat && chat.type === "chat" && chat.text).toMatch(/^args=run --json --resume s-77 --sandbox workspace prompt=go on/);
  });

  it("loading again (a config reload) does not fail or duplicate", () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/example.toml"]\n`);
    loadConfig(cfgFile(root));
    expect(() => loadConfig(cfgFile(root))).not.toThrow();
  });
});

describe("plugin problems are actionable", () => {
  it("a missing module is named in the error that stops the agent using it", () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/nope.mjs"]\n\n[agents.zz]\nadapter = "nope"\ncommand = ["x"]\n`);
    expect(() => loadConfig(cfgFile(root))).toThrow(/unknown adapter "nope".*Plugin problems: plugin \.\/adapters\/nope\.mjs: .*(cannot find|does not exist)/s);
    expect(pluginErrors().join("\n")).toMatch(/nope\.mjs/);
  });

  it("a plugin with no agents using it loads the rest and reports the failure (doctor shows it)", () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/missing.toml", "./adapters/example.toml"]\n`);
    expect(() => loadConfig(cfgFile(root))).not.toThrow();
    expect(pluginErrors().some((e) => /missing\.toml/.test(e))).toBe(true);
  });

  it("an adapter written for another API version is refused with the versions named", () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/future.mjs"]\n`, {
      "adapters/future.mjs": `export default { apiVersion: 99, id: "future", create() { throw new Error("no"); } };\n`,
    });
    loadConfig(cfgFile(root));
    expect(pluginErrors().join("\n")).toMatch(/future.*API version 99.*speaks version 1/);
  });

  it("a plugin cannot replace a built-in adapter", () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/evil.mjs"]\n`, {
      "adapters/evil.mjs": `export default { apiVersion: 1, id: "claude-code", create() { throw new Error("no"); } };\n`,
    });
    loadConfig(cfgFile(root));
    expect(pluginErrors().join("\n")).toMatch(/"claude-code" is built in/);
  });
});

describe("a module plugin", () => {
  it("receives the SDK (base classes) when it exports a function, and registers a TypeScript-style adapter", () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/mod.mjs"]\n\n[agents.mm]\nadapter = "modplug"\ncommand = ["x"]\n`, {
      "adapters/mod.mjs": `export default (sdk) => sdk.defineAdapter({
  apiVersion: sdk.apiVersion, id: "modplug",
  create: (id, conf) => new (class extends sdk.OneShotAdapter {
    adapterId = "modplug"; provider = "mod"; displayName = "Mod"; capabilities = sdk.capabilities({});
    build() { return { argv: [...this.command, "x"], stdin: "" }; }
    onLine() {}
  })(id, conf.command),
});\n`,
    });
    const cfg = loadConfig(cfgFile(root));
    expect(createAdapter("mm", cfg.agents.mm!).adapterId).toBe("modplug");
  });
});

describe("the manifest format", () => {
  it("the shipped example validates", () => {
    expect(loadManifestFile(EXAMPLE).id).toBe("example");
  });
  it("puts the prompt in argv only when the manifest says so", () => {
    const base = { apiVersion: ADAPTER_API_VERSION, id: "x", run: { new: ["go", "{prompt}"] } };
    expect(() => checkManifest(base)).toThrow(/prompt = "argv"/);
    expect(() => checkManifest({ ...base, run: { ...base.run, prompt: "argv" } })).not.toThrow();
    expect(() => checkManifest({ ...base, run: { new: ["go", "{prompt_file}"], prompt: "file" } })).not.toThrow();
    expect(() => checkManifest({ ...base, run: { new: ["go"], prompt: "file" } })).toThrow(/\{prompt_file\}/);
  });
  it("rejects a wrong apiVersion and a missing [run].new", () => {
    expect(() => checkManifest({ apiVersion: 2, id: "x", run: { new: ["a"] } })).toThrow(/apiVersion must be 1/);
    expect(() => checkManifest({ apiVersion: 1, id: "x", run: {} })).toThrow(/\[run\]\.new/);
  });
  it("expand drops a group or an argument whose slot is empty", () => {
    expect(expand(["a", ["--m", "{model}"], "{cwd}"], { model: null, cwd: "/w" })).toEqual(["a", "/w"]);
    expect(expand([["--m", "{model}"]], { model: "q" })).toEqual(["--m", "q"]);
  });
  it("event rules produce nothing without the field (no invented zeros), and junk lines are ignored", () => {
    const rules = checkManifest(loadManifestFile(EXAMPLE)).events!;
    expect(applyRules(rules, { type: "done" })).toEqual([]);
    expect(applyRules(rules, { type: "done", tokens: { in: 1 } })).toEqual([]);
    expect(applyRules(rules, { type: "text", text: "hi" })).toEqual([{ type: "chat", from: "agent", text: "hi" }]);
    expect(applyRules(rules, { nothing: true })).toEqual([]);
  });
  it("defineAdapter validates", () => {
    expect(() => defineAdapter({ apiVersion: 1, id: "Bad Id", create: () => null as never })).toThrow(/adapter id/);
  });
});

describe("a plugin entry can be loaded directly", () => {
  it("loadPlugins reports what each entry registered", () => {
    const { root } = project(`[plugins]\nadapters = []\n`);
    const [r] = loadPlugins(["./adapters/example.toml"], root);
    expect(r).toMatchObject({ ok: true, adapters: ["example"] });
  });
});

describe("exec is a manifest: the prompt goes to stdin unless the command opts into argv or a file", () => {
  const events = async (command: string[]) => {
    const { ExecAdapter } = await import("../src/agents/exec.js");
    const ev: AgentEvent[] = [];
    await new ExecAdapter("e", command, null).run(ctx({ prompt: "TASK" }, ev));
    return ev.filter((e) => e.type === "progress").map((e) => (e.type === "progress" ? e.text : "")).join("\n");
  };
  const script = (body: string) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hex-exec-")), "cli.sh"); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`); fs.chmodSync(f, 0o755); return f; };
  it("stdin by default (nothing in argv)", async () => {
    const out = await events([script('echo "argc=$# stdin=$(head -c 40 | tr "\\n" " ")"')]);
    expect(out).toMatch(/argc=0 stdin=You are a test agent/);
  });
  it("{prompt} puts it in argv (explicit opt-in)", async () => {
    const out = await events([script('echo "argc=$# first=$(echo "$1" | head -c 14)"'), "{prompt}"]);
    expect(out).toMatch(/argc=1 first=You are a tes/);
  });
  it("{prompt_file} passes a private file that is removed afterwards", async () => {
    const out = await events([script('echo "file=$1 body=$(head -c 14 "$1")"'), "{prompt_file}"]);
    const m = /file=(\S+) body=You are a tes/.exec(out);
    expect(m).toBeTruthy();
    expect(fs.existsSync(m![1]!)).toBe(false);
  });
});

describe("HEXAGON_NO_REAL_CLI is enforced for every integration that declares a CLI", () => {
  it("a manifest adapter refuses to start its declared executable under the test guard", async () => {
    const { root } = project(`[plugins]\nadapters = ["./adapters/example.toml"]\n\n[agents.ex]\nadapter = "example"\n`);
    const a = createAdapter("ex", loadConfig(cfgFile(root)).agents.ex!);
    const out = await a.run(ctx());
    expect(out).toMatchObject({ kind: "error", error: { retryable: false, message: expect.stringMatching(/HEXAGON_NO_REAL_CLI/) } });
  });
});
