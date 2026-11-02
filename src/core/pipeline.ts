import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Task } from "../contracts/types.js";
import { atomicWriteJson, nowIso, readJson } from "../util/fsx.js";
import { lintSpec, parseSpec, type Spec } from "./spec.js";

/**
 * Spec-driven development as gated stages. Each stage is an agent turn that produces a file; the next stage starts
 * only when that file validates. The spec additionally needs the user's approval before a plan is derived from it,
 * and no task that cites requirements runs unless the approved spec still matches the file on disk.
 */
export type Stage = "analyze" | "specify" | "plan" | "replan";
export const STAGES: readonly Stage[] = ["analyze", "specify", "plan"];

export const ARTIFACT: Record<Stage, string> = { analyze: "analysis.md", specify: "spec.md", plan: "plan.json", replan: "replan.json" };

const ANALYSIS_SECTIONS = ["current state", "constraints", "risks", "open questions", "impacted areas"];
const DESIGN_SECTIONS = ["interfaces", "data flow", "trade-offs"];

function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1]!.toLowerCase().replace(/[:.]+$/, ""); out.set(cur, ""); continue; }
    if (cur) out.set(cur, `${out.get(cur)}${line}\n`);
  }
  return out;
}

function missingSections(text: string, required: string[], file: string): string[] {
  const have = sections(text);
  const errors: string[] = [];
  for (const r of required) {
    const key = [...have.keys()].find((k) => k.includes(r));
    if (!key) errors.push(`${file} has no "${r}" section`);
    else if (!have.get(key)!.trim()) errors.push(`${file} section "${r}" is empty (write "none" if there is nothing)`);
  }
  return errors;
}

/**
 * How much machinery a request deserves.
 *  solo        one small, well-understood edit: just ask the assistant.
 *  single-task one agent, one worktree, no file masks, but the full checks (verify, mutation evidence, review, integrity).
 *  dag         several independent slices that really run in parallel.
 */
export type Mode = "solo" | "single-task" | "dag";
export const MODES: readonly Mode[] = ["solo", "single-task", "dag"];

/** The mode the analyst wrote under `## Mode` (first word of the section), if any. */
export function parseMode(analysis: string): { mode: Mode; reason: string } | null {
  const body = sections(analysis).get("mode");
  const m = body ? /\b(solo|single-task|single task|dag)\b/i.exec(body) : null;
  if (!m) return null;
  const mode = m[1]!.toLowerCase().replace(" ", "-") as Mode;
  return { mode, reason: body!.replace(m[0], "").replace(/^[\s:\-—,.]+/, "").trim() };
}

/**
 * Heuristic used when the analyst did not choose. It reads what analysis.md already says: how many modules the change
 * touches, whether it names independent slices, and whether the cause is known. Small or unclear work gets
 * single-task (one agent with every check); only clearly parallel work gets a graph.
 */
export function recommendMode(analysis: string): { mode: Mode; reason: string } {
  const s = sections(analysis);
  const impacted = s.get("impacted areas") ?? "";
  const paths = [...new Set([...impacted.matchAll(/[\w.-]+(?:\/[\w.*-]+)+/g)].map((m) => m[0]))];
  const modules = new Set(paths.map((p) => p.split("/").slice(0, 2).join("/")));
  const slices = (impacted.match(/\bindependent(?:ly)?\b|\bin parallel\b|\bseparate (?:module|service|package|slice)/gi) ?? []).length;
  const knownCause = /\broot cause\b|\bthe (?:bug|defect|problem) is\b/i.test(s.get("current state") ?? "");
  if (paths.length <= 1 && knownCause) return { mode: "solo", reason: `one file${paths[0] ? ` (${paths[0]})` : ""} and a known cause` };
  if (modules.size >= 3 && slices >= 2) return { mode: "dag", reason: `${modules.size} modules with ${slices} independent slices` };
  return { mode: "single-task", reason: modules.size ? `${modules.size} module(s), ${slices} independent slice(s): one agent with full checks is enough` : "scope unclear: one agent with full checks is the safe default" };
}

export const checkAnalysis = (text: string): string[] => missingSections(text, ANALYSIS_SECTIONS, "analysis.md");
export const checkDesign = (text: string): string[] => missingSections(text, DESIGN_SECTIONS, "design.md");

/** Validate the artifact of a stage that is not the plan (the plan is checked by plan-check with its coverage rules). */
export function checkStage(stage: "analyze" | "specify" | "replan", dir: string, projectFiles?: string[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const file = path.join(dir, ARTIFACT[stage]);
  if (!fs.existsSync(file)) return { errors: [`missing ${ARTIFACT[stage]} in ${dir}`], warnings };
  const text = fs.readFileSync(file, "utf8");
  if (stage === "analyze") return { errors: checkAnalysis(text), warnings };
  const spec = parseSpec(file, text);
  for (const i of lintSpec(spec, projectFiles)) (i.level === "error" ? errors : warnings).push(`spec.md:${i.line} ${i.message}`);
  const design = path.join(dir, "design.md");
  if (fs.existsSync(design)) errors.push(...checkDesign(fs.readFileSync(design, "utf8")));
  return { errors, warnings };
}

// ───────────── approvals ─────────────

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Hash of what a requirement asks for: title, text and acceptance criteria. */
export function reqHash(r: Spec["requirements"][number]): string {
  return sha(JSON.stringify([r.title, r.body, r.acceptance.map((a) => [a.id, a.text])]));
}
export const specHash = (raw: string): string => sha(raw);

export interface Approval { hash: string; requirements: Record<string, string>; approved_at: string; by: string }

export interface GateResult {
  ok: boolean;
  /** One line per problem, ready to show. */
  problems: string[];
  /** Requirements whose text changed since approval. */
  changed: string[];
}

/** A task that cites no requirement is outside what the spec covers; the user has to say it may run. */
export const taskHash = (t: Pick<Task, "title" | "description" | "files" | "acceptance" | "verify">): string =>
  sha(JSON.stringify([t.title, t.description ?? "", t.files.write, t.acceptance, t.verify]));

export const isUntraced = (t: Pick<Task, "requirements">, specPaths: string[]): boolean => specPaths.length > 0 && t.requirements.length === 0;

/** .hexagon/approvals.json: spec file (project-relative) → what the user approved. */
export class Approvals {
  constructor(private file: string, private root: string) {}

  private load(): Record<string, Approval> {
    return readJson<Record<string, Approval>>(this.file) ?? {};
  }

  private rel(specPath: string): string {
    return path.relative(this.root, path.resolve(this.root, specPath)).split(path.sep).join("/");
  }

  get(specPath: string): Approval | undefined {
    return this.load()[this.rel(specPath)];
  }

  /** The user approves the spec exactly as it is on disk now. Only a spec that lints clean can be approved. */
  approve(specPath: string, by = "user"): Approval {
    const abs = path.resolve(this.root, specPath);
    const spec = parseSpec(abs);
    const errors = lintSpec(spec).filter((i) => i.level === "error");
    if (errors.length) throw new Error(`the spec has errors, fix them first: ${errors.map((e) => `line ${e.line} ${e.message}`).join("; ")}`);
    const a: Approval = { hash: specHash(spec.raw), requirements: Object.fromEntries(spec.requirements.map((r) => [r.id, reqHash(r)])), approved_at: nowIso(), by };
    const all = this.load();
    all[this.rel(specPath)] = a;
    atomicWriteJson(this.file, all);
    return a;
  }

  /** The user lets a task run that the spec does not cover. Content-addressed: changing the task voids it. */
  approveTask(task: Pick<Task, "id" | "title" | "description" | "files" | "acceptance" | "verify">, by = "user"): void {
    const all = this.load() as Record<string, unknown>;
    const tasks = (all["@tasks"] ?? {}) as Record<string, { task: string; approved_at: string; by: string }>;
    tasks[taskHash(task)] = { task: task.id, approved_at: nowIso(), by };
    all["@tasks"] = tasks;
    atomicWriteJson(this.file, all);
  }

  private taskApproved(task: Pick<Task, "title" | "description" | "files" | "acceptance" | "verify">): boolean {
    const tasks = ((this.load() as Record<string, unknown>)["@tasks"] ?? {}) as Record<string, unknown>;
    return taskHash(task) in tasks;
  }

  /** Is this task allowed to start? A task that cites no requirement needs the user's recorded approval. */
  check(task: Pick<Task, "id" | "requirements" | "title" | "description" | "files" | "acceptance" | "verify">, specPaths: string[]): GateResult {
    if (!task.requirements.length) {
      if (isUntraced(task, specPaths) && !this.taskApproved(task)) {
        return { ok: false, problems: [`${task.id} cites no requirement, so the approved spec does not cover it, and it has not been approved to run outside the spec`], changed: [] };
      }
      return { ok: true, problems: [], changed: [] };
    }
    const problems: string[] = [];
    const changed: string[] = [];
    const specs: { rel: string; spec: Spec }[] = [];
    for (const p of specPaths) {
      try { specs.push({ rel: this.rel(p), spec: parseSpec(path.resolve(this.root, p)) }); } catch (e) { problems.push(`${p} cannot be read: ${(e as Error).message}`); }
    }
    for (const req of task.requirements) {
      const found = specs.find((s) => s.spec.requirements.some((r) => r.id === req));
      if (!found) { problems.push(`${task.id} cites ${req}, which is in no spec of this plan`); continue; }
      const a = this.load()[found.rel] as Approval | undefined;
      if (!a) { problems.push(`${found.rel} is not approved (hexagon approve-spec ${found.rel})`); continue; }
      const r = found.spec.requirements.find((x) => x.id === req)!;
      if (a.requirements[req] === undefined) { problems.push(`${req} was added after the approval of ${found.rel}`); changed.push(req); }
      else if (a.requirements[req] !== reqHash(r)) { problems.push(`${req} changed after the approval of ${found.rel}`); changed.push(req); }
      const errs = lintSpec(found.spec).filter((i) => i.level === "error");
      if (errs.length) problems.push(`${found.rel} no longer validates: ${errs[0]!.message}`);
    }
    return { ok: problems.length === 0, problems: [...new Set(problems)], changed: [...new Set(changed)] };
  }
}
