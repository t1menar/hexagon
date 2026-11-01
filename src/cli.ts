#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { HexClient, daemonRunning } from "./client/client.js";
import type { Reply } from "./agents/types.js";
import type { AgentStatus, Phase, RunStatus } from "./contracts/types.js";
import { ensureRepo, isRepo } from "./core/git.js";
import { argsFromFlags, commandDef, commandDocs, parseArgs } from "./core/commands.js";
import { planTree } from "./core/plan.js";
import { findProjectRoot, ProjectPaths, scaffold } from "./core/project.js";
import type { SessionStatus } from "./core/solo.js";
import { findSpecs, lintSpec, listProjectFiles, parseSpec } from "./core/spec.js";
import type { ModelDiscoveryResult } from "./agents/contracts/model-selection.js";
import type { AgentInfo, Draft, Push } from "./daemon/orchestrator.js";
import { configureInteractive, formatAgent, formatModels } from "./shell/agents.js";
import { agentDetail, formatEvent, formatMessage, runTable } from "./shell/render.js";
import { readJson } from "./util/fsx.js";
import { readResource } from "./util/resources.js";
import { c } from "./util/term.js";

const VERSION = (JSON.parse(readResource("package.json")) as { version: string }).version;

const USAGE = `${c.bold("hexagon")} ${VERSION} — run several coding agents (Claude Code, …) on one goal, in parallel

${c.bold("Start")}
  hexagon init ["what you're building"]   set up .hexagon/ and let an agent write HEXAGON.md
  hexagon                                 open the dashboard: chat with Claude; /sdd for parallel agents
  hexagon sdd "<goal>"                    spec-driven: the analyst writes spec + task graph (alias: new)
  hexagon chat "<message>"                talk to Claude (works directly in the repo)
  hexagon run [plan.json] [-j N] [--agent X] [--follow]   run the approved draft (or a plan file)

${c.bold("Watch & steer")}
  hexagon status [T-n] [--json]    ·  hexagon attach <T-n>  ·  hexagon open <T-n>
  hexagon tell <T-n|@role|@all> <text>  ·  hexagon answer <Q-n> <text>
  hexagon pause|resume|cancel <T-n>  ·  hexagon retry <T-n> [--agent X] [--effort E]
  hexagon takeover <T-n>           continue the agent's own session yourself (claude --resume)
  hexagon diff <T-n> · logs <T-n> · merge · close · abort · clean · up · down
  hexagon compact [agent|T-n]      compact an agent's session at its next safe point  ·  hexagon stats [--json]  tokens by cause
  hexagon bus send|read|subscribe  agents: structured messages between agents (handoff, decision, finding, question …)
  hexagon commands                 the typed command API (graph, agents, runs) the assistant uses  ·  hexagon do <command> [--param v]
  hexagon proposals | apply [P-n] | reject [P-n]   changes the assistant proposed, waiting for you
  hexagon approve-spec [file]      approve the spec under review (or a spec file): nothing is planned or built before that
  hexagon trace                    requirement → task → agent → verification → review → completion
  hexagon allow <cmd…> | all       let agents run these commands (e.g. allow brew curl) or everything
  hexagon model [role model|default]  show/set a model override per role (default = the CLI's own)
  hexagon agents [list|doctor|models <agent>|configure|add]   providers, CLI versions, auth, capabilities, discovered models
  hexagon install [go|node|java|maven]   install a toolchain for agents (official release, no Homebrew)

${c.bold("Agent protocol")} (run by agents inside their sessions)
  hexagon report "<activity>" [--phase P] [--done AC-1 …]
  hexagon ask "<question>" [--option "…" …] [--default "…"]
  hexagon note "<fact for other agents>"
  hexagon return <T-n> "<defect in that task's code, with evidence>"
  hexagon done --summary "…" [--evidence "AC-1: …" …] [--status completed|blocked|failed|needs_spec_change]
               [--issue "…" …] [--assume "…" …] [--allow <cmd> …]
  hexagon review approve|changes --summary "…" [--finding "high: file:line issue -> fix" …]
  hexagon plan-check`;

const AGENT_OPS = new Set(["report", "ask", "note", "done", "review", "plan-check", "stage-check", "return", "bus", "exec", "install", "sudo"]);
const TASK_RE = /^t-?\d+$/i;
const normTask = (s: string) => s.toUpperCase().replace(/^T(\d)/, "T-$1");

function root(): string {
  const r = findProjectRoot();
  if (!r) {
    console.error(c.orange("✖ not inside a Hexagon project — run `hexagon init` in your repository first"));
    process.exit(2);
  }
  return r;
}

/** Remove `--name value` pairs (repeatable) and return the values. */
function multi(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length;) {
    if (args[i] === name && i + 1 < args.length) { out.push(args[i + 1]!); args.splice(i, 2); } else i++;
  }
  return out;
}
const one = (args: string[], name: string) => multi(args, name).at(-1);
function bool(args: string[], ...names: string[]): boolean {
  let hit = false;
  for (const n of names) { const i = args.indexOf(n); if (i >= 0) { args.splice(i, 1); hit = true; } }
  return hit;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (cmd === "__daemon") {
    const { runDaemon } = await import("./daemon/run.js");
    return runDaemon(rest[0] ?? process.cwd());
  }
  if (cmd === "--version" || cmd === "-v") return void console.log(VERSION);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return void console.log(USAGE);
  if (cmd && AGENT_OPS.has(cmd)) return agentOp(cmd, rest);
  if (cmd === "commands") return void console.log(commandDocs());
  if (cmd === "do") {
    const name = rest[0];
    const def = name ? commandDef(name) : undefined;
    if (!def) { console.error(`usage: hexagon do <command> [--param value …]   (hexagon commands lists them)`); process.exit(2); }
    let args: Record<string, unknown>;
    try { args = parseArgs(def, argsFromFlags(def, rest.slice(1))); } catch (e) { console.error((e as Error).message); process.exit(2); }
    // From the control agent: a proposal. From you: executed at once.
    if (process.env.HEXAGON_AGENT) return agentOp("command", [JSON.stringify({ name: def.name, args })]);
    const client = await HexClient.connect(root());
    try {
      const res = await client.call<{ status: string; result?: unknown }>("command.exec", { name: def.name, args });
      console.log(JSON.stringify(res.result ?? null, null, 2));
    } finally { client.close(); }
    return;
  }
  if (cmd === "init") return init(rest);

  if (cmd === "spec") {
    const r = root();
    const files = findSpecs(r, rest.slice(1));
    const projectFiles = listProjectFiles(r);
    let errors = 0;
    for (const f of files) {
      const issues = lintSpec(parseSpec(f), projectFiles);
      errors += issues.filter((i) => i.level === "error").length;
      console.log(`${path.relative(r, f)}: ${issues.length ? "" : c.blue("✔ ok")}`);
      for (const i of issues) console.log(`  ${i.level === "error" ? c.orange("✖") : "!"} :${i.line} ${i.message}`);
    }
    process.exitCode = errors ? 1 : 0;
    return;
  }

  if (cmd === "status") {
    const r = root();
    const json = bool(rest, "--json");
    const task = rest.find((a) => TASK_RE.test(a));
    const paths = new ProjectPaths(r);
    const rs = latestRunStatus(paths);
    if (!rs) return void console.log(json ? "null" : "no runs yet");
    if (task) {
      const st = rs.agents.find((a) => a.task_id === normTask(task));
      if (!st) return void console.error(`unknown task ${task}`);
      const full = readJson<AgentStatus>(paths.run(rs.run_id).agentStatus(st.agent_run_id));
      return void console.log(json ? JSON.stringify(full, null, 2) : agentDetail(full!));
    }
    console.log(json ? JSON.stringify(rs, null, 2) : runTable(rs));
    if (!json && !daemonRunning(paths)) console.log(c.dim("(daemon not running — snapshot from status files)"));
    return;
  }

  if (cmd === "up") {
    const client = await HexClient.connect(root());
    const info = await client.call<{ pid: number }>("ping");
    console.log(`daemon running (pid ${info.pid})`);
    return void client.close();
  }

  if (cmd === "down") {
    const paths = new ProjectPaths(root());
    if (!daemonRunning(paths)) return void console.log("daemon not running");
    const client = await HexClient.connect(paths.root, { autostart: false });
    const rs = await client.call<RunStatus | null>("run.status");
    const active = rs?.agents.filter((a) => !["done", "failed", "blocked", "cancelled", "queued"].includes(a.state)).length ?? 0;
    if (active && !rest.includes("--yes")) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ans = await rl.question(`${active} agent(s) are active and will be cancelled. Stop the daemon? [y/N] `);
      rl.close();
      if (!/^y/i.test(ans)) return void client.close();
    }
    await client.call("shutdown");
    client.close();
    return void console.log("daemon stopped");
  }

  if (cmd === "open") {
    const r = root();
    const t = rest[0];
    if (!t) return void console.error("usage: hexagon open <T-n>");
    const { openTerminal, hexagonCommand } = await import("./shell/open.js");
    return void console.log(await openTerminal(normTask(t), hexagonCommand(r, ["attach", normTask(t)])));
  }

  if (cmd === "takeover" || cmd === "takeover-shell") {
    if (!rest[0]) return void console.error("usage: hexagon takeover <T-n>");
    const client = await HexClient.connect(root());
    const { takeoverInTerminal } = await import("./tui/takeover.js");
    console.log(await takeoverInTerminal(client, normTask(rest[0])));
    return void client.close();
  }

  if (!cmd || cmd === "shell" || cmd === "attach" || cmd === "ui") {
    const r = root();
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      const rs = latestRunStatus(new ProjectPaths(r));
      return void console.log(rs ? runTable(rs) : "no runs yet — `hexagon sdd \"<goal>\"`");
    }
    const client = await HexClient.connect(r);
    const { App } = await import("./tui/app.js");
    await new App(client, r, cmd === "attach" ? rest[0] : undefined).start();
    return;
  }

  if (cmd === "new" || cmd === "sdd") return newGoal(rest);
  if (cmd === "plan") {
    // Used by the chat agent: start the planner and return at once.
    const goal = rest.join(" ").trim();
    if (!goal) throw new Error('usage: hexagon plan "<goal>"');
    const client = await HexClient.connect(process.env.HEXAGON_ROOT ?? root());
    try {
      await client.call("goal.new", { goal });
      console.log("Planning started. The draft spec and task graph will appear in the dashboard for the user to approve.");
    } finally {
      client.close();
    }
    return;
  }
  if (cmd === "chat") {
    const client = await HexClient.connect(root());
    await client.call("chat.send", { text: rest.join(" ") });
    client.close();
    return void console.log("sent — the reply appears in the dashboard chat (`hexagon`)");
  }

  const r = root();
  const client = await HexClient.connect(r);
  try {
    switch (cmd) {
      case "run": {
        const follow = bool(rest, "--follow", "-f");
        const j = one(rest, "-j");
        const agent = one(rest, "--agent") ?? null;
        const budget = one(rest, "--budget");
        const only = one(rest, "--only")?.split(",").map(normTask);
        const snap = await client.call<{ draft: Draft | null }>("ui.snapshot");
        if (follow) await followRun(client);
        if (rest[0] && !(fs.existsSync(rest[0]) && rest[0].endsWith(".json"))) {
          // `hexagon run "build a todo API"`: a goal, not a plan file.
          client.close();
          return await newGoal(rest);
        }
        const res = rest[0]
          ? await client.call<{ run_id: string }>("run.start", { plan_path: rest[0], agent, only, max_parallel: j ? Number(j) : undefined, budget_tokens: budget ? parseTokens(budget) : undefined })
          : snap.draft
            ? await client.call<{ run_id: string }>("draft.approve", { agent, max_parallel: j ? Number(j) : undefined })
            : (() => { throw new Error("no plan to run — `hexagon sdd \"<goal>\"` first, or pass a plan file"); })();
        console.log(`${c.blue("▶")} run ${res.run_id} started${follow ? "" : " — watch it with `hexagon`"}`);
        if (follow) return await new Promise<void>(() => undefined);
        break;
      }
      case "tell": {
        const [to, ...body] = rest;
        if (!to || !body.length) throw new Error("usage: hexagon tell <T-n|@role|@all|@lead> <text>");
        const target = TASK_RE.test(to) ? normTask(to) : to.startsWith("@") ? to : `@${to}`;
        const res = await client.call<{ answer?: string }>("message.send", { to: target, body: body.join(" ") });
        console.log(res.answer ?? "sent");
        break;
      }
      case "answer": {
        const [qid, ...ans] = rest;
        if (!qid || !ans.length) throw new Error("usage: hexagon answer <Q-n> <text>");
        const res = await client.call<{ task_id: string }>("question.answer", { question_id: qid, answer: ans.join(" ") });
        console.log(`answered ${qid} (${res.task_id})`);
        break;
      }
      case "pause": case "resume": case "cancel": {
        const t = rest[0];
        if (t) await client.call(`agent.${cmd}`, { task: normTask(t) });
        else if (cmd === "cancel") throw new Error("usage: hexagon cancel <T-n>");
        else await client.call(`run.${cmd}`);
        console.log(`${cmd}: ${t ? normTask(t) : "run"}`);
        break;
      }
      case "proposals": {
        const list = await client.call<{ id: string; command: string; destructive: boolean; diff: string[] }[]>("command.list");
        console.log(list.length ? list.map((p) => `${p.id}${p.destructive ? " (destructive)" : ""}  ${p.command}\n${p.diff.map((d) => `    ${d}`).join("\n")}`).join("\n") : "no proposals waiting");
        break;
      }
      case "apply": case "reject": {
        const id = (rest[0] ?? (await client.call<{ id: string }[]>("command.list"))[0]?.id)?.toUpperCase();
        if (!id) { console.error("no proposal is waiting"); process.exitCode = 1; break; }
        await client.call(cmd === "apply" ? "command.confirm" : "command.reject", { id });
        console.log(`${id} ${cmd === "apply" ? "applied" : "dropped"}`);
        break;
      }
      case "approve-spec": {
        const r = await client.call<{ approved: string; requirements: number; planning: boolean }>("spec.approve", { spec: rest[0] });
        console.log(`approved ${r.approved} (${r.requirements} requirement(s))${r.planning ? "; the analyst is writing the plan" : ""}`);
        break;
      }
      case "compact": {
        const r = await client.call<{ agents: string[] }>("session.compact", { agent: rest[0] ? (TASK_RE.test(rest[0]) ? normTask(rest[0]) : rest[0]) : undefined });
        console.log(`will compact at the next safe point: ${r.agents.join(", ")}`);
        break;
      }
      case "stats": {
        const st = await client.call<{ run: Record<string, { input: number; cache_read: number; output: number }> | null; agents: { agent: string; turns: number; ctx_tokens: number; ctx_pct: number; compactions: number; ledger: Record<string, { input: number; cache_read: number; output: number }> }[] }>("stats.get");
        if (bool(rest, "--json")) { console.log(JSON.stringify(st, null, 2)); break; }
        const line = (n: string, l: { input: number; cache_read: number; output: number }) => `  ${n.padEnd(12)} ${String(l.input).padStart(9)} in  ${String(l.cache_read).padStart(9)} cached  ${String(l.output).padStart(8)} out`;
        console.log(c.bold("This run, by cause"));
        for (const [k, v] of Object.entries(st.run ?? {})) console.log(line(k, v));
        console.log(c.bold("Agents (whole project)"));
        for (const a of st.agents) {
          console.log(`  ${a.agent}: ${a.turns} turns · ctx ${Math.round(a.ctx_pct * 100)}%${a.compactions ? ` ▸ compacted ×${a.compactions}` : ""}`);
          for (const [k, v] of Object.entries(a.ledger)) console.log(line(`  ${k}`, v));
        }
        break;
      }
      case "retry": {
        const agent = one(rest, "--agent");
        const effort = one(rest, "--effort");
        if (!rest[0]) throw new Error("usage: hexagon retry <T-n>");
        await client.call("agent.retry", { task: normTask(rest[0]), agent, effort });
        console.log(`${normTask(rest[0])}: new attempt queued`);
        break;
      }
      case "diff": {
        if (!rest[0]) throw new Error("usage: hexagon diff <T-n> [--stat]");
        const res = await client.call<{ diff: string }>("agent.diff", { task: normTask(rest[0]), stat: rest.includes("--stat") });
        console.log(res.diff);
        break;
      }
      case "logs": {
        if (!rest[0]) throw new Error("usage: hexagon logs <T-n> [N]");
        const evs = await client.call<Parameters<typeof formatEvent>[0][]>("agent.events", { task: normTask(rest[0]), limit: Number(rest[1] ?? 100) });
        for (const e of evs) { const l = formatEvent(e, true); if (l) console.log(l); }
        break;
      }
      case "inbox": console.log(JSON.stringify(await client.call("inbox.list"), null, 2)); break;
      case "merge": console.log((await client.call<{ text: string }>("merge.base")).text); break;
      case "close": await client.call("run.close"); console.log("run closed"); break;
      case "model": case "models": {
        type M = { role: string; agent: string; model: string; effort: string }[];
        const list = rest.length >= 2
          ? await client.call<M>("models.set", { role: rest[0]!.toLowerCase(), model: rest[1] === "default" ? null : rest[1] })
          : await client.call<M>("models.list");
        for (const m of list) console.log(`${m.role.padEnd(12)} ${m.model.padEnd(10)} effort ${m.effort}`);
        break;
      }
      case "trace": console.log((await client.call<{ text: string }>("trace")).text); break;
      case "agents": {
        const sub = rest[0] ?? "list";
        if (sub === "list" || sub === "doctor") {
          const list = await client.call<AgentInfo[]>("agents.list");
          console.log(list.map((a) => formatAgent(a, sub === "doctor")).join("\n\n"));
          const bad = list.filter((a) => a.error || a.diagnostics?.installed === false || a.diagnostics?.auth === "unauthenticated");
          if (sub === "doctor") {
            console.log(bad.length ? `\n${bad.length} agent(s) need attention.` : "\nAll configured agents look usable.");
            if (bad.length) process.exitCode = 1;
          }
        } else if (sub === "models") {
          if (!rest[1]) throw new Error("usage: hexagon agents models <agent>");
          console.log(formatModels(rest[1], await client.call<ModelDiscoveryResult>("agents.models", { agent: rest[1], fresh: true })));
        } else if (sub === "configure") {
          if (rest[1] && rest[2]) {
            await client.call("agents.role", { role: rest[1].toLowerCase(), agent: rest[2] });
            console.log(`${rest[1]} → ${rest[2]}`);
          } else await configureInteractive((m, p) => client.call(m, p));
        } else if (sub === "add") {
          const [, id, adapter] = rest;
          if (!id || !adapter) throw new Error("usage: hexagon agents add <id> <adapter> [--provider P] [--command bin]");
          const command = one(rest, "--command");
          await client.call("agents.add", { id, adapter, provider: one(rest, "--provider"), command: command ? command.split(/\s+/) : undefined });
          console.log(`added agent ${id} (${adapter})`);
        } else throw new Error("usage: hexagon agents [list|doctor|models <agent>|configure [role agent]|add <id> <adapter>]");
        break;
      }
      case "allow": console.log((await client.call<{ text: string }>("allow", { rules: rest })).text); break;
      case "install": {
        if (!rest[0]) {
          for (const t of await client.call<{ name: string; installed: string | null; on_path: boolean }[]>("toolchain.list")) {
            console.log(`${t.name.padEnd(8)} ${t.installed ? `installed by Hexagon (${t.installed})` : t.on_path ? "on your PATH" : "not installed"}`);
          }
          break;
        }
        console.log(`installing ${rest[0]}…`);
        console.log((await client.call<{ text: string }>("toolchain.install", { name: rest[0] })).text);
        break;
      }
      case "abort": await client.call("run.abort"); console.log("run aborted"); break;
      case "clean": console.log(`removed ${(await client.call<{ removed: string[] }>("worktrees.clean")).removed.length} worktree(s)`); break;
      default:
        console.error(`unknown command: ${cmd}\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } finally {
    client.close();
  }
}

// ───────────── init / new: run an agent session in this terminal ─────────────

async function init(args: string[]): Promise<void> {
  const bare = bool(args, "--bare", "--no-agent");
  const agent = one(args, "--agent");
  const dir = process.cwd();
  const here = bool(args, "--here", "--yes");
  // A folder that holds several repositories is almost never the project itself (e.g. `mkdir app` without `cd app`).
  if (!here && !fs.existsSync(path.join(dir, ".git")) && !fs.existsSync(path.join(dir, ".hexagon"))) {
    const repos = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, ".git"))).map((e) => e.name);
    if (repos.length) {
      console.log(c.orange(`! ${dir} is not a project: it contains ${repos.length} git repositor${repos.length === 1 ? "y" : "ies"} (${repos.slice(0, 4).join(", ")}${repos.length > 4 ? ", …" : ""}).`));
      let ok = false;
      if (process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        ok = /^y/i.test(await rl.question("Set up Hexagon (and git) in this folder anyway? [y/N] "));
        rl.close();
      }
      if (!ok) { console.log(`Did you forget ${c.cyan("cd <project>")}? Use ${c.cyan("hexagon init --here")} to set up this folder anyway.`); process.exitCode = 1; return; }
    }
  }
  const created = scaffold(dir);
  console.log(created.length ? `${c.blue("✔")} created ${created.join(", ")}` : "Hexagon is already set up here");
  const setup = await ensureRepo(dir);
  if (setup) console.log(`${c.blue("✔")} ${setup} (agents work in git worktrees)`);
  if (bare) return;
  if (agent) {
    const cfgFile = path.join(dir, ".hexagon", "config.toml");
    fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, "utf8").replace(/(\[roles\.bootstrap\]\nagent = )"[^"]*"/, `$1"${agent}"`));
  }
  const client = await HexClient.connect(dir);
  await client.subscribe();
  const started = await client.call<{ skipped?: boolean }>("init.start", { description: args.join(" ") || null });
  if (started.skipped) {
    client.close();
    console.log(`${c.blue("✔")} empty repository: wrote a stub HEXAGON.md (filled in as code lands)`);
    console.log(`Next: run ${c.cyan("hexagon")} and tell Claude what to build, or ${c.cyan('hexagon sdd "<goal>"')} for the spec-driven flow.`);
    return;
  }
  console.log(`${c.cyan("◆")} the init agent is studying the repository and writing HEXAGON.md ${c.dim("(Ctrl-C to stop)")}`);
  const st = await followSession(client, "init");
  client.close();
  if (st.state !== "done") { process.exitCode = 1; return; }
  console.log(`\n${c.blue("✔")} HEXAGON.md written${st.summary ? ` — ${st.summary}` : ""} · ${st.tokens.input + st.tokens.cache_read + st.tokens.output} tokens`);
  console.log(`Next: run ${c.cyan("hexagon")} and tell Claude what to build, or ${c.cyan('hexagon sdd "<goal>"')} for the spec-driven flow.`);
}

async function newGoal(args: string[]): Promise<void> {
  const goal = args.join(" ").trim();
  if (!goal) throw new Error('usage: hexagon sdd "<what you want built>"');
  const r = root();
  const client = await HexClient.connect(r);
  if (process.stdout.isTTY && process.stdin.isTTY) {
    await client.call("goal.new", { goal });
    const { App } = await import("./tui/app.js");
    await new App(client, r, "planner").start();
    return;
  }
  await client.subscribe();
  await client.call("goal.new", { goal });
  const draft = new Promise<Draft>((resolve) => client.on("push", (p: Push) => { if (p.event === "draft" && p.data) resolve(p.data); }));
  const st = await followSession(client, "planner");
  if (st.state !== "done") { client.close(); process.exitCode = 1; return; }
  const d = await draft;
  console.log(`\n${c.bold("Plan")} ${d.id} · spec ${path.relative(r, d.spec_path)}\n${planTree(d.plan)}`);
  for (const e of d.check.errors) console.log(c.orange(`✖ ${e}`));
  for (const w of d.check.warnings) console.log(`! ${w}`);
  console.log(`\nApprove with ${c.cyan("hexagon run")}, or open ${c.cyan("hexagon")} to revise it.`);
  client.close();
}

/** Stream a solo session (init/planner) to the terminal; answer its questions inline. */
async function followSession(client: HexClient, id: string): Promise<SessionStatus> {
  let printed = 0;
  let asked: string | null = null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on("SIGINT", () => { void client.call("session.cancel", { id }).finally(() => process.exit(130)); });
  process.on("SIGINT", () => { void client.call("session.cancel", { id }).finally(() => process.exit(130)); });
  return new Promise((resolve) => {
    client.on("push", (p: Push) => {
      if (p.event === "notice" && p.data.level === "error") console.log(c.orange(`✖ ${p.data.text}`));
      if (p.event !== "session" || p.data.id !== id) return;
      const s = p.data;
      for (const f of s.feed.slice(printed)) {
        const t = f.kind === "tool" ? c.blue(`  ▸ ${f.text}`) : f.kind === "status" ? c.cyan(`  · ${f.text}`) : f.kind === "error" ? c.orange(`  ✖ ${f.text}`) : f.kind === "user" ? c.bold(`  › ${f.text}`) : c.dim(`    ${f.text}`);
        console.log(t);
      }
      printed = s.feed.length;
      if (s.question && asked !== s.question.question_id) {
        asked = s.question.question_id;
        const opts = s.question.options?.length ? `\n${s.question.options.map((o) => `   ${o.id}) ${o.label}`).join("\n")}` : "";
        void rl.question(c.orange(`\n? ${s.question.prompt}${opts}\n› `)).then((a) => client.call("session.say", { id, text: a || s.question!.options?.[0]?.label || "decide yourself" }));
      }
      if (s.state === "done" || s.state === "failed" || s.state === "cancelled") {
        if (s.state === "failed") console.log(c.orange(`✖ ${s.error ?? "failed"}`));
        rl.close();
        resolve(s);
      }
    });
  });
}

async function followRun(client: HexClient): Promise<void> {
  await client.subscribe();
  client.on("push", (p: Push) => {
    if (p.event === "agent_event") { const l = formatEvent(p.data, false); if (l) console.log(l); }
    if (p.event === "message") { const l = formatMessage(p.data); if (l && p.data.delivery.state !== "acked") console.log(l); }
    if (p.event === "notice") console.log(`◆ ${p.data.text}`);
    if (p.event === "run" && p.data && (p.data.state === "done" || p.data.state === "aborted")) {
      console.log(runTable(p.data));
      client.close();
      process.exit(p.data.agents.every((a) => a.state === "done") ? 0 : 1);
    }
  });
}

// ───────────── agent protocol commands ─────────────

async function agentOp(cmd: string, args: string[]): Promise<void> {
  const r = process.env.HEXAGON_ROOT ?? findProjectRoot();
  if (!r) { console.error("hexagon: not inside a Hexagon project"); process.exit(2); }
  const a = [...args];
  let op = cmd === "plan-check" || cmd === "stage-check" ? "plan_check" : cmd;
  let params: Record<string, unknown> = {};
  switch (cmd) {
    case "report": {
      const phase = one(a, "--phase") as Phase | undefined;
      const done = multi(a, "--done").flatMap((x) => x.split(/[,\s]+/)).filter(Boolean);
      params = { activity: a.join(" ") || undefined, phase, done };
      break;
    }
    case "ask": {
      const options = multi(a, "--option");
      const def = one(a, "--default");
      params = { prompt: a.join(" "), options, default: def };
      break;
    }
    case "note": params = { body: a.join(" ") }; break;
    case "command": params = JSON.parse(a[0] ?? "{}") as Record<string, unknown>; break;
    case "bus": {
      const action = a.shift();
      if (action === "send") {
        const fields: Record<string, string> = {};
        for (const f of multi(a, "--field")) { const i = f.indexOf("="); if (i > 0) fields[f.slice(0, i)] = f.slice(i + 1); }
        const kind = one(a, "--kind") ?? "broadcast", to = one(a, "--to"), role = one(a, "--role"), topic = one(a, "--topic");
        const subject = one(a, "--subject"), artifact = one(a, "--artifact"), reply_to = one(a, "--reply-to"), timeout = one(a, "--timeout");
        params = { action, kind, to, role, topic, subject, artifact, reply_to, blocking: bool(a, "--blocking"), timeout_s: timeout ? Number(timeout) : undefined, fields, body: a.join(" ") };
      } else if (action === "read") {
        const kind = one(a, "--kind"), since = one(a, "--since"), limit = one(a, "--limit");
        params = { action, kind, since: since ? Number(since) : undefined, limit: limit ? Number(limit) : undefined };
      } else if (action === "subscribe") {
        params = { action, topic: a[0] };
      } else {
        console.error('usage: hexagon bus send --kind handoff|decision|question|answer|finding|request|broadcast (--to T-n | --role R | --topic X) [--subject S] [--field k=v] [--artifact path] [--reply-to B-n] [--blocking [--timeout s]] "<text>"\n       hexagon bus read [--kind K] [--since SEQ] [--limit N]\n       hexagon bus subscribe <topic>');
        process.exit(2);
      }
      break;
    }
    case "exec": case "sudo": {
      // Flags come before `--`; everything after it is the command, verbatim.
      const cut = a.indexOf("--");
      const flags = cut >= 0 ? a.slice(0, cut) : [...a];
      const rest = cut >= 0 ? a.slice(cut + 1) : [];
      const reason = one(flags, "--reason");
      const shell = one(flags, "--shell");
      const argv = cut >= 0 ? rest : flags.filter((x) => !x.startsWith("--"));
      if (!argv.length && shell === undefined) { console.error(`usage: hexagon ${cmd} [--reason "why"] -- <command> [args…]   (or --shell "a && b")`); process.exit(2); }
      params = { argv: shell === undefined ? argv : [], shell, reason };
      break;
    }
    case "install": {
      const reason = one(a, "--reason");
      const tool = a.find((x) => !x.startsWith("--"));
      if (!tool) { console.error('usage: hexagon install <go|node|java|maven> [--reason "why"]'); process.exit(2); }
      params = { tool, reason };
      break;
    }
    case "return": {
      const task = a.shift();
      if (!task || !a.length) { console.error('usage: hexagon return <T-n> "<what is wrong, with evidence>"'); process.exit(2); }
      params = { task, issue: a.join(" ") };
      break;
    }
    case "done": {
      const summary = one(a, "--summary") ?? a.join(" ");
      const status = one(a, "--status");
      params = {
        summary, status,
        acceptance_evidence: multi(a, "--evidence").map((e) => {
          const m = /^\s*(AC-\d+)\s*[:=-]\s*([\s\S]*)$/i.exec(e);
          return { ac: m ? m[1]!.toUpperCase() : "AC-?", evidence: m ? m[2]! : e, verified: true };
        }),
        spec_issues: multi(a, "--issue"),
        blockers: status === "blocked" ? multi(a, "--blocker").concat(multi(a, "--issue")) : multi(a, "--blocker"),
        assumptions: multi(a, "--assume").map((text) => ({ text })),
        follow_ups: multi(a, "--follow-up"),
        allow: multi(a, "--allow"),
      };
      break;
    }
    case "review": {
      const verdict = a.shift();
      if (verdict !== "approve" && verdict !== "changes") { console.error("usage: hexagon review approve|changes --summary \"…\" [--finding \"high: file:line issue -> fix\"]"); process.exit(2); }
      const summary = one(a, "--summary") ?? a.join(" ");
      const findings = multi(a, "--finding").map((f) => {
        const m = /^\s*(high|medium|low)\s*:\s*(?:([^\s:]+\.[\w]+)(?::(\d+))?\s+)?([\s\S]*?)(?:\s*->\s*([\s\S]*))?$/i.exec(f);
        return m
          ? { severity: m[1]!.toLowerCase(), ...(m[2] ? { file: m[2] } : {}), ...(m[3] ? { line: Number(m[3]) } : {}), issue: m[4]!.trim(), ...(m[5] ? { suggestion: m[5].trim() } : {}) }
          : { severity: "medium", issue: f };
      });
      params = { verdict, summary, findings };
      op = "review";
      break;
    }
  }
  let client: HexClient;
  try {
    client = await HexClient.connect(r, { autostart: false });
  } catch {
    console.error("hexagon: the Hexagon daemon is not running, so this report was not delivered. Continue your task.");
    process.exit(1);
  }
  try {
    const reply = await client.call<Reply>("agent.api", { agent: process.env.HEXAGON_AGENT ?? null, cwd: process.cwd(), op, args: params });
    (reply.ok ? console.log : console.error)(reply.message);
    process.exitCode = reply.ok ? 0 : 1;
  } finally {
    client.close();
  }
}

/** "2m", "500k", "1200000" → tokens. */
function parseTokens(s: string): number {
  const m = /^([\d.]+)\s*([km]?)$/i.exec(s.trim());
  if (!m) throw new Error(`invalid token budget: ${s}`);
  return Math.round(Number(m[1]) * (m[2]!.toLowerCase() === "m" ? 1e6 : m[2]!.toLowerCase() === "k" ? 1e3 : 1));
}

function latestRunStatus(paths: ProjectPaths): RunStatus | null {
  if (!fs.existsSync(paths.runs)) return null;
  const runs = fs.readdirSync(paths.runs).filter((d) => d.startsWith("r-")).sort();
  for (const run of runs.reverse()) {
    const s = readJson<RunStatus>(paths.run(run).status);
    if (s) return s;
  }
  return null;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(c.orange(`✖ ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
