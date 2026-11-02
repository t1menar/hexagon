import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/agents/claude-code.js";
import { agentProcessEnv } from "../src/agents/contracts/env.js";
import { DEFAULT_CONFIG, loadConfig, SAFE_COMMANDS } from "../src/core/config.js";
import { configWarnings, securitySummary } from "../src/core/security.js";

const RUNS_ANYTHING = ["sh", "bash", "node", "python", "python3", "make", "npx", "find", "printenv", "env"];

describe("default allow-lists", () => {
  it("contain no shell, interpreter or env dump", () => {
    const all = [...DEFAULT_CONFIG.sandbox.allow_commands, ...SAFE_COMMANDS];
    expect(all.filter((c) => RUNS_ANYTHING.includes(c))).toEqual([]);
  });

  it("the config template matches the defaults", () => {
    const tpl = fs.readFileSync(path.join(import.meta.dirname, "../templates/config.toml"), "utf8");
    const line = /^allow_commands = (\[.*\])$/m.exec(tpl)![1]!;
    expect(JSON.parse(line)).toEqual(DEFAULT_CONFIG.sandbox.allow_commands);
  });

  it("an existing config that allows sh keeps it, and says so", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hx-cfg-"));
    const f = path.join(dir, "config.toml");
    fs.writeFileSync(f, '[sandbox]\nallow_commands = ["npm", "sh", "python3"]\n');
    const cfg = loadConfig(f);
    expect(cfg.sandbox.allow_commands).toEqual(expect.arrayContaining(["sh", "python3"]));
    const w = configWarnings(cfg);
    expect(w.some((x) => x.includes('"sh"'))).toBe(true);
    expect(w.some((x) => x.includes('"python3"'))).toBe(true);
    expect(securitySummary(cfg).join("\n")).toMatch(/!.*"sh"/);
    expect(configWarnings(DEFAULT_CONFIG)).toEqual([]);
  });

  it("the summary says what is not enforced", () => {
    const text = securitySummary(DEFAULT_CONFIG, [{ id: "a", display_name: "A", security: { commandAllowList: false, readOnlyEnforced: true } }]).join("\n");
    expect(text).toMatch(/Not enforced/);
    expect(text).toMatch(/a \(A\): command allow-list NO, read-only roles yes/);
  });
});

describe("agent environment", () => {
  const source = { PATH: "/bin", HOME: "/h", LANG: "en", TERM: "xterm", AWS_SECRET_ACCESS_KEY: "s", GITHUB_TOKEN: "g", DATABASE_URL: "d", MY_LOGIN: "m", LC_ALL: "C", HEXAGON_STATE_DIR: "/x" };

  it("passes the base set and the adapter's login variables, nothing else", () => {
    const e = agentProcessEnv({ HEXAGON_TOKEN: "t" }, ["MY_*"], [], source);
    expect(Object.keys(e).sort()).toEqual(["HEXAGON_TOKEN", "HOME", "LANG", "LC_ALL", "MY_LOGIN", "PATH", "TERM"]);
  });

  it("[agents.x].env_passthrough adds exactly what the user named", () => {
    const e = agentProcessEnv({}, [], ["DATABASE_URL"], source);
    expect(e.DATABASE_URL).toBe("d");
    expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(e.GITHUB_TOKEN).toBeUndefined();
  });
});

describe("secret files", () => {
  it("the Claude integration refuses dotenv reads in editing and read-only runs", () => {
    const a = new ClaudeCodeAdapter("c", { command: ["claude"], args: [] } as never);
    const base = { sessionId: "s", resume: false, env: {}, allowCommands: ["npm"], system: "", effort: "low", prompt: "" } as never;
    for (const readOnly of [true, false]) {
      const args = a.args({ ...(base as object), readOnly } as never);
      const i = args.indexOf("--disallowedTools");
      expect(i).toBeGreaterThan(-1);
      expect(args.slice(i)).toContain("Read(**/.env)");
    }
  });
});
