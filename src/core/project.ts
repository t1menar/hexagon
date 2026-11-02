import { isStaleRolePrompt } from "../agents/prompts.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listResources, readResource } from "../util/resources.js";
import { userTokenPath } from "../util/token.js";

/** Walk up from cwd to the directory containing .hexagon/ (or a git root as a fallback). */
export function findProjectRoot(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".hexagon"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireProjectRoot(): string {
  const root = findProjectRoot();
  if (!root) {
    throw new Error("Not inside a Hexagon project. Run `hexagon init` in your repository first.");
  }
  return root;
}

export class ProjectPaths {
  constructor(readonly root: string) {}
  get hex() { return path.join(this.root, ".hexagon"); }
  get config() { return path.join(this.hex, "config.toml"); }
  /** Unix socket paths are limited (~104 bytes on macOS); fall back to /tmp for deep projects. */
  get socket() {
    const local = path.join(this.hex, "hexagon.sock");
    if (Buffer.byteLength(local) < 100) return local;
    const hash = createHash("sha1").update(this.root).digest("hex").slice(0, 12);
    return path.join("/tmp", `hexagon-${process.getuid?.() ?? 0}-${hash}.sock`);
  }
  /** The user's RPC token: in the user's state directory, not in the project (see daemon/auth.ts). */
  get userToken() { return userTokenPath(this.root); }
  get daemonInfo() { return path.join(this.hex, "daemon.json"); }
  get daemonLog() { return path.join(this.hex, "daemon.log"); }
  get roles() { return path.join(this.hex, "roles"); }
  get skills() { return path.join(this.hex, "skills"); }
  get sessions() { return path.join(this.hex, "sessions"); }
  get runs() { return path.join(this.hex, "runs"); }
  get worktrees() { return path.join(this.hex, "worktrees"); }
  get plans() { return path.join(this.hex, "plans"); }
  get history() { return path.join(this.hex, "shell_history"); }
  run(runId: string) { return new RunPaths(path.join(this.runs, runId)); }
}

export class RunPaths {
  constructor(readonly dir: string) {}
  get status() { return path.join(this.dir, "run.status.json"); }
  get plan() { return path.join(this.dir, "plan.json"); }
  get events() { return path.join(this.dir, "events.jsonl"); }
  get messages() { return path.join(this.dir, "messages.jsonl"); }
  get notes() { return path.join(this.dir, "notes.md"); }
  agentDir(agentRunId: string) { return path.join(this.dir, "agents", agentRunId); }
  agentStatus(agentRunId: string) { return path.join(this.agentDir(agentRunId), "status.json"); }
  agentEvents(agentRunId: string) { return path.join(this.agentDir(agentRunId), "events.jsonl"); }
  agentResult(agentRunId: string) { return path.join(this.agentDir(agentRunId), "result.json"); }
  agentTranscript(agentRunId: string) { return path.join(this.agentDir(agentRunId), "transcript.jsonl"); }
}

/** Copy templates (config, roles, skills) into .hexagon/ without overwriting existing files. */
export function scaffold(root: string): string[] {
  const p = new ProjectPaths(root);
  const created: string[] = [];
  const copy = (resource: string, to: string) => {
    if (fs.existsSync(to)) {
      // Refresh role prompts from v0.1 that still reference the removed API tools.
      const cur = fs.readFileSync(to, "utf8");
      const fresh = readResource(resource);
      if (!/\/roles\//.test(to) || cur.trim() === fresh.trim() || !isStaleRolePrompt(cur)) return;
      fs.writeFileSync(to, fresh);
      created.push(`${path.relative(root, to)} (updated)`);
      return;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, readResource(resource));
    created.push(path.relative(root, to));
  };
  copy("templates/config.toml", p.config);
  for (const dir of ["roles", "skills"] as const) {
    for (const f of listResources(`templates/${dir}`)) copy(`templates/${dir}/${f}`, path.join(p.hex, dir, f));
  }
  fs.mkdirSync(p.runs, { recursive: true });
  fs.mkdirSync(path.join(root, "specs"), { recursive: true });
  const gi = path.join(root, ".gitignore");
  const ignore = [".hexagon/runs/", ".hexagon/worktrees/", ".hexagon/drafts/", ".hexagon/bin/", ".hexagon/plans/", ".hexagon/sessions/", ".hexagon/metrics.db", ".hexagon/hexagon.sock", ".hexagon/daemon.*", ".hexagon/shell_history"];
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const missing = ignore.filter((l) => !existing.split("\n").includes(l));
  if (missing.length) {
    const head = existing.includes("# Hexagon local/personal data") ? [] : ["# Hexagon local/personal data"];
    fs.appendFileSync(gi, (existing && !existing.endsWith("\n") ? "\n" : "") + [...head, ...missing].join("\n") + "\n");
    created.push(".gitignore (updated)");
  }
  return created;
}
