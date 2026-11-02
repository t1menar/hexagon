import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter, recordVerified } from "../agents/registry.js";
import { formatResults, runConformance } from "../agents/conformance.js";
import { pluginReports } from "../agents/plugins.js";
import type { AgentEvent } from "../contracts/types.js";
import { loadConfig } from "../core/config.js";
import { ProjectPaths } from "../core/project.js";

const fixturesOf = (root: string, adapter: string) => path.join(root, "test", "fixtures", "agents", adapter);

const MANIFEST = (id: string) => `# Declarative adapter for the "${id}" CLI. Field reference and walkthrough: docs/ADAPTERS.md
apiVersion = 1
id = "${id}"
provider = "${id}"
display_name = "${id}"
cli = "${id}"                 # the executable; [agents.x] command = [...] overrides it

[run]
prompt = "stdin"              # stdin | file ({prompt_file}) | argv ({prompt}: ARG_MAX and \`ps\` risk)
# Replace these with your CLI's non-interactive flags. [a, b] groups vanish together when a slot is empty.
# Slots: {prompt_file} {prompt} {session} {model} {cwd} {hexagon_bin} {effort}
new = ["run", "--json", ["--model", "{model}"]]
# resume = ["run", "--json", ["--resume", "{session}"]]
readonly_args = []
write_args = []

[detect]
version = ["--version"]
# auth = ["auth", "status"]   # exit 0 = logged in

[security]                    # declare only what you verified with --real
read_only_enforced = false
command_allow_list = false

# One rule per event. Paths are dotted ("a.b.c"). A rule whose field is missing emits nothing.
[[events]]
emit = "chat"
when = { type = "text" }
text = "text"

[[events]]
emit = "tool_call"
when = { type = "tool" }
name = "cmd"
summary = "cmd"
`;

const MODULE = (id: string) => `// Module adapter for "${id}". Export a function: it receives the SDK (base classes, helpers).
export default (sdk) => sdk.defineAdapter({
  apiVersion: sdk.apiVersion,
  id: "${id}",
  create: (agentId, conf, model) => new (class extends sdk.OneShotAdapter {
    adapterId = "${id}"; provider = "${id}"; displayName = "${id}";
    capabilities = sdk.capabilities({ supportsStreaming: true });
    build(ctx, prompt) { return { argv: [...this.command, "run", "--json", ...this.modelArgs()], stdin: prompt }; }
    onLine(line, ctx) {
      const e = sdk.safeJson(line);
      if (e?.type === "text" && typeof e.text === "string") ctx.host.emit({ type: "chat", from: "agent", text: e.text });
    }
  })(agentId, conf.command?.length ? conf.command : ["${id}"], sdk.selectionFrom(model || conf.model)),
  meta: { cli: "${id}" },
});
`;

export async function adapterTool(sub: string, rest: string[], root: string): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error(`usage: hexagon agents ${sub} <id>${sub === "scaffold" ? " [--module]" : sub === "record" ? " --yes [--prompt \"…\"]" : " [--real]"}`);
  const paths = new ProjectPaths(root);
  if (sub === "scaffold") return scaffold(id, rest.includes("--module"), root, paths.config);
  const cfg = loadConfig(paths.config);
  const conf = cfg.agents[id] ?? Object.values(cfg.agents).find((a) => a.adapter === id);
  if (!conf) throw new Error(`no agent "${id}" in ${paths.config} (agents: ${Object.keys(cfg.agents).join(", ")}). Scaffold one: hexagon agents scaffold ${id}`);
  const make = (command?: string[]) => createAdapter(conf.id, command ? { ...conf, command } : conf);
  const adapterId = make().adapterId;
  const fixtures = fixturesOf(root, adapterId);
  if (sub === "conformance") {
    const real = rest.includes("--real");
    const resolved = pluginReports().find((r) => r.adapters.includes(adapterId))?.resolved;
    const results = await runConformance({
      id, make, fixtures, sources: resolved ? [resolved] : [], real,
      semantic: { first: "Remember the code word PINEAPPLE. Reply with just: noted.", second: "What was the code word? Reply with just the word.", expect: /PINEAPPLE/i },
    });
    console.log(formatResults(id, results));
    const failed = results.some((r) => r.status === "fail");
    if (real && !failed) {
      const d = await make().detect();
      recordVerified(adapterId, { version: d.version ?? "unknown", date: new Date().toISOString().slice(0, 10), covered: "conformance v2 --real" });
      console.log(`\nRecorded as verified for ${adapterId} ${d.version ?? ""} in the user-level store (hexagon agents doctor shows it).`);
    } else if (!real) console.log("\nFake-CLI checks only: not recorded as verified. Add --real to run the real CLI (spends tokens).");
    process.exitCode = failed ? 1 : 0;
    return;
  }
  if (sub === "record") {
    if (!rest.includes("--yes")) throw new Error(`record runs the REAL CLI once and spends tokens. Add --yes to go ahead.`);
    const prompt = (rest.includes("--prompt") ? rest[rest.indexOf("--prompt") + 1] : null) ?? "Reply with the single word hello, then run `ls` in the current directory, then reply done.";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hex-record-"));
    const tee = path.join(dir, "tee-cli");
    fs.writeFileSync(tee, `#!/usr/bin/env node
const { spawn } = require("child_process"), fs = require("fs");
const real = JSON.parse(process.env.REC_REAL);
const out = fs.createWriteStream(process.env.REC_FILE);
const c = spawn(real[0], [...real.slice(1), ...process.argv.slice(2)], { stdio: ["pipe", "pipe", "inherit"] });
process.stdin.pipe(c.stdin);
c.stdout.on("data", (d) => { out.write(d); process.stdout.write(d); });
c.on("close", (code) => out.end(() => process.exit(code ?? 0)));
`, { mode: 0o755 });
    fs.mkdirSync(fixtures, { recursive: true });
    const file = path.join(fixtures, "recorded.jsonl");
    const events: AgentEvent[] = [];
    const a = make([tee]);
    const real = (make() as unknown as { command: string[] }).command;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 180_000);
    const out = await a.run({
      agentRunId: "T-1-a1", role: "developer", effort: "low", cwd: dir, system: "You are a test agent.", prompt, sessionId: crypto.randomUUID(), resume: false,
      env: { REC_REAL: JSON.stringify(real), REC_FILE: file }, allowCommands: ["ls"], readOnly: true, conversational: false,
      host: { emit: (e) => events.push(e), drainInbox: () => [], onInbox: () => () => {}, received: () => {}, isFinished: () => false, hasBlockingQuestion: () => false },
      api: {} as never, signal: ac.signal,
    }).finally(() => clearTimeout(t));
    const types = new Set(events.map((e) => e.type));
    const expect = {
      emits: ["chat", "tool_call", "session_handle", "model", "usage"].filter((x) => types.has(x as never)),
      ...(events.find((e) => e.type === "model") ? { model: (events.find((e) => e.type === "model") as { model: string }).model } : {}),
      ...(events.find((e) => e.type === "session_handle") ? { handle: (events.find((e) => e.type === "session_handle") as { handle: string }).handle } : {}),
      usage: types.has("usage") ? "some" : "none",
    };
    fs.writeFileSync(path.join(fixtures, "recorded.expect.json"), JSON.stringify(expect, null, 2) + "\n");
    console.log(`Recorded ${fs.statSync(file).size} bytes to ${file} (outcome: ${out.kind}).\nWhat the adapter made of it: ${[...types].join(", ") || "nothing"} → ${path.join(fixtures, "recorded.expect.json")}\nReview both before committing: the recording may contain paths, prompts or secrets. If the adapter understood nothing, your event rules do not match this output.\nAlso add an error fixture ("rate-limit.jsonl" + expect {exit, stderr, cls}) from a real failure.`);
    process.exitCode = out.kind === "error" ? 1 : 0;
  }
}

function scaffold(id: string, asModule: boolean, root: string, configFile: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(id)) throw new Error("adapter id must be lower-case letters, digits, - or _");
  const dir = path.join(root, "adapters");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}${asModule ? ".mjs" : ".toml"}`);
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  fs.writeFileSync(file, asModule ? MODULE(id) : MANIFEST(id));
  const fx = fixturesOf(root, id);
  fs.mkdirSync(fx, { recursive: true });
  fs.writeFileSync(path.join(fx, "basic.jsonl"), '{"type":"text","text":"hello"}\n{"type":"tool","cmd":"ls"}\n');
  fs.writeFileSync(path.join(fx, "basic.expect.json"), JSON.stringify({ emits: ["chat", "tool_call"], usage: "none" }, null, 2) + "\n");
  fs.writeFileSync(path.join(fx, "rate-limit.jsonl"), "");
  fs.writeFileSync(path.join(fx, "rate-limit.expect.json"), JSON.stringify({ exit: 1, stderr: "Error: 429 Too Many Requests (rate_limit_exceeded). Please retry after 20 seconds", cls: "rate_limit" }, null, 2) + "\n");
  if (fs.existsSync(configFile)) {
    let text = fs.readFileSync(configFile, "utf8");
    const entry = `./adapters/${id}${asModule ? ".mjs" : ".toml"}`;
    if (/^\[plugins\]/m.test(text)) text = text.replace(/^(adapters\s*=\s*\[)/m, `$1"${entry}", `);
    else text += `\n[plugins]\nadapters = ["${entry}"]\n`;
    if (!new RegExp(`^\\[agents\\.${id}\\]`, "m").test(text)) text += `\n[agents.${id}]\nadapter = "${id}"\n`;
    fs.writeFileSync(configFile, text);
  }
  console.log(`Wrote ${path.relative(root, file)} and fixtures in ${path.relative(root, fx)}; registered it under [plugins] and [agents.${id}] in .hexagon/config.toml.\nNext: edit the argv and event rules, then  hexagon agents conformance ${id}  →  hexagon agents record ${id} --yes  →  hexagon agents conformance ${id} --real  →  hexagon agents doctor`);
}
