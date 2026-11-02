import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HexClient } from "../src/client/client.js";
import { scaffold } from "../src/core/project.js";
import { METHOD_SCOPES } from "../src/daemon/auth.js";
import { DaemonServer } from "../src/daemon/server.js";

/** Send one raw request with an arbitrary token (or none) and return the reply. */
function raw(sock: string, method: string, params: Record<string, unknown>, token?: string): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock, () => c.write(JSON.stringify({ id: 1, method, params, token }) + "\n"));
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => { buf += d; if (buf.includes("\n")) { c.end(); resolve(JSON.parse(buf.split("\n")[0]!)); } });
    c.on("error", reject);
  });
}

describe("RPC callers are authenticated and scoped", () => {
  let root: string;
  let server: DaemonServer;
  let state: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" });

  beforeAll(async () => {
    state = fs.mkdtempSync(path.join(os.tmpdir(), "hx-state-"));
    process.env.HEXAGON_STATE_DIR = state;
    root = fs.mkdtempSync(path.join("/tmp", "hs-"));
    git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git("add", "-A"); git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    server = new DaemonServer(root);
    await server.listen();
  });
  afterAll(() => { server?.orch.shutdown(); delete process.env.HEXAGON_STATE_DIR; });

  const handlers = () => Object.keys((server as unknown as { handlers: Record<string, unknown> }).handlers);

  it("every RPC method declares a scope (a new method without one fails here)", () => {
    expect(handlers().filter((m) => !(m in METHOD_SCOPES))).toEqual([]);
    expect(Object.keys(METHOD_SCOPES).filter((m) => !handlers().includes(m))).toEqual([]);
  });

  it("an agent token is refused on every method that is not agent-scoped", async () => {
    const token = server.orch.tokens.issue("T-1");
    const bad: string[] = [];
    for (const m of handlers()) {
      if (METHOD_SCOPES[m] !== "user") continue;
      const r = await raw(server.orch.paths.socket, m, { rules: ["*"], text: "x", spec: "x", id: "x", question_id: "Q-1", answer: "x", task: "T-1" }, token);
      if (!r.error || !/not allowed for agents/.test(r.error.message)) bad.push(m);
    }
    expect(bad).toEqual([]);
  });

  it("no token and a wrong token are refused everywhere except ping", async () => {
    for (const t of [undefined, "nope"]) {
      for (const m of ["allow", "spec.approve", "merge.base", "question.answer", "run.start"]) {
        const r = await raw(server.orch.paths.socket, m, { rules: ["*"] }, t);
        expect(r.error?.message, m).toMatch(/not authenticated/);
      }
      expect((await raw(server.orch.paths.socket, "ping", {}, t)).result).toBeTruthy();
    }
  });

  it("an agent cannot widen its permissions through the allow RPC or the CLI client path", async () => {
    const token = server.orch.tokens.issue("T-1");
    const r = await raw(server.orch.paths.socket, "allow", { rules: ["*"] }, token);
    expect(r.error?.message).toMatch(/not allowed for agents/);
    expect(fs.existsSync(path.join(root, ".hexagon/local.toml")) ? fs.readFileSync(path.join(root, ".hexagon/local.toml"), "utf8") : "").not.toContain("*");
  });

  it("the user's client authenticates with the token file and can use user methods", async () => {
    const c = await HexClient.connect(root, { autostart: false });
    try {
      expect(await c.call("inbox.list")).toBeTruthy();
    } finally { c.close(); }
  });

  it("the agent's identity comes from its token, not from the request", async () => {
    const token = server.orch.tokens.issue("T-1");
    const spy = vi.spyOn(server.orch, "agentApi");
    await raw(server.orch.paths.socket, "agent.api", { agent: "T-9", cwd: root, op: "report", args: { activity: "hi" } }, token);
    expect(spy.mock.calls[0]![0]).toBe("T-1");
    spy.mockRestore();
  });

  it("the user token file is private and the socket is not world accessible", () => {
    const f = server.orch.paths.userToken;
    expect(fs.statSync(f).mode & 0o077).toBe(0);
    expect(fs.statSync(server.orch.paths.socket).mode & 0o007).toBe(0);
    expect(f.startsWith(root)).toBe(false);
  });
});
