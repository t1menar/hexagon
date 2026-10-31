import fs from "node:fs";
import path from "node:path";
import type { Role, Task } from "../contracts/types.js";
import { PACKAGE_ROOT, type ProjectPaths } from "../core/project.js";
import { listProjectFiles, type Spec } from "../core/spec.js";

export interface Skill { name: string; version: string; appliesTo: string[]; body: string }

export function loadRolePrompt(paths: ProjectPaths, role: Role): string {
  for (const dir of [paths.roles, path.join(PACKAGE_ROOT, "templates", "roles")]) {
    const f = path.join(dir, `${role}.md`);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  }
  throw new Error(`no role prompt for ${role}`);
}

export function loadSkills(paths: ProjectPaths): Skill[] {
  const dirs = [paths.skills, path.join(PACKAGE_ROOT, "templates", "skills")];
  const byName = new Map<string, Skill>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".skill.md"))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
      const meta: Record<string, string> = {};
      for (const line of (m?.[1] ?? "").split("\n")) {
        const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
        if (kv) meta[kv[1]!] = kv[2]!.trim();
      }
      const name = meta.name ?? f.replace(/\.skill\.md$/, "");
      if (byName.has(name)) continue; // project skills override packaged ones
      byName.set(name, {
        name,
        version: meta.version ?? "1",
        appliesTo: (meta.applies_to ?? "").replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean),
        body: (m?.[2] ?? text).trim(),
      });
    }
  }
  return [...byName.values()];
}

/** Skills for a role (+ task-requested ones), alphabetical for a stable cache prefix. */
export function skillsBlock(skills: Skill[], role: Role, requested: string[] = []): string {
  const picked = skills
    .filter((s) => s.appliesTo.includes(role) || requested.includes(s.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!picked.length) return "";
  return "# Skills\n\n" + picked.map((s) => `<skill name="${s.name}" version="${s.version}">\n${s.body}\n</skill>`).join("\n\n");
}

/** Stable per-run project context: repository map. */
export function projectContext(root: string, maxFiles = 400): string {
  const files = listProjectFiles(root, maxFiles + 1);
  const shown = files.slice(0, maxFiles).sort();
  const more = files.length > maxFiles ? `\n… and more files (use list_files)` : "";
  const ctxFile = path.join(root, ".hexagon", "context.md");
  const extra = fs.existsSync(ctxFile) ? `\n\n## Project notes\n${fs.readFileSync(ctxFile, "utf8").trim()}` : "";
  return `# Project\n\n## Repository files\n${shown.join("\n")}${more}${extra}`;
}

export function systemLayers(paths: ProjectPaths, role: Role, skills: Skill[], requested: string[], context: string): string[] {
  return [loadRolePrompt(paths, role), skillsBlock(skills, role, requested), context].filter(Boolean);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function taskCard(task: Task, specs: Spec[], opts: { notes: string; files: { path: string; content: string }[] }): string {
  const reqs = specs.flatMap((s) => s.requirements).filter((r) => task.requirements.includes(r.id));
  const acs = reqs.flatMap((r) => r.acceptance.filter((a) => task.acceptance.includes(a.id)).map((a) => ({ req: r.id, ...a })));
  const parts = [
    `<task id="${task.id}" role="${task.role}">`,
    `  <title>${esc(task.title)}</title>`,
    task.description ? `  <description>${esc(task.description)}</description>` : "",
    "  <requirements>",
    ...reqs.map((r) => `    <req id="${r.id}" title="${esc(r.title)}">\n${esc(r.body)}\n    </req>`),
    "  </requirements>",
    "  <acceptance>",
    ...(acs.length ? acs.map((a) => `    <ac id="${a.id}" req="${a.req}">${esc(a.text)}</ac>`) : task.acceptance.map((a) => `    <ac id="${a}"/>`)),
    "  </acceptance>",
    `  <scope write="${esc(task.files.write.join(", "))}" read="${esc(task.files.read.join(", "))}"/>`,
    "  <definition_of_done>",
    ...task.definition_of_done.map((d) => `    <check>${esc(d)}</check>`),
    ...task.verify.map((v) => `    <cmd>${esc(v)}</cmd>`),
    "  </definition_of_done>",
    "  <context>",
    opts.notes.trim() ? `    <notes>\n${esc(opts.notes.trim())}\n    </notes>` : "",
    ...opts.files.map((f) => `    <file path="${esc(f.path)}">\n${esc(f.content)}\n    </file>`),
    "  </context>",
    "</task>",
    "",
    `Complete task ${task.id}. Finish with ${task.role === "tester" || task.role === "implementer" ? "submit_result" : "the submit tool"}.`,
  ];
  return parts.filter((l) => l !== "").join("\n");
}

/** Current contents of concrete (non-glob) write-scope files, capped. */
export function scopeFiles(cwd: string, task: Task, maxChars = 60_000): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  let total = 0;
  for (const g of task.files.write) {
    if (/[*?{]/.test(g)) continue;
    const abs = path.join(cwd, g);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const content = fs.readFileSync(abs, "utf8");
    if (total + content.length > maxChars) break;
    total += content.length;
    out.push({ path: g, content });
  }
  return out;
}
