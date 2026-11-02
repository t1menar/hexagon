import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The user's token lives in the user's state directory, mode 0600, outside every project and worktree.
 * Limit: without an OS sandbox a process running as the same user can read it. This stops confused or
 * prompt-injected agents, not a determined attacker (docs/SECURITY.md).
 */
export function stateDir(): string {
  return process.env.HEXAGON_STATE_DIR || path.join(os.homedir(), ".hexagon-state");
}

export function userTokenPath(root: string): string {
  return path.join(stateDir(), "tokens", createHash("sha1").update(root).digest("hex").slice(0, 16));
}

export function ensureUserToken(root: string): string {
  const file = userTokenPath(root);
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  } catch { /* create below */ }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString("hex");
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return t;
}

export function readUserToken(root: string): string | undefined {
  try { return fs.readFileSync(userTokenPath(root), "utf8").trim() || undefined; } catch { return undefined; }
}

export function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
