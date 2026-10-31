import fs from "node:fs";
import path from "node:path";
import { globToRegExp } from "../util/fsx.js";

export interface AcceptanceCriterion { id: string; text: string; line: number }
export interface Requirement {
  id: string;
  title: string;
  body: string;
  acceptance: AcceptanceCriterion[];
  constraints: string | null;
  touches: string[];
  line: number;
}
export interface Spec {
  file: string;
  meta: Record<string, string>;
  title: string | null;
  requirements: Requirement[];
  raw: string;
}

export interface LintIssue { file: string; line: number; level: "error" | "warning"; rule: string; message: string }

const REQ_RE = /^##\s+(REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*)\s*:\s*(.+?)\s*$/;
const AC_RE = /^\s*[-*]\s+\**(AC-\d+)\**\s*[:.)-]\s*(.+?)\s*$/;
const VAGUE = ["fast", "quick", "user-friendly", "intuitive", "easy", "simple", "robust", "scalable", "efficient", "appropriate", "nice", "seamless", "etc"];

export function parseSpec(file: string, text = fs.readFileSync(file, "utf8")): Spec {
  const lines = text.split("\n");
  const meta: Record<string, string> = {};
  let i = 0;
  if (lines[0]?.trim() === "---") {
    for (i = 1; i < lines.length && lines[i]!.trim() !== "---"; i++) {
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(lines[i]!);
      if (m) meta[m[1]!] = m[2]!.trim();
    }
    i++;
  }
  let title: string | null = null;
  const reqs: Requirement[] = [];
  let cur: Requirement | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 && !title) { title = h1[1]!.trim(); continue; }
    const rm = REQ_RE.exec(line);
    if (rm) {
      cur = { id: rm[1]!, title: rm[2]!, body: "", acceptance: [], constraints: null, touches: [], line: i + 1 };
      reqs.push(cur);
      continue;
    }
    if (/^##\s/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    cur.body += line + "\n";
    const ac = AC_RE.exec(line);
    if (ac) { cur.acceptance.push({ id: ac[1]!, text: ac[2]!, line: i + 1 }); continue; }
    const cons = /^\s*\*\*Constraints\*\*\s*:?\s*(.+)$/i.exec(line);
    if (cons) cur.constraints = cons[1]!.trim();
    const touch = /^\s*\*\*Touches\*\*\s*:?\s*(.+)$/i.exec(line);
    if (touch) cur.touches = [...touch[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  }
  for (const r of reqs) r.body = r.body.trim();
  return { file, meta, title, requirements: reqs, raw: text };
}

export function lintSpec(spec: Spec, projectFiles?: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (line: number, level: LintIssue["level"], rule: string, message: string) =>
    issues.push({ file: spec.file, line, level, rule, message });

  if (!spec.meta.spec) add(1, "warning", "frontmatter", "missing `spec:` name in frontmatter");
  if (spec.requirements.length === 0) add(1, "error", "no-requirements", "no `## REQ-…: title` headings found");

  const seen = new Map<string, number>();
  for (const r of spec.requirements) {
    if (seen.has(r.id)) add(r.line, "error", "duplicate-req", `${r.id} already defined on line ${seen.get(r.id)}`);
    seen.set(r.id, r.line);
    if (r.acceptance.length === 0) add(r.line, "error", "no-acceptance", `${r.id} has no acceptance criteria (\`- AC-1: …\`)`);
    const acs = new Set<string>();
    for (const ac of r.acceptance) {
      if (acs.has(ac.id)) add(ac.line, "error", "duplicate-ac", `${r.id}/${ac.id} is duplicated`);
      acs.add(ac.id);
      const words: string[] = ac.text.toLowerCase().match(/[a-z-]+/g) ?? [];
      const vague = VAGUE.filter((v) => words.includes(v));
      if (vague.length) add(ac.line, "warning", "vague-acceptance", `${r.id}/${ac.id} uses unmeasurable wording: ${vague.join(", ")}`);
    }
    if (projectFiles) {
      for (const g of r.touches) {
        const re = globToRegExp(g.replace(/^\.\//, ""));
        if (!projectFiles.some((f) => re.test(f))) add(r.line, "warning", "touches-missing", `${r.id} Touches \`${g}\` matches no files yet`);
      }
    }
  }
  return issues;
}

/** Project files (relative, forward slashes) excluding heavy/irrelevant dirs. */
export function listProjectFiles(root: string, limit = 50_000): string[] {
  const skip = new Set([".git", "node_modules", ".hexagon", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next"]);
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
      if (out.length >= limit) return;
    }
  };
  walk(root);
  return out;
}

export function findSpecs(root: string, args: string[]): string[] {
  if (args.length) return args.map((a) => path.resolve(a));
  const dir = path.join(root, "specs");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => path.join(dir, f));
}
