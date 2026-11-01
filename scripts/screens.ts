/**
 * Renders the real dashboard (real App, fake daemon, deterministic data) into docs/img/*.svg for the README.
 * Run: npx tsx scripts/screens.ts
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

Object.assign(process.env, { TERM: "xterm-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8", HEXAGON_STARTUP: "off", HEXAGON_ANIMATION: "off", HEXAGON_AMBIENT: "off" });
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
const { App } = await import("../src/tui/app.js");

const task = (id: string, title: string, role: string, deps: string[] = []) => ({ id, title, role, requirements: [], acceptance: [], depends_on: deps, files: { write: [], read: [] }, skills: [], definition_of_done: [], verify: [] });
const tasks = [task("T-1", "Parse the spec", "qa"), task("T-2", "Build the API", "developer", ["T-1"]), task("T-3", "Build the UI", "developer", ["T-1"])];
const agent = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  schema: "hexagon.agent-status/v1", seq: 1, updated_at: "", heartbeat_at: "", run_id: "R1", agent_run_id: `${id}-1`, task_id: id, attempt: 1, role: tasks.find((t) => t.id === id)!.role,
  agent: { id: id === "T-3" ? "codex" : "claude", provider: id === "T-3" ? "openai" : "anthropic", adapter: id === "T-3" ? "codex" : "claude-code", cli_version: "2.1.0", model: null, model_mode: "cli-default", runtime_model: null },
  state, state_since: new Date().toISOString(), controller: "agent", needs_input: null, inbox: { pending: 0 }, usage: { input_tokens: 41000, output_tokens: 6200, cache_read_tokens: 30000, cache_write_tokens: 0, cost_usd: 0, turns: 9, wall_ms: 61000 }, last_error: null, result_path: null, ...extra,
});
function snapshot(states: Record<string, string>, empty = false) {
  const agents = tasks.map((t) => agent(t.id, states[t.id] ?? "queued", t.id === "T-2" ? { workspace: { worktree: ".hexagon/worktrees/R1/T-2-a1", branch: "hexagon/R1/T-2-a1" }, files_touched: ["internal/server/server.go", "go.mod"] } : {}));
  if (empty) return { root: "", has_context: true, draft: null, permissions: [], sessions: [], agents: [], plan: null, run: null };
  return {
    root: "", has_context: true, draft: null, permissions: [], sessions: [], agents,
    plan: { schema: "hexagon.plan/v1", id: "p", created_at: "", specs: [], tasks, spec_issues: [] },
    run: {
      schema: "hexagon.run-status/v1", run_id: "R1", updated_at: new Date().toISOString(), state: "running", plan_path: "", integration_branch: "hexagon/R1/integration", base_branch: "main", started_at: new Date(Date.now() - 130_000).toISOString(), budget_tokens: null,
      totals: { input_tokens: 164000, output_tokens: 24800, cache_read_tokens: 120000, cache_write_tokens: 0, cost_usd: 0, turns: 36, wall_ms: 130000 },
      counts: {}, agents: agents.map((a) => ({ task_id: a.task_id, agent_run_id: a.agent_run_id, role: a.role, agent: a.agent.id, state: a.state, activity: a.state === "running" ? "go test ./..." : null, needs_input: false, progress: a.state === "done" ? 1 : a.state === "running" ? 0.55 : 0, cost_usd: 0, tokens: 47000 })), attention: [],
    },
  };
}
const CHANGES = {
  run_id: "R1", base_branch: "main", integration_branch: "hexagon/R1/integration", integration_worktree: ".hexagon/worktrees/R1/integration", merged: false, commits: 3, files: 2, insertions: 138, deletions: 4,
  file_list: [{ path: "go.mod", added: 3, deleted: 0 }, { path: "internal/server/server.go", added: 135, deleted: 4 }], agents: [],
};
class Fake extends EventEmitter {
  constructor(public snap: unknown) { super(); }
  async call(m: string) { if (m === "ui.snapshot") return this.snap; if (m === "run.changes") return (this.snap as { run: unknown }).run ? CHANGES : null; return []; }
  async subscribe() {}
  close() {}
}

// ── ANSI → SVG ──
const CW = 9, CH = 19;
type Rgb = [number, number, number];
const BG: Rgb = [17, 22, 31], FG: Rgb = [215, 222, 233];
const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function cells(line: string, W: number) {
  const out: { ch: string; fg: Rgb; bg: Rgb | null; bold: boolean; dim: boolean }[] = [];
  let fg = FG, bg: Rgb | null = null, bold = false, dim = false, inv = false;
  const re = /\x1b\[([0-9;]*)m|([^\x1b])/gu;
  for (const m of line.matchAll(re)) {
    if (m[2] !== undefined) { out.push({ ch: m[2], fg: inv ? bg ?? BG : fg, bg: inv ? fg : bg, bold, dim }); continue; }
    const p = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < p.length; i++) {
      const v = p[i]!;
      if (v === 0) { fg = FG; bg = null; bold = dim = inv = false; }
      else if (v === 1) bold = true; else if (v === 2) dim = true; else if (v === 7) inv = true; else if (v === 22) bold = dim = false;
      else if ((v === 38 || v === 48) && p[i + 1] === 2) { const c: Rgb = [p[i + 2]!, p[i + 3]!, p[i + 4]!]; if (v === 38) fg = c; else bg = c; i += 4; }
    }
  }
  while (out.length < W) out.push({ ch: " ", fg: FG, bg: null, bold: false, dim: false });
  return out.slice(0, W);
}
function toSvg(lines: string[], W: number, H: number, title: string): string {
  const parts: string[] = [];
  for (let y = 0; y < H; y++) {
    const row = cells(lines[y] ?? "", W);
    for (let x = 0; x < W;) { // background runs
      const b = row[x]!.bg; let e = x; while (e < W && JSON.stringify(row[e]!.bg) === JSON.stringify(b)) e++;
      if (b) parts.push(`<rect x="${x * CW}" y="${y * CH}" width="${(e - x) * CW}" height="${CH}" fill="${hex(b)}"/>`);
      x = e;
    }
    for (let x = 0; x < W;) { // text runs
      const c = row[x]!;
      if (c.ch === " ") { x++; continue; }
      let e = x; const key = (q: typeof c) => `${q.fg}|${q.bold}|${q.dim}`;
      while (e < W && row[e]!.ch !== " " && key(row[e]!) === key(c)) e++;
      const xs = Array.from({ length: e - x }, (_, i) => (x + i) * CW).join(" ");
      parts.push(`<text x="${xs}" y="${y * CH + 14}" fill="${hex(c.fg)}"${c.bold ? ' font-weight="700"' : ""}${c.dim ? ' opacity=".8"' : ""}>${esc(row.slice(x, e).map((q) => q.ch).join(""))}</text>`);
      x = e;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * CW + 24} ${H * CH + 24}" width="${W * CW + 24}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><rect width="100%" height="100%" rx="10" fill="${hex(BG)}"/><g transform="translate(12 12)" font-family="Menlo, 'DejaVu Sans Mono', Consolas, monospace" font-size="15" xml:space="preserve">${parts.join("")}</g></svg>\n`;
}

async function shot(name: string, title: string, cols: number, rows: number, snap: unknown, then: (app: InstanceType<typeof App>, c: Fake) => Promise<void> = async () => {}) {
  const screen: string[] = [];
  Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true });
  Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
  const real = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string) => { for (const m of String(chunk).matchAll(/\x1b\[(\d+);1H([^\x1b]*(?:\x1b\[[0-9;]*m[^\x1b]*)*)/g)) screen[Number(m[1]) - 1] = m[2]!; return true; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hex-shot-"));
  fs.mkdirSync(path.join(tmp, ".hexagon"));
  const client = new Fake(snap);
  const app = new App(client as never, tmp);
  void app.start();
  await new Promise((r) => setTimeout(r, 400));
  await then(app, client);
  await new Promise((r) => setTimeout(r, 400));
  client.emit("close");
  (process.stdout as { write: unknown }).write = real;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (process.env.DUMP === name) console.log(screen.map((l) => (l ?? "").replace(/\x1b\[[0-9;]*m/g, "")).join("\n"));
  fs.writeFileSync(`docs/img/${name}.svg`, toSvg(screen, cols, rows, title));
  console.log(`docs/img/${name}.svg`);
}
const push = (c: Fake, event: string, data: unknown) => c.emit("push", { event, data });
const live = { "T-1": "done", "T-2": "running", "T-3": "reviewing" };

await shot("dashboard", "Hexagon dashboard: navigator, agent network, inspector, activity", 170, 42, snapshot(live));
await shot("dashboard-compact", "Hexagon on a small terminal", 90, 26, snapshot(live));
await shot("empty", "Empty state: chat with the assistant, or /sdd for parallel agents", 130, 34, snapshot({}, true));
const req = (over: Record<string, unknown> = {}) => ({
  id: "P-1", agent: "T-2", kind: "task", command: "go vet ./...", prefix: "go vet", asked_at: new Date().toISOString(), action: "exec", reason: "verify the server compiles cleanly",
  choices: [{ id: "once", label: "run it this once", key: "y" }, { id: "always", label: "always allow `go vet`", key: "a" }, { id: "all", label: "allow every command", key: "*" }, { id: "deny", label: "deny", key: "n" }], ...over,
});
await shot("approval", "Approval dialog for a command an agent wants to run", 170, 42, snapshot(live), async (_a, c) => { push(c, "permissions", [req()]); await new Promise((r) => setTimeout(r, 200)); });
await shot("sudo", "Sudo request: you run it in your own terminal", 170, 42, snapshot(live), async (_a, c) => {
  push(c, "permissions", [req({ action: "sudo", command: "sudo brew install go", prefix: "sudo", reason: "the Go toolchain is needed to build T-2", choices: [{ id: "terminal", label: "run it in a terminal (you type the password)", key: "t" }, { id: "deny", label: "deny", key: "n" }] })]);
  await new Promise((r) => setTimeout(r, 200));
});
