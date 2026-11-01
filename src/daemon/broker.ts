/**
 * Command broker. Agents ask Hexagon to run things they cannot (or should not) run on their own:
 *   hexagon exec -- <cmd>        a command outside the allow-list: the user approves in the dashboard, then it runs
 *   hexagon install <tool>       an official toolchain release into ~/.hexagon/toolchains (no sudo)
 *   hexagon sudo -- <cmd>        a root command, run by the USER in a real terminal (Hexagon never sees the password)
 * The agent's call simply blocks until the answer, so the same session continues: no restart, no new process.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Decision = "once" | "always" | "all" | "terminal" | "deny";

export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
export const quoteArgv = (argv: string[]) => argv.map(shq).join(" ");
const COMPOUND = /[;&|`$<>()\n]/;

/** True if the user's allow-list covers this command line (prefix match, whole words; compound lines need "*"). */
export function isAllowed(cmdline: string, allow: readonly string[]): boolean {
  if (allow.includes("*")) return true;
  const c = cmdline.trim();
  if (!c || COMPOUND.test(c)) return false;
  const words = c.split(/\s+/);
  return allow.some((rule) => {
    const rw = rule.trim().split(/\s+/);
    return rw.length > 0 && rw.length <= words.length && rw.every((w, i) => w === words[i]);
  });
}

export interface RunResult { code: number | null; output: string; timedOut: boolean }

const MAX_OUTPUT = 12_000;

/** Run a command (argv, or a shell line) and return its combined output. Never throws. */
export function runCommand(o: { argv?: string[]; shell?: string; cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    const child = o.shell !== undefined
      ? spawn("/bin/sh", ["-c", o.shell], { cwd: o.cwd, env: o.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true })
      : spawn(o.argv![0]!, o.argv!.slice(1), { cwd: o.cwd, env: o.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const add = (d: Buffer) => { out = (out + d.toString("utf8")).slice(-MAX_OUTPUT * 2); };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGTERM"); } catch { /* gone */ } }, o.timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, output: `cannot run ${o.argv?.[0] ?? "sh"}: ${e.message}`, timedOut: false }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output: out.slice(-MAX_OUTPUT), timedOut }); });
  });
}

export function describeResult(r: RunResult, what: string): string {
  const head = r.timedOut ? `${what}: timed out` : `${what}: exit ${r.code}`;
  return r.output.trim() ? `${head}\n${r.output.trim()}` : head;
}

/** A script the user runs in a terminal: shows the exact command, runs it under sudo, records the exit code. */
export function sudoScript(o: { id: string; agent: string; cwd: string; argv?: string[]; shell?: string; reason?: string }): { script: string; codeFile: string; outFile: string; command: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hexagon-sudo-"));
  const codeFile = path.join(dir, "code");
  const outFile = path.join(dir, "out");
  const script = path.join(dir, "run.sh");
  const inner = o.shell !== undefined ? `sudo sh -c ${shq(o.shell)}` : `sudo ${quoteArgv(o.argv ?? [])}`;
  fs.writeFileSync(script, [
    "#!/bin/sh",
    `cd ${shq(o.cwd)} || exit 1`,
    `echo "Hexagon: agent ${o.agent} asks to run this as root${o.reason ? ` (${o.reason.replace(/["$`\\]/g, "")})` : ""}:"`,
    `echo "  $ ${inner.replace(/["$`\\]/g, "\\$&")}"`,
    "echo",
    `( ${inner}; echo $? > ${shq(codeFile)} ) 2>&1 | tee ${shq(outFile)}`,
    `[ -f ${shq(codeFile)} ] || echo 1 > ${shq(codeFile)}`,
    'echo; echo "Finished. You can close this window."',
    "",
  ].join("\n"), { mode: 0o700 });
  return { script, codeFile, outFile, command: inner };
}

/** Wait for the exit-code file written by the user's terminal. */
export async function waitForCode(codeFile: string, timeoutMs: number, aborted: () => boolean = () => false): Promise<number | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end && !aborted()) {
    try {
      const t = fs.readFileSync(codeFile, "utf8").trim();
      if (t) return Number(t);
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
