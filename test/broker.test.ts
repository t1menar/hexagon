import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HexClient } from "../src/client/client.js";
import { allowLocal, loadConfig } from "../src/core/config.js";
import { scaffold } from "../src/core/project.js";
import { isAllowed, quoteArgv, runCommand, sudoScript } from "../src/daemon/broker.js";
import { DaemonServer } from "../src/daemon/server.js";
import type { PermissionRequest } from "../src/daemon/orchestrator.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); }
}

describe("broker helpers", () => {
  it("allow-list matches whole words, multi-word rules, and refuses compound lines", () => {
    const allow = ["npm", "git status", "go"];
    expect(isAllowed("npm test", allow)).toBe(true);
    expect(isAllowed("npmx test", allow)).toBe(false);
    expect(isAllowed("git status -s", allow)).toBe(true);
    expect(isAllowed("git push", allow)).toBe(false);
    expect(isAllowed("go vet ./... && rm -rf x", allow)).toBe(false);
    expect(isAllowed("anything at all; rm x", ["*"])).toBe(true);
    expect(isAllowed("", allow)).toBe(false);
  });
  it("quotes argv safely", () => {
    expect(quoteArgv(["echo", "a b", "it's", "plain-1.0"])).toBe("echo 'a b' 'it'\\''s' plain-1.0");
  });
  it("runs commands, captures output and exit code, and times out", async () => {
    const ok = await runCommand({ argv: ["printf", "hi"], cwd: os.tmpdir(), timeoutMs: 5000 });
    expect(ok).toMatchObject({ code: 0, output: "hi", timedOut: false });
    const bad = await runCommand({ shell: "echo oops >&2; exit 3", cwd: os.tmpdir(), timeoutMs: 5000 });
    expect(bad.code).toBe(3); expect(bad.output).toContain("oops");
    const slow = await runCommand({ argv: ["sleep", "5"], cwd: os.tmpdir(), timeoutMs: 100 });
    expect(slow.timedOut).toBe(true);
    const missing = await runCommand({ argv: ["definitely-not-a-command-xyz"], cwd: os.tmpdir(), timeoutMs: 1000 });
    expect(missing.code).toBe(127);
  });
  it("sudo script shows the exact command, never asks Hexagon for a password, and records the exit code", () => {
    const sc = sudoScript({ id: "1", agent: "T-2", cwd: "/tmp", argv: ["brew", "install", "go"], reason: "need go" });
    const text = fs.readFileSync(sc.script, "utf8");
    expect(text).toContain("sudo brew install go");
    expect(text).toContain("T-2");
    expect(text).not.toMatch(/password|askpass|sudo -S|-S\b/i);
    expect(text).toContain(sc.codeFile);
    fs.rmSync(path.dirname(sc.script), { recursive: true, force: true });
  });
  it("personal approvals go to local.toml, outside git, and are merged into the config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hx-loc-"));
    git(root, "init", "-q", "-b", "main");
    fs.mkdirSync(path.join(root, ".hexagon"));
    const cfg = path.join(root, ".hexagon/config.toml");
    fs.writeFileSync(cfg, '[sandbox]\nallow_commands = ["ls"]\n');
    expect(allowLocal(cfg, ["brew", "*"])).toEqual(["brew", "*"]);
    expect(allowLocal(cfg, ["brew"])).toEqual([]);
    expect(fs.readFileSync(cfg, "utf8")).not.toContain("brew");
    expect(fs.readFileSync(path.join(root, ".hexagon/local.toml"), "utf8")).toContain('"brew"');
    expect(loadConfig(cfg).sandbox.allow_commands).toEqual(expect.arrayContaining(["ls", "brew", "*"]));
    expect(fs.readFileSync(path.join(root, ".git/info/exclude"), "utf8")).toContain(".hexagon/local.toml");
    fs.writeFileSync(path.join(root, "x"), "");
    expect(git(root, "status", "--porcelain")).not.toContain("local.toml");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("hexagon exec / install / sudo through the daemon", () => {
  let root: string, server: DaemonServer, client: HexClient;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join("/tmp", "hb-"));
    git(root, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
    git(root, "add", "-A");
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    scaffold(root);
    server = new DaemonServer(root);
    await server.listen();
    client = await HexClient.connect(root, { autostart: false });
    await client.subscribe();
  });
  afterAll(() => { client?.close(); server?.orch.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });

  const call = (op: string, args: Record<string, unknown>) => client.call<{ ok: boolean; message: string }>("agent.api", { agent: "T-9", cwd: root, op, args });
  const pending = async () => until(async () => (await client.call<{ permissions: PermissionRequest[] }>("ui.snapshot")).permissions[0]);
  const answer = (id: string, a: string) => client.call("question.answer", { question_id: id, answer: a });

  it("an allowed command runs at once, without asking", async () => {
    const r = await call("exec", { argv: ["ls", "."] });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("README.md");
  });
  it("an unlisted command waits for the user, then runs in the same call (no restart)", async () => {
    const p = call("exec", { argv: ["printf", "hello"], reason: "demo" });
    const req = await pending();
    expect(req).toMatchObject({ agent: "T-9", action: "exec", reason: "demo", prefix: "printf" });
    expect(req.choices!.map((c) => c.id)).toEqual(["once", "always", "all", "deny"]);
    await answer(req.id, "y");
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.message).toContain("hello");
    expect(fs.existsSync(path.join(root, ".hexagon/local.toml"))).toBe(false); // "once" remembers nothing
  });
  it("'always' remembers the prefix in local.toml (not the committed config) and stops asking", async () => {
    const p = call("exec", { argv: ["printf", "again"] });
    const req = await pending();
    await answer(req.id, "always");
    expect((await p).message).toContain("again");
    expect(fs.readFileSync(path.join(root, ".hexagon/local.toml"), "utf8")).toContain("printf");
    expect(fs.readFileSync(path.join(root, ".hexagon/config.toml"), "utf8")).not.toContain("printf");
    const r = await call("exec", { argv: ["printf", "third"] });
    expect(r.message).toContain("third"); // no question this time
  });
  it("deny tells the agent not to retry or work around it", async () => {
    const p = call("exec", { argv: ["factor", "12"] });
    const req = await pending();
    await answer(req.id, "n");
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/denied.*Don't retry/);
  });
  it("a compound line is never covered by a prefix and needs its own approval", async () => {
    const p = call("exec", { shell: "printf a && printf b" });
    const req = await pending();
    expect(req.prefix).toBeNull();
    expect(req.choices!.map((c) => c.id)).not.toContain("always");
    await answer(req.id, "once");
    expect((await p).message).toContain("ab");
  });
  it("install only offers the known toolchains", async () => {
    const r = await call("install", { tool: "cobol" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/go.*node/s);
  });
  it("sudo always asks, and a denial comes back as a clear message", async () => {
    const p = call("sudo", { argv: ["true"], reason: "test" });
    const req = await pending();
    expect(req).toMatchObject({ action: "sudo", command: "sudo true" });
    expect(req.choices!.map((c) => c.id)).toEqual(["terminal", "deny"]);
    await answer(req.id, "n");
    expect((await p).ok).toBe(false);
  });
  it("answers can be given by number too", async () => {
    const p = call("exec", { argv: ["whoami"] });
    const req = await pending();
    await answer(req.id, "4"); // deny
    expect((await p).ok).toBe(false);
  });
});
