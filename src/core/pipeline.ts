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
export type Stage = "analyze" | "specify" | "plan";
export const STAGES: readonly Stage[] = ["analyze", "specify", "plan"];

export const ARTIFACT: Record<Stage, string> = { analyze: "analysis.md", specify: "spec.md", plan: "plan.json" };

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

export const checkAnalysis = (text: string): string[] => missingSections(text, ANALYSIS_SECTIONS, "analysis.md");
export const checkDesign = (text: string): string[] => missingSections(text, DESIGN_SECTIONS, "design.md");

/** Validate the artifact of a stage that is not the plan (the plan is checked by plan-check with its coverage rules). */
export function checkStage(stage: "analyze" | "specify", dir: string, projectFiles?: string[]): { errors: string[]; warnings: string[] } {
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

  /** Is this task allowed to start? Tasks that cite no requirement have nothing to approve. */
  check(task: Pick<Task, "id" | "requirements">, specPaths: string[]): GateResult {
    if (!task.requirements.length) return { ok: true, problems: [], changed: [] };
    const problems: string[] = [];
    const changed: string[] = [];
    const specs: { rel: string; spec: Spec }[] = [];
    for (const p of specPaths) {
      try { specs.push({ rel: this.rel(p), spec: parseSpec(path.resolve(this.root, p)) }); } catch (e) { problems.push(`${p} cannot be read: ${(e as Error).message}`); }
    }
    for (const req of task.requirements) {
      const found = specs.find((s) => s.spec.requirements.some((r) => r.id === req));
      if (!found) { problems.push(`${task.id} cites ${req}, which is in no spec of this plan`); continue; }
      const a = this.load()[found.rel];
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
