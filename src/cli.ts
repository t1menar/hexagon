#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { HexClient, daemonRunning } from "./client/client.js";
import type { AgentStatus, RunStatus } from "./contracts/types.js";
import { findProjectRoot, ProjectPaths, scaffold } from "./core/project.js";
import { readResource } from "./util/resources.js";
import { isRepo } from "./core/git.js";
import type { Push } from "./daemon/orchestrator.js";
import { formatEvent, formatMessage, runTable } from "./shell/render.js";
import { lintReport, Shell } from "./shell/repl.js";
import { c } from "./util/term.js";
import { readJson } from "./util/fsx.js";

const VERSION = (JSON.parse(readResource("package.json")) as { version: string }).version;

const USAGE = `${c.bold("hexagon")} ${VERSION} — spec-driven multi-agent orchestrator

${c.bold("Usage")}
  hexagon                         open the interactive shell (slash commands)
  hexagon init                    set up .hexagon/ in this repository
  hexagon spec lint [files…]      validate specs
  hexagon plan [specs…] [--agent X]
  hexagon run [plan.json] [-j N] [--only T-1,T-2] [--agent X] [--budget N] [--follow]
  hexagon status [T-n] [--json]   run overview (reads status files; works without the daemon)
  hexagon attach <T-n>            live view of one agent; type to message it
  hexagon open <T-n>              open a new terminal attached to an agent
  hexagon tell <T-n|@role|@all> <text>
  hexagon answer <Q-n> <text>
  hexagon inbox | notes | stats | merge | abort | clean
  hexagon pause|resume|cancel <T-n>   ·   hexagon retry <T-n> [--agent X] [--effort E]
  hexagon diff <T-n> [--stat]     ·   hexagon logs <T-n> [N]
  hexagon up | down               start / stop the project daemon

Every command is also available inside the shell as /command. Docs: docs/COMMUNICATION.md`;

const ONE_SHOT = new Set(["plan", "run", "tell", "answer", "inbox", "notes", "stats", "merge", "abort", "clean", "pause", "resume", "cancel", "retry", "diff", "logs", "agents"]);

function root(): string {
  const r = findProjectRoot();
  if (!r) {
    console.error(c.orange("✖ not inside a Hexagon project — run `hexagon init` in your repository first"));
    process.exit(2);
  }
  return r;
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;

  if (cmd === "__daemon") {
    const { runDaemon } = await import("./daemon/run.js");
    return runDaemon(rest[0] ?? process.cwd());
  }
  if (cmd === "--version" || cmd === "-v") return void console.log(VERSION);
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return void console.log(USAGE);

  if (cmd === "init") {
    const dir = process.cwd();
    if (!(await isRepo(dir))) console.log(c.orange("! this directory is not a git repository; Hexagon runs need git (`git init` and one commit)"));
    const created = scaffold(dir);
    console.log(created.length ? `${c.blue("✔")} created:\n  ${created.join("\n  ")}` : "already initialized");
    console.log(`Next: write a spec in specs/ (see docs/ARCHITECTURE.md §3.1), then run ${c.cyan("hexagon")} and ${c.cyan("/spec lint")}, ${c.cyan("/plan")}, ${c.cyan("/run")}.`);
    return;
  }

  if (cmd === "spec") {
    if (rest[0] !== "lint") return void console.error("usage: hexagon spec lint [files…]");
    console.log(lintReport(root(), rest.slice(1)));
    return;
  }

  if (cmd === "status") {
    const r = root();
    const json = rest.includes("--json");
    const task = rest.find((a) => /^t-?\d+$/i.test(a));
    const paths = new ProjectPaths(r);
    const rs = latestRunStatus(paths);
    if (!rs) return void console.log(json ? "null" : "no runs yet");
    if (task) {
      const st = rs.agents.find((a) => a.task_id === task.toUpperCase());
      if (!st) return void console.error(`unknown task ${task}`);
      const full = readJson<AgentStatus>(paths.run(rs.run_id).agentStatus(st.agent_run_id));
      return void console.log(json ? JSON.stringify(full, null, 2) : (await import("./shell/render.js")).agentDetail(full!));
    }
    console.log(json ? JSON.stringify(rs, null, 2) : runTable(rs));
    if (!json && !daemonRunning(paths)) console.log(c.dim("(daemon not running — snapshot from status files)"));
    return;
  }

  if (cmd === "up") {
    const client = await HexClient.connect(root());
    const info = await client.call<{ pid: number }>("ping");
    console.log(`daemon running (pid ${info.pid})`);
    client.close();
    return;
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
    console.log("daemon stopped");
    return;
  }

  if (cmd === "open") {
    const r = root();
    const t = rest[0];
    if (!t) return void console.error("usage: hexagon open <T-n>");
    const { openTerminal, hexagonCommand } = await import("./shell/open.js");
    console.log(await openTerminal(t.toUpperCase(), hexagonCommand(r, ["attach", t.toUpperCase()])));
    return;
  }

  if (cmd === "takeover-shell") return takeoverShell(root(), rest[0]);

  if (!cmd || cmd === "shell" || cmd === "attach") {
    const r = root();
    if (cmd === "attach" && !rest[0]) return void console.error("usage: hexagon attach <T-n>");
    const client = await HexClient.connect(r);
    const shell = new Shell(client, r, true);
    await shell.start(cmd === "attach" ? rest[0] : undefined);
    return;
  }

  if (ONE_SHOT.has(cmd)) {
    const r = root();
    const client = await HexClient.connect(r);
    const follow = cmd === "run" && (rest.includes("--follow") || rest.includes("-f"));
    const args = rest.filter((a) => a !== "--follow" && a !== "-f");
    if (cmd === "plan" || follow) {
      await client.subscribe();
      client.on("push", (p: Push) => {
        if (p.event === "planner") {
          const e = p.data;
          if (e.type === "status_report" && e.activity) console.log(c.dim(`planner · ${e.activity}`));
          if (e.type === "tool_call") console.log(c.dim(`planner ▸ ${e.summary}`));
        }
        if (follow && p.event === "agent_event") { const l = formatEvent(p.data, false); if (l) console.log(l); }
        if (follow && p.event === "message") { const l = formatMessage(p.data); if (l && p.data.delivery.state === "delivered") console.log(l); }
        if (follow && p.event === "notice") console.log(`◆ ${p.data.text}`);
        if (follow && p.event === "run" && (p.data.state === "done" || p.data.state === "aborted")) {
          console.log(runTable(p.data));
          client.close();
          process.exit(p.data.agents.every((a) => a.state === "done") ? 0 : 1);
        }
      });
    }
    const shell = new Shell(client, r, false);
    const quoted = args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
    await shell.exec(`/${cmd} ${quoted}`);
    if (!follow) client.close();
    return;
  }

  console.error(`unknown command: ${cmd}\n\n${USAGE}`);
  process.exitCode = 2;
}

function latestRunStatus(paths: ProjectPaths): RunStatus | null {
  if (!fs.existsSync(paths.runs)) return null;
  const runs = fs.readdirSync(paths.runs).filter((d) => d.startsWith("r-")).sort();
  for (const r of runs.reverse()) {
    const s = readJson<RunStatus>(paths.run(r).status);
    if (s) return s;
  }
  return null;
}

async function takeoverShell(r: string, task: string | undefined): Promise<void> {
  if (!task) return void console.error("usage: hexagon takeover-shell <T-n>");
  const client = await HexClient.connect(r);
  const t = await client.call<{ worktree: string; branch: string; command: string[]; task_id: string }>("agent.takeover", { task });
  console.log(c.magenta(`── You have taken over ${t.task_id} ──`));
  console.log(`The agent is paused at its next safe point. You are in its worktree (branch ${t.branch}).`);
  console.log(`Edit, run tests, commit or not — when you exit this shell you choose what happens next.\n`);
  const [bin, ...args] = t.command;
  await new Promise<void>((resolve) => {
    const child = spawn(bin!, args, { cwd: t.worktree, stdio: "inherit", env: { ...process.env, HEXAGON_TASK: t.task_id } });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\n${t.task_id}: [h]and back to the agent · [d]one, verify & merge my changes · [x] discard my changes and hand back  (h/d/x) [h] `)).trim().toLowerCase();
  rl.close();
  const action = ans.startsWith("d") ? "done" : ans.startsWith("x") ? "discard" : "handback";
  await client.call("agent.takeover_end", { task: t.task_id, action });
  console.log(`${c.blue("✔")} ${action === "done" ? "marked done — the orchestrator will verify and merge" : action === "discard" ? "changes discarded, agent resumed" : "handed back to the agent"}`);
  client.close();
}

main(process.argv.slice(2)).catch((e) => {
  console.error(c.orange(`✖ ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
