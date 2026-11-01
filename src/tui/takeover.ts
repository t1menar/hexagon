import { spawn } from "node:child_process";
import readline from "node:readline/promises";
import type { HexClient } from "../client/client.js";
import { c } from "../util/term.js";

/** Run the agent's own session (the CLI's own resume command) in this terminal, then hand back. */
export async function takeoverInTerminal(client: HexClient, task: string): Promise<string> {
  const t = await client.call<{ worktree: string; branch: string; command: string[]; task_id: string }>("agent.takeover", { task });
  console.log(c.magenta(`\n── You have taken over ${t.task_id} ──`));
  console.log(`The agent is paused. You are in its worktree (branch ${t.branch}), in the agent's own session.`);
  console.log(c.dim(`$ ${t.command.join(" ")}\nExit it when you're done; then choose what happens next.\n`));
  const [bin, ...args] = t.command;
  await new Promise<void>((resolve) => {
    const child = spawn(bin!, args, { cwd: t.worktree, stdio: "inherit", env: { ...process.env, HEXAGON_TASK: t.task_id } });
    child.on("exit", () => resolve());
    child.on("error", (e) => { console.log(c.orange(`could not start ${bin}: ${e.message}`)); resolve(); });
  });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`\n${t.task_id}: [h]and back to the agent · [d]one — verify & merge my changes · [x] discard my changes  (h/d/x) [h] `)).trim().toLowerCase();
  rl.close();
  const action = ans.startsWith("d") ? "done" : ans.startsWith("x") ? "discard" : "handback";
  await client.call("agent.takeover_end", { task: t.task_id, action });
  return action === "done" ? `${t.task_id}: marked done — Hexagon will verify and merge` : action === "discard" ? `${t.task_id}: your changes were discarded; agent resumed` : `${t.task_id}: handed back to the agent`;
}
