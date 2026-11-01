import { protocolInstructions } from "../agents/protocol.js";
import { roleHash } from "../agents/prompts.js";
import { SHIPPED_ROLE_HASHES } from "../agents/known-roles.js";
import { listResources, readResource } from "../util/resources.js";
import { BUILTIN_ROLES } from "./roles.js";

export interface LintFinding { level: "error" | "warning"; file: string; rule: string; message: string }

/** Vendor and model names have no place in shared prompts: any provider's agent must be able to follow them. */
const VENDORS = /\b(claude|anthropic|openai|chatgpt|gpt-?\d[\w.-]*|codex|gemini|grok|copilot|llama|mistral)\b/i;

export const BUDGET = { role: 2400, skill: 1400, identity: 9000 } as const;

interface Skill { file: string; meta: Record<string, string>; body: string; text: string }

function parseSkill(file: string, text: string): Skill {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  return { file, meta, body: (m?.[2] ?? text).trim(), text };
}

const norm = (l: string) => l.toLowerCase().replace(/[`*_>#-]/g, "").replace(/\s+/g, " ").trim();

/** Lint the prompts and skills Hexagon ships. Pure: reads the packaged templates only. */
export function lintPrompts(): LintFinding[] {
  const out: LintFinding[] = [];
  const add = (level: LintFinding["level"], file: string, rule: string, message: string) => out.push({ level, file, rule, message });
  const roleIds = new Set(BUILTIN_ROLES.map((r) => r.id));

  const roles = new Map<string, string>();
  for (const r of BUILTIN_ROLES) {
    const f = `templates/roles/${r.id}.md`;
    try { roles.set(r.id, readResource(f).trim()); } catch { add("error", f, "missing", `built-in role "${r.id}" has no prompt`); }
  }
  for (const f of listResources("templates/roles")) {
    if (!roleIds.has(f.replace(/\.md$/, ""))) add("warning", `templates/roles/${f}`, "unknown-role", "no built-in role has this name");
  }

  const skills: Skill[] = listResources("templates/skills").filter((f) => f.endsWith(".skill.md")).map((f) => parseSkill(`templates/skills/${f}`, readResource(`templates/skills/${f}`)));
  for (const s of skills) {
    const base = s.file.replace(/^.*\//, "").replace(/\.skill\.md$/, "");
    if (!s.meta.name) add("error", s.file, "frontmatter", "missing `name`");
    else if (s.meta.name !== base) add("error", s.file, "frontmatter", `name "${s.meta.name}" does not match the file name "${base}"`);
    if (!s.meta.version) add("error", s.file, "frontmatter", "missing `version`");
    if (!s.meta.summary) add("error", s.file, "frontmatter", "missing `summary`");
    const applies = (s.meta.applies_to ?? "").replace(/[[\]]/g, "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!applies.length) add("error", s.file, "frontmatter", "missing `applies_to`");
    for (const a of applies) if (!roleIds.has(a)) add("error", s.file, "frontmatter", `applies_to names unknown role "${a}"`);
    if (s.body.length > BUDGET.skill) add("error", s.file, "size", `${s.body.length} chars, budget ${BUDGET.skill}`);
  }

  for (const [id, text] of roles) {
    const f = `templates/roles/${id}.md`;
    if (text.length > BUDGET.role) add("error", f, "size", `${text.length} chars, budget ${BUDGET.role}`);
    if (!SHIPPED_ROLE_HASHES.has(roleHash(text))) add("error", f, "known-roles", "this text is missing from src/agents/known-roles.ts (run `node scripts/role-hashes.mjs`), so an unedited project copy would be mistaken for the user's own");
    if (!/hexagon (done|review)\b/.test(text) && id !== "control") add("error", f, "contract", "does not say how to finish (`hexagon done` / `hexagon review`)");
    // Roles whose prompt says "ask" or "blocked" need the escape hatch spelled out.
    if (id !== "control" && id !== "reviewer" && !/blocked|needs_spec_change/.test(text)) add("warning", f, "escape-hatch", "no instruction for when the task cannot be done");
  }

  const shared = [...roles.entries()].map(([id, t]) => ({ file: `templates/roles/${id}.md`, text: t })).concat(skills.map((s) => ({ file: s.file, text: s.body })));
  for (const s of shared) {
    const m = VENDORS.exec(s.text);
    if (m) add("error", s.file, "vendor", `names a vendor or model ("${m[0]}")`);
  }
  for (const r of BUILTIN_ROLES) {
    const m = VENDORS.exec(protocolInstructions(r.id));
    if (m) add("error", "src/agents/protocol.ts", "vendor", `the protocol text for ${r.id} names a vendor or model ("${m[0]}")`);
  }

  // The same long line in two files is a copy that will drift.
  const seen = new Map<string, string>();
  for (const s of shared) {
    for (const line of new Set(s.text.split("\n").map(norm).filter((l) => l.length >= 60))) {
      const prev = seen.get(line);
      if (prev && prev !== s.file) add("warning", s.file, "duplicate", `repeats a line from ${prev}: "${line.slice(0, 60)}…"`);
      else seen.set(line, s.file);
    }
  }

  // What one agent is told must not contradict itself: "always X" next to "never X".
  for (const r of BUILTIN_ROLES) {
    const text = [roles.get(r.id) ?? "", ...skills.filter((s) => (s.meta.applies_to ?? "").includes(r.id)).map((s) => s.body), protocolInstructions(r.id)].join("\n");
    if (text.length > BUDGET.identity) add("error", `role:${r.id}`, "size", `assembled prompt is ${text.length} chars, budget ${BUDGET.identity}`);
    const always = new Set<string>(), never = new Set<string>();
    for (const sentence of text.split(/[.\n;]/).map(norm)) {
      let m = /^(?:you )?(?:must )?always (.{8,})$/.exec(sentence);
      if (m) always.add(m[1]!);
      m = /^(?:you )?(?:must )?(?:never|do not|don't) (.{8,})$/.exec(sentence);
      if (m) never.add(m[1]!);
    }
    for (const x of always) if (never.has(x)) add("error", `role:${r.id}`, "contradiction", `says both "always ${x}" and "never ${x}"`);
  }
  return out;
}

export function formatLint(findings: LintFinding[]): string {
  if (!findings.length) return "prompts: no problems";
  return findings.map((f) => `${f.level === "error" ? "✖" : "!"} ${f.file}  [${f.rule}] ${f.message}`).join("\n");
}
