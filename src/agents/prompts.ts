import { createHash } from "node:crypto";
import fs from "node:fs";
import { SHIPPED_ROLE_HASHES } from "./known-roles.js";
import { canonicalRole, legacyNames } from "../core/roles.js";
import path from "node:path";
import type { Role, Task } from "../contracts/types.js";
import type { ProjectPaths } from "../core/project.js";
import { listProjectFiles, type Spec } from "../core/spec.js";
import { hasResource, listResources, readResource } from "../util/resources.js";
import { protocolInstructions } from "./protocol.js";

export interface Skill { name: string; version: string; appliesTo: string[]; body: string }

/** Role prompts written for the v0.1 API tools (submit_result etc.) don't work with CLI agents. */
export const isStaleRolePrompt = (text: string) =>
  /\b(submit_result|submit_review|submit_plan|report_status|ask_user)\b/.test(text) || SHIPPED_ROLE_HASHES.has(roleHash(text));

/** Same hash as scripts/role-hashes.mjs. A project copy is "stale" if it is an unedited, shipped version. */
export const roleHash = (text: string) => createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);

export function loadRolePrompt(paths: ProjectPaths, role: Role, custom?: { prompt?: string }): string {
  if (custom?.prompt) {
    for (const f of [path.join(paths.roles, custom.prompt), path.resolve(paths.root, custom.prompt)]) {
      if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
    }
    throw new Error(`[roles.${role}] prompt = "${custom.prompt}" was not found in .hexagon/roles/ or the project root`);
  }
  // A project copy under the current name, then under an old name (planner.md → analyst), unless it is an unedited shipped one.
  for (const name of [role, ...legacyNames(role)]) {
    const f = path.join(paths.roles, `${name}.md`);
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, "utf8").trim();
    if (!isStaleRolePrompt(text)) return text;
  }
  const packaged = `templates/roles/${role}.md`;
  if (hasResource(packaged)) return readResource(packaged).trim();
  throw new Error(`no role prompt for ${role}: add .hexagon/roles/${role}.md or set prompt = "<file>" under [roles.${role}]`);
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
      appliesTo: (meta.applies_to ?? "").replace(/[[\]]/g, "").split(",").map((s) => canonicalRole(s.trim())).filter(Boolean),
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

/** Max size of HEXAGON.md inside the prompt; the agent can read the file itself for the rest. */
const NOTES_BUDGET = 6000;

/**
 * Stable project context: HEXAGON.md (capped) and a short directory summary. The full file list is not sent:
 * agents have their own search tools, and 200 paths in every prompt is pure overhead.
 */
export function projectContext(root: string): string {
  const ctx = contextFile(root);
  let notes = ctx ? fs.readFileSync(ctx, "utf8").trim() : "";
  if (notes.length > NOTES_BUDGET) notes = `${notes.slice(0, NOTES_BUDGET)}\n… (HEXAGON.md continues; read ${path.basename(ctx!)} for the rest)`;
  const files = listProjectFiles(root, 5000);
  const dirs = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    const key = parts.length === 1 ? "." : parts.length === 2 ? `${parts[0]}/` : `${parts[0]}/${parts[1]}/`;
    dirs.set(key, (dirs.get(key) ?? 0) + 1);
  }
  const shown = [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 30).map(([d, n]) => `${d} (${n})`);
  const tree = files.length ? `${files.length >= 5000 ? "5000+" : files.length} files. Directories: ${shown.join(", ")}${dirs.size > 30 ? ", …" : ""}. Use your search tools (glob/grep) to find files.` : "(empty repository)";
  return `# Project\n${notes ? `\n${notes}\n` : ""}\n## Repository\n${tree}`;
}

/**
 * Everything appended to the agent CLI's own system prompt. Identity-level and byte-stable: no task ids, no
 * per-task skills, so the same agent always sends the same prefix (provider-side prompt caching) and keeps one session.
 */
export function systemPrompt(paths: ProjectPaths, role: Role, skills: Skill[], context: string, custom?: { prompt?: string; skills?: string[] }): string {
  return [identityPrompt(paths, role, skills, custom), context].filter(Boolean).join("\n\n");
}

/** The part of the system prompt that defines the agent. Its hash decides whether the session may be reused. */
export function identityPrompt(paths: ProjectPaths, role: Role, skills: Skill[], custom?: { prompt?: string; skills?: string[] }): string {
  return [loadRolePrompt(paths, role, custom), protocolInstructions(role), skillsBlock(skills, role, custom?.skills ?? [])].filter(Boolean).join("\n\n");
}

export const identityHash = (paths: ProjectPaths, role: Role, skills: Skill[], custom?: { prompt?: string; skills?: string[] }) => roleHash(identityPrompt(paths, role, skills, custom));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function taskCard(task: Task, specs: Spec[], notes: string, others: Task[] = []): string {
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
    others.length ? "  <other_tasks note=\"each owns its write scope; send defects there with hexagon return\">" : "",
    ...others.map((o) => `    <task id="${o.id}" role="${o.role}" owns="${esc(o.files.write.join(", "))}">${esc(o.title)}</task>`),
    others.length ? "  </other_tasks>" : "",
    notes.trim() ? `  <notes_from_other_agents>\n${esc(notes.trim())}\n  </notes_from_other_agents>` : "",
    "</task>",
    "",
    `Complete task ${task.id} in this worktree. Change only files in the write scope. Run the verify commands yourself, then finish with \`hexagon done\`.`,
  ];
  return parts.filter((l) => l !== "").join("\n");
}
