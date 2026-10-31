import { spawn } from "node:child_process";

export interface ShellResult { code: number; output: string; timedOut: boolean }

/** Run a shell command in its own process group; kill the whole group on timeout/abort. */
export function runShell(cmd: string, cwd: string, timeoutS: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...env }, detached: true });
    let output = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutS * 1000);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({ code: code ?? 1, output, timedOut });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, output: String(e), timedOut: false }); });
  });
}
