import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityPrompt, loadSkills } from "../src/agents/prompts.js";
import { ProjectPaths, scaffold } from "../src/core/project.js";
import { BUILTIN_ROLES } from "../src/core/roles.js";
import { DaemonServer } from "../src/daemon/server.js";

/**
 * Prompts and permissions must not drift apart: every `hexagon <subcommand>` a role's assembled prompt tells the agent to
 * run is run here with that role's own token against a real daemon. The daemon saying "not allowed for agents" (or the
 * CLI not knowing the subcommand) fails the test. Commands that wait for the user (exec, install, sudo) are cut off by a
 * timeout: reaching the wait means the permission check already passed.
 */
const repo = path.join(import.meta.dirname, "..");
const bundleDir = path.join(repo, "build", "contract");
const cli = path.join(bundleDir, "cli.mjs");

// A role runs under an agent id: tasks are T-n, the solo roles use their role id.
const agentIdOf = (role: string): string => (role === "control" || role === "bootstrap" || role === "analyst" ? (role === "control" ? "control" : role === "bootstrap" ? "init" : "planner") : "T-1");

/** Placeholder arguments that satisfy each subcommand's own usage check; the point is only to reach the daemon. */
const ARGS: Record<string, string[]> = {
  report: ["working"], ask: ["a question?"], note: ["a fact"], done: ["--summary", "x"], review: ["approve", "--summary", "x"],
  return: ["T-2", "defect"], bus: ["read"], exec: ["--reason", "x", "--", "true"], install: ["go", "--reason", "x"], sudo: ["--reason", "x", "--", "true"],
  tell: ["T-9", "hi"], logs: ["T-9", "5"], answer: ["Q-1", "yes"], proposals: [], status: [], do: ["graph.show"], plan: ["a goal"],
  "plan-check": [], "stage-check": [], commands: [], allow: ["true"], scope: ["request", "package-lock.json", "--why", "x"],
};

function mentioned(text: string): string[] {
  return [...new Set([...text.matchAll(/`hexagon ([a-z][a-z-]*)/g)].map((m) => m[1]!))];
}

describe("every command a shipped prompt names works with that role's token", () => {
  let root: string;
  let server: DaemonServer;
  let state: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });

  beforeAll(async () => {
    await build({
      entryPoints: [path.join(repo, "src/cli.ts")], outfile: cli, bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent",
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
    });
    state = fs.mkdtempSync(path.join(os.tmpdir(), "hx-contract-state-"));
    process.env.HEXAGON_STATE_DIR = state;
    root = fs.mkdtempSync(path.join("/tmp", "hc-"));
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    server = new DaemonServer(root);
    await server.listen();
  }, 60000);
  afterAll(() => { server?.orch.shutdown(); delete process.env.HEXAGON_STATE_DIR; });

  const run = (role: string, sub: string) => new Promise<{ out: string; timedOut: boolean }>((resolve) => {
    const agent = agentIdOf(role);
    const child = execFile(process.execPath, [cli, sub, ...(ARGS[sub] ?? [])], {
      cwd: root, timeout: 4000, env: { ...process.env, HEXAGON_STATE_DIR: state, HEXAGON_ROOT: root, HEXAGON_AGENT: agent, HEXAGON_TOKEN: server.orch.tokens.issue(agent), HEXAGON_BIN: cli },
    }, (err, stdout, stderr) => resolve({ out: `${stdout}\n${stderr}`, timedOut: !!(err && (err as { killed?: boolean }).killed) }));
    child.stdin?.end();
  });

  for (const r of BUILTIN_ROLES) {
    it(`${r.id}`, async () => {
      const paths = new ProjectPaths(root);
      const subs = mentioned(identityPrompt(paths, r.id, loadSkills(paths)));
      const results = await Promise.all(subs.map(async (s) => ({ s, ...(await run(r.id, s)) })));
      const bad = results.filter((x) => /not allowed for agents|unknown command|not authenticated/.test(x.out)).map((x) => `${x.s}: ${x.out.trim().split("\n")[0]}`);
      expect(bad).toEqual([]);
    }, 60000);
  }
});
