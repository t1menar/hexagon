import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { ProjectPaths } from "../core/project.js";
import type { Push } from "../daemon/orchestrator.js";
import { selfCommand } from "../util/resources.js";

/** Client for the per-project daemon. Emits "push" for subscribed events and "close". */
export class HexClient extends EventEmitter {
  private sock: net.Socket | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";

  constructor(readonly paths: ProjectPaths) {
    super();
  }

  static async connect(root: string, opts: { autostart?: boolean } = {}): Promise<HexClient> {
    const c = new HexClient(new ProjectPaths(root));
    try {
      await c.open();
    } catch {
      if (opts.autostart === false) throw new Error("Hexagon daemon is not running (start it with `hexagon up`).");
      await startDaemon(c.paths);
      await c.open();
    }
    return c;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.connect(this.paths.socket);
      s.setEncoding("utf8");
      s.once("connect", () => {
        this.sock = s;
        resolve();
      });
      s.once("error", reject);
      s.on("data", (chunk: string) => this.onData(chunk));
      s.on("close", () => {
        for (const p of this.pending.values()) p.reject(new Error("daemon connection closed"));
        this.pending.clear();
        this.emit("close");
      });
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string }; event?: string };
      if (msg.event) {
        this.emit("push", msg as Push);
        continue;
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.sock) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock!.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async subscribe(): Promise<void> {
    await this.call("subscribe");
  }

  close(): void {
    this.sock?.end();
  }
}

export async function startDaemon(paths: ProjectPaths): Promise<void> {
  const [bin, ...pre] = selfCommand();
  fs.mkdirSync(paths.hex, { recursive: true });
  const log = fs.openSync(paths.daemonLog, "a");
  const child = spawn(bin!, [...pre, "__daemon", paths.root], { cwd: paths.root, detached: true, stdio: ["ignore", log, log], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (fs.existsSync(paths.socket)) {
      const ok = await new Promise<boolean>((resolve) => {
        const s = net.connect(paths.socket, () => { s.end(); resolve(true); });
        s.on("error", () => resolve(false));
      });
      if (ok) return;
    }
    if (child.exitCode !== null) break;
  }
  const tail = fs.existsSync(paths.daemonLog) ? fs.readFileSync(paths.daemonLog, "utf8").split("\n").slice(-5).join("\n") : "";
  throw new Error(`daemon failed to start. ${tail ? `Log:\n${tail}` : ""}`);
}

export function daemonRunning(paths: ProjectPaths): boolean {
  if (!fs.existsSync(paths.daemonInfo)) return false;
  try {
    const info = JSON.parse(fs.readFileSync(paths.daemonInfo, "utf8")) as { pid: number };
    process.kill(info.pid, 0);
    return true;
  } catch {
    return false;
  }
}
