import fs from "node:fs";
import path from "node:path";
import { redactDeep } from "./redact.js";

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write JSON atomically: tmp file + fsync + rename, so readers never see a partial file. */
export function atomicWriteJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(redactDeep(data), null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function appendJsonl(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(redactDeep(data)) + "\n");
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // tolerate a torn last line after a crash
    }
  }
  return out;
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Minimal glob → RegExp: supports **, *, ? and {a,b}. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) { re += "\\{"; continue; }
      re += "(?:" + glob.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")";
      i = end;
    } else re += escapeRe(c);
  }
  return new RegExp("^" + re + "$");
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function matchesAny(file: string, globs: string[]): boolean {
  const norm = file.split(path.sep).join("/").replace(/^\.\//, "");
  return globs.some((g) => globToRegExp(g.replace(/^\.\//, "")).test(norm));
}

/** Resolve a model-supplied relative path and refuse anything escaping root. */
export function confinePath(root: string, p: string): string | null {
  const target = path.resolve(root, p);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  return target;
}

export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 40) / 2);
  return `${s.slice(0, half)}\n… [${s.length - 2 * half} chars truncated] …\n${s.slice(-half)}`;
}
