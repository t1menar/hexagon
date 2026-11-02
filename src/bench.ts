import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HexClient } from "./client/client.js";
import type { Plan, RunStatus, Task } from "./contracts/types.js";
import { loadConfig } from "./core/config.js";
import { ProjectPaths, scaffold } from "./core/project.js";
import { DaemonServer } from "./daemon/server.js";

/**
 * `hexagon bench`: the same five small tasks on a fixture repository, run through the real pipeline, once per session
 * policy and idle gap. It measures what each policy costs and whether the result still works. It spends real tokens,
 * so it needs `--real` and stops when the reported cost reaches [bench] max_cost_usd.
 */
export type Policy = "a" | "b" | "c";
export const POLICIES: Record<Policy, { name: string; context: string }> = {
  a: { name: "one session per agent, whole project", context: 'session_scope = "project"\ntask_boundary = "note"' },
  b: { name: "one session per task (kept across fix loops), digest of the previous task", context: 'session_scope = "task"\ntask_boundary = "note"' },
  c: { name: "one session per agent, compacted at each task boundary", context: 'session_scope = "project"\ntask_boundary = "compact"' },
};

export interface BenchRow {
  policy: Policy; gap_s: number; agent: string;
  tasks_done: number; tasks: number; tests_pass: boolean | null;
  input: number; cache_read: number; output: number; turns: number; cost_usd: number; wall_s: number;
  capped?: boolean;
}

const FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "bench-fixture", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# bench fixture\n\nSmall helpers.\n",
  "src/mathx.js": "export function sum(xs) { return xs.reduce((a, b) => a + b, 0); }\nexport function mean(xs) { return sum(xs) / xs.length; }\n",
  "src/strings.js": "export function titleCase(s) {\n  return s.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');\n}\nexport function slug(s) { return s.toLowerCase().trim().replace(/\\s+/g, '-'); }\n",
  "test/mathx.test.js": "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sum, mean } from '../src/mathx.js';\ntest('sum', () => assert.equal(sum([1, 2, 3]), 6));\ntest('mean', () => assert.equal(mean([2, 4]), 3));\n",
  "test/strings.test.js": "import test from 'node:test';\nimport assert from 'node:assert';\nimport { titleCase, slug } from '../src/strings.js';\ntest('slug', () => assert.equal(slug(' Hello World '), 'hello-world'));\ntest('titleCase handles empty words', () => assert.equal(titleCase('a  b'), 'A  B'));\n",
};

const VERIFY = "node --test";
const T = (n: number, title: string, write: string[], description: string, extra: Partial<Task> = {}): Task => ({
  id: `T-${n}`, title, role: "developer", requirements: [], acceptance: ["AC-1"], depends_on: n > 1 ? [`T-${n - 1}`] : [],
  files: { write, read: [] }, skills: [], definition_of_done: ["`node --test` passes"], verify: [VERIFY], description, ...extra,
});

/** Five tasks of different sizes. T-1 verifies only its own test file: the suite is red on purpose until T-2 (a first version ran the whole suite and T-1 rightly refused to edit T-2's file). Each depends on the previous one, so one agent identity does them in order. */
export function benchTasks(gapSeconds = 0): Task[] {
  const tasks = [
    T(1, "Add clamp to mathx", ["src/mathx.js", "test/mathx.test.js"], "Add `clamp(n, lo, hi)` to src/mathx.js and a test for it in test/mathx.test.js.", { verify: ["node --test test/mathx.test.js"], definition_of_done: ["`node --test test/mathx.test.js` passes"] }),
    T(2, "Fix titleCase on empty words", ["src/strings.js"], "`titleCase('a  b')` crashes (the existing test fails). Fix it in src/strings.js without changing other behavior."),
    T(3, "Add a bounded queue", ["src/queue.js", "test/queue.test.js"], "Create src/queue.js exporting class `BoundedQueue` (constructor(limit), push(x) returns false when full, shift(), get size) with tests in test/queue.test.js covering full, empty and order."),
    T(4, "Move shared helpers into util.js", ["src/util.js", "src/mathx.js", "src/strings.js", "test/util.test.js"], "Create src/util.js with a `clampInt(n, lo, hi)` helper used by both mathx.js and strings.js where it fits; keep every existing export and test working; add a test in test/util.test.js."),
    T(5, "Document the helpers", ["README.md"], "Add a short usage section to README.md listing every exported function in src/ with a one-line description.", { verify: ["test -s README.md"] }),
  ];
  // The idle gap: task 3's last step waits, so the session sits unused for that long before task 4 uses it again.
  if (gapSeconds) tasks[2]!.verify = [VERIFY, `sleep ${gapSeconds}`];
  return tasks;
}

function fixtureRepo(policy: Policy, agent: string, withReview: boolean, tasks: Task[]): { root: string; plan: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hx-bench-${policy}-`));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@localhost", ...a], { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  for (const [f, c] of Object.entries(FIXTURE)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); }
  git("add", "-A"); git("commit", "-qm", "fixture");
  scaffold(root);
  const cfgFile = path.join(root, ".hexagon/config.toml");
  let cfg = fs.readFileSync(cfgFile, "utf8");
  if (agent !== "default") cfg = cfg.replace(/agent = "[^"]+"/g, `agent = "${agent}"`);
  if (agent === "mock") cfg = cfg.replace("step_ms = 600", "step_ms = 15");
  cfg = cfg.replace(/\[context\][\s\S]*?\n\n/, (m) => m.replace(/session_scope = .*\n/, "").replace(/task_boundary = .*\n/, "").replace(/\n\n$/, `\n${POLICIES[policy].context}\n\n`));
  cfg = cfg.replace(/(\[review\]\nmode = )"agent"/, `$1"${withReview ? "agent" : "off"}"`);
  cfg = cfg.replace(/allow_commands = \[/, 'allow_commands = ["node --test", "sleep", "test", "true", ');
  fs.writeFileSync(cfgFile, cfg);
  git("add", "-A"); git("commit", "-qm", "hexagon");
  const plan: Plan = { schema: "hexagon.plan/v1", id: "bench", created_at: new Date().toISOString(), specs: [], spec_issues: [], tasks };
  const planFile = path.join(root, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  return { root, plan: planFile };
}

export interface BenchOptions {
  real: boolean; agent: string; pollMs?: number; policies: Policy[]; gapsLong: number; withReview: boolean; maxCost: number; out?: string;
  log: (line: string) => void;
}

export async function runBench(o: BenchOptions): Promise<BenchRow[]> {
  // Nothing can answer a question or an approval in a bench: a run that waits for one is stopped and reported.
  const STUCK_POLLS = 30;
  let finished = 0;
  const live = new Map<string, number>();
  const spent = () => finished + [...live.values()].reduce((a, b) => a + b, 0);

  async function scenario(s: { p: Policy; gap: number }): Promise<BenchRow | null> {
    const key = `${s.p}/${s.gap}`;
    if (spent() >= o.maxCost) { o.log(`cost cap $${o.maxCost} reached ($${spent().toFixed(2)} spent): policy ${s.p}${s.gap ? ` (idle ${s.gap}s)` : ""} not run`); return null; }
    // The mock agent writes placeholder files, so its tasks cannot satisfy the fixture's real tests: only the harness is exercised.
    const tasks = benchTasks(s.gap).map((t) => (o.agent === "mock" ? { ...t, verify: [], verify_exempt: "mock agent: nothing real to run" } : t));
    const { root, plan } = fixtureRepo(s.p, o.agent, o.withReview, tasks);
    o.log(`policy ${s.p}${s.gap ? `, idle ${s.gap}s before task 4` : ""}: ${POLICIES[s.p].name} → ${root}`);
    const server = new DaemonServer(root);
    await server.listen();
    const client = await HexClient.connect(root, { autostart: false });
    const t0 = Date.now();
    let capped = false, stuck = 0;
    let rs!: RunStatus;
    try {
      await client.call("run.start", { plan_path: plan });
      for (;;) {
        rs = await client.call<RunStatus>("run.status");
        live.set(key, rs.totals.cost_usd);
        if (["done", "aborted", "failed"].includes(rs.state)) break;
        stuck = rs.agents.some((a) => a.state === "waiting_input") ? stuck + 1 : 0;
        if (spent() >= o.maxCost) { capped = true; o.log(`cost cap $${o.maxCost} reached: ${key} aborted`); }
        if (capped || stuck >= STUCK_POLLS) {
          if (stuck >= STUCK_POLLS) o.log(`${key}: waiting for an answer nobody can give: aborted`);
          await client.call("run.abort").catch(() => undefined);
          await sleep(500);
          rs = await client.call<RunStatus>("run.status");
          break;
        }
        await sleep(o.pollMs ?? 2000);
      }
    } finally {
      client.close();
      server.orch.shutdown();
    }
    // Does the integration branch pass the fixture's own tests?
    let pass: boolean | null = null;
    try {
      execFileSync("node", ["--test"], { cwd: path.join(root, ".hexagon/worktrees", rs.run_id, "integration"), stdio: "ignore", timeout: 120_000 });
      pass = true;
    } catch { pass = false; }
    const t = rs.totals;
    live.delete(key);
    finished += t.cost_usd;
    const row: BenchRow = {
      policy: s.p, gap_s: s.gap, agent: o.agent, tasks_done: rs.agents.filter((a) => a.state === "done").length, tasks: tasks.length, tests_pass: pass,
      input: t.input_tokens, cache_read: t.cache_read_tokens, output: t.output_tokens, turns: t.turns, cost_usd: t.cost_usd, wall_s: Math.round((Date.now() - t0) / 1000), ...(capped || stuck >= STUCK_POLLS ? { capped: true } : {}),
    };
    o.log(`  ${key} done: ${row.tasks_done}/${tasks.length} tasks, tests ${pass ? "pass" : "FAIL"}, input ${t.input_tokens} cache_read ${t.cache_read_tokens} output ${t.output_tokens}, $${t.cost_usd.toFixed(3)}`);
    return row;
  }

  // The long-idle runs spend almost all their time waiting: start them first and run the short ones beside them.
  const long = o.gapsLong ? o.policies.filter((p) => p !== "c").map((p) => ({ p, gap: o.gapsLong })) : [];
  const longRuns = long.map((s) => scenario(s));
  const rows: BenchRow[] = [];
  for (const p of o.policies) { const r = await scenario({ p, gap: 0 }); if (r) rows.push(r); }
  for (const r of await Promise.all(longRuns)) if (r) rows.push(r);
  if (o.out) fs.writeFileSync(o.out, JSON.stringify({ at: new Date().toISOString(), cap_usd: o.maxCost, spent_usd: finished, rows }, null, 2));
  return rows;
}

export function benchTable(rows: BenchRow[]): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const head = "| policy | idle before T-4 | tasks done | tests | fresh input | cache read | output | turns | cost | wall |\n|---|---|---|---|---|---|---|---|---|---|";
  const body = rows.map((r) => `| ${r.policy} | ${r.gap_s ? `${r.gap_s}s` : "none"} | ${r.tasks_done}/${r.tasks}${r.capped ? " (capped)" : ""} | ${r.tests_pass ? "pass" : "FAIL"} | ${k(r.input)} | ${k(r.cache_read)} | ${k(r.output)} | ${r.turns} | $${r.cost_usd.toFixed(2)} | ${r.wall_s}s |`);
  return [head, ...body].join("\n");
}

export const benchCapDefault = (): number => loadConfig("/nonexistent/config.toml").bench.max_cost_usd;
export const benchCap = (root: string): number => loadConfig(new ProjectPaths(root).config).bench.max_cost_usd;
