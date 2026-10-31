import fs from "node:fs";
import path from "node:path";
import type { Role, Task } from "../contracts/types.js";
import type { ProjectPaths } from "../core/project.js";
import { listProjectFiles, type Spec } from "../core/spec.js";
import { hasResource, listResources, readResource } from "../util/resources.js";
import { protocolInstructions } from "./protocol.js";

export interface Skill { name: string; version: string; appliesTo: string[]; body: string }

/** Role prompts written for the v0.1 API tools (submit_result etc.) don't work with CLI agents. */
export const isStaleRolePrompt = (text: string) => /\b(submit_result|submit_review|submit_plan|report_status|ask_user)\b/.test(text);

export function loadRolePrompt(paths: ProjectPaths, role: Role): string {
  const f = path.join(paths.roles, `${role}.md`);
  if (fs.existsSync(f)) {
    const text = fs.readFileSync(f, "utf8").trim();
    if (!isStaleRolePrompt(text)) return text;
  }
  const packaged = `templates/roles/${role}.md`;
  if (hasResource(packaged)) return readResource(packaged).trim();
  throw new Error(`no role prompt for ${role}`);
}

export function loadSkills(paths: ProjectPaths): Skill[] {
  // Project skills first (they override packaged ones with the same name).
  const sources: { name: string; read: () => string }[] = [];
  if (fs.existsSync(paths.skills)) {
    for (const f of fs.readdirSync(paths.skills).sort()) sources.push({ name: f, read: () => fs.readFileSync(path.join(paths.skills, f), "utf8") });
  }
  for (const f of listResources("templates/skills")) sources.push({ name: f, read: () => readResource(`templates/skills/${f}`) });
  const byName = new Map<string, Skill>();
  for (const { name: f, read } of sources.filter((s) => s.name.endsWith(".skill.md"))) {
    const text = read();
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    const meta: Record<string, string> = {};
    for (const line of (m?.[1] ?? "").split("\n")) {
      const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (kv) meta[kv[1]!] = kv[2]!.trim();
    }
    const name = meta.name ?? f.replace(/\.skill\.md$/, "");
    if (byName.has(name)) continue;
    byName.set(name, {
      name,
      version: meta.version ?? "1",
      appliesTo: (meta.applies_to ?? "").replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean),
      body: (m?.[2] ?? text).trim(),
    });
  }
  return [...byName.values()];
}

/** Skills for a role (+ task-requested ones), alphabetical for a stable prefix. */
export function skillsBlock(skills: Skill[], role: Role, requested: string[] = []): string {
  const picked = skills
    .filter((s) => s.appliesTo.includes(role) || requested.includes(s.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!picked.length) return "";
  return "# Skills\n\n" + picked.map((s) => `<skill name="${s.name}" version="${s.version}">\n${s.body}\n</skill>`).join("\n\n");
}

/** The project's context file, written by `hexagon init` (HEXAGON.md) or by hand. */
export function contextFile(root: string): string | null {
  for (const f of ["HEXAGON.md", ".hexagon/context.md"]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Stable per-run project context: HEXAGON.md + a short repository map. */
export function projectContext(root: string, maxFiles = 200): string {
  const ctx = contextFile(root);
  const notes = ctx ? fs.readFileSync(ctx, "utf8").trim() : "";
  const files = listProjectFiles(root, maxFiles + 1);
  const shown = files.slice(0, maxFiles).sort();
  const more = files.length > maxFiles ? "\n… (more files)" : "";
  return `# Project\n${notes ? `\n${notes}\n` : ""}\n## Repository files\n${shown.join("\n") || "(empty repository)"}${more}`;
}

/** Everything appended to the agent CLI's own system prompt. */
export function systemPrompt(paths: ProjectPaths, role: Role, agentRunId: string, skills: Skill[], requested: string[], context: string): string {
  return [loadRolePrompt(paths, role), protocolInstructions(role, agentRunId), skillsBlock(skills, role, requested), context]
    .filter(Boolean)
    .join("\n\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function taskCard(task: Task, specs: Spec[], notes: string): string {
  const reqs = specs.flatMap((s) => s.requirements).filter((r) => task.requirements.includes(r.id));
  const acs = reqs.flatMap((r) => r.acceptance.filter((a) => task.acceptance.includes(a.id)).map((a) => ({ req: r.id, ...a })));
  const parts = [
    `<task id="${task.id}" role="${task.role}">`,
    `  <title>${esc(task.title)}</title>`,
    task.description ? `  <description>${esc(task.description)}</description>` : "",
    reqs.length ? "  <requirements>" : "",
    ...reqs.map((r) => `    <req id="${r.id}" title="${esc(r.title)}">\n${esc(r.body)}\n    </req>`),
    reqs.length ? "  </requirements>" : "",
    "  <acceptance>",
    ...(acs.length ? acs.map((a) => `    <ac id="${a.id}" req="${a.req}">${esc(a.text)}</ac>`) : task.acceptance.map((a) => `    <ac id="${a}"/>`)),
    "  </acceptance>",
    `  <scope write="${esc(task.files.write.join(", "))}"${task.files.read.length ? ` read="${esc(task.files.read.join(", "))}"` : ""}/>`,
    "  <definition_of_done>",
    ...task.definition_of_done.map((d) => `    <check>${esc(d)}</check>`),
    ...task.verify.map((v) => `    <verify_cmd>${esc(v)}</verify_cmd>`),
    "  </definition_of_done>",
    notes.trim() ? `  <notes_from_other_agents>\n${esc(notes.trim())}\n  </notes_from_other_agents>` : "",
    "</task>",
    "",
    `Complete task ${task.id} in this worktree. Change only files in the write scope. Run the verify commands yourself, then finish with \`hexagon done\`.`,
  ];
  return parts.filter((l) => l !== "").join("\n");
}
