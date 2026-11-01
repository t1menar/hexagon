// Token benchmark on the mock agent: a 4-task chain in a mid-sized repository.
//   esbuild scripts/token-bench.ts --bundle --platform=node --format=esm --outfile=/tmp/bench.mjs && node /tmp/bench.mjs
// The mock models the real shape of token use (a cold session pays for its whole prompt, a resumed one for the new
// message plus cheap cached re-reads), so the numbers compare session handling and prompt weight, not model quality.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { HexClient } from "../src/client/client.js";
import type { Plan, RunStatus } from "../src/contracts/types.js";
import { scaffold } from "../src/core/project.js";
import { DaemonServer } from "../src/daemon/server.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const root = fs.mkdtempSync(path.join("/tmp", "hb-"));
git(root, "init", "-q", "-b", "main");
for (let i = 0; i < 300; i++) {
  const d = path.join(root, "src", `mod${i % 12}`);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `file${i}.ts`), `export const v${i} = ${i};\n`);
}
fs.writeFileSync(path.join(root, "HEXAGON.md"), "# Demo\n\n" + "Conventions: small modules, tests next to code. ".repeat(60) + "\n");
git(root, "add", "-A");
git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
scaffold(root);
const cfgFile = path.join(root, ".hexagon/config.toml");
fs.writeFileSync(cfgFile, fs.readFileSync(cfgFile, "utf8").replace(/agent = "claude"/g, 'agent = "mock"').replace("step_ms = 600", "step_ms = 20"));
git(root, "add", "-A");
git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "hexagon init");

const plan: Plan = {
  schema: "hexagon.plan/v1", id: "p", created_at: new Date().toISOString(), specs: [], spec_issues: [],
  tasks: Array.from({ length: 4 }, (_, i) => ({
    id: `T-${i + 1}`, title: `Add module ${i + 1}`, role: "developer" as const, requirements: [], acceptance: ["AC-1", "AC-2"],
    depends_on: i ? [`T-${i}`] : [], files: { write: [`src/new${i + 1}.ts`], read: [] }, skills: [], definition_of_done: ["works"], verify: [],
  })),
};
const planFile = path.join(root, "plan.json");
fs.writeFileSync(planFile, JSON.stringify(plan));

const server = new DaemonServer(root);
await server.listen();
const client = await HexClient.connect(root, { autostart: false });
await client.call("run.start", { plan_path: planFile });
let rs: RunStatus;
for (;;) { rs = await client.call<RunStatus>("run.status"); if (rs.state === "done") break; await sleep(100); }
const t = rs.totals;
console.log(JSON.stringify({ states: rs.agents.map((a) => a.state), input: t.input_tokens, cache_read: t.cache_read_tokens, output: t.output_tokens, turns: t.turns, ledger: rs.ledger ?? null }));
client.close();
server.orch.shutdown();
process.exit(0);
