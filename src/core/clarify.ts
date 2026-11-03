import fs from "node:fs";
import path from "node:path";

/**
 * The clarify stage: after the analyst has read the repository and before anything is specified, the user answers the
 * questions that change the outcome (scope, design, irreversible effects, where the result is delivered). The analyst
 * writes `questions.json`; Hexagon holds the pipeline until every question has an answer (or the user accepts the
 * defaults), writes `answers.md`, and feeds it to the specify stage.
 */
export type AskLevel = "minimal" | "normal" | "thorough";
export const ASK_LEVELS: readonly AskLevel[] = ["minimal", "normal", "thorough"];
export type Confidence = "low" | "medium" | "high";

/** Topics Hexagon understands. `delivery.*` answers are persisted in `[delivery]`; `design` picks one of Approaches. */
export const DELIVERY_TOPICS = ["delivery.push", "delivery.remote", "delivery.pr", "delivery.branch", "delivery.merge"] as const;

export interface Question {
  id: string;
  question: string;
  why_it_matters: string;
  options: string[];
  default: string;
  blocking: boolean;
  /** `delivery.*`, `design`, or free (scope, data, api, …). */
  topic?: string;
}

export interface Answer { id: string; answer: string; by: "user" | "default" }

export interface Delivery { remote: string; push: boolean | null; pr: boolean | null }

const NONE = /^\s*(?:[-*]\s*)?(?:none|n\/a|nothing|no open questions?)\W*$/i;

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

export function parseConfidence(analysis: string): Confidence | null {
  const body = sections(analysis).get("confidence");
  const m = body ? /\b(low|medium|high)\b/i.exec(body) : null;
  return m ? (m[1]!.toLowerCase() as Confidence) : null;
}

/** `- A-1: option` lines under the Approaches section. Fewer than two means there is nothing to choose between. */
export function parseApproaches(analysis: string): { id: string; text: string }[] {
  const body = sections(analysis).get("approaches") ?? "";
  return [...body.matchAll(/^\s*[-*]\s*(A-\d+)\s*[:.\-]\s*(.+)$/gim)].map((m) => ({ id: m[1]!.toUpperCase(), text: m[2]!.trim() }));
}

export const openQuestionsEmpty = (analysis: string): boolean => {
  const body = (sections(analysis).get("open questions") ?? "").trim();
  return body === "" || body.split("\n").every((l) => !l.trim() || NONE.test(l));
};

/** The analysis itself states where the result goes (a `## Delivery` section), or the project already answered it. */
export const analysisStatesDelivery = (analysis: string): boolean => {
  const body = (sections(analysis).get("delivery") ?? "").trim();
  return body !== "" && !NONE.test(body);
};

export function deliveryKnown(d: Delivery, ask: AskLevel, analysis = ""): boolean {
  return ask === "minimal" || d.push !== null || analysisStatesDelivery(analysis);
}

export interface ClarifyContext { ask: AskLevel; delivery: Delivery }

/** Does this analysis need the user before a spec can be written? One reason per line, empty = it can go on. */
export function needsQuestions(analysis: string, ctx: ClarifyContext): string[] {
  const why: string[] = [];
  const conf = parseConfidence(analysis);
  if (conf === "low") why.push("confidence is low");
  if (!openQuestionsEmpty(analysis)) why.push("Open questions lists unresolved items");
  if (!deliveryKnown(ctx.delivery, ctx.ask, analysis)) why.push("the delivery target (repository, branch, push, who merges) is unknown");
  if (parseApproaches(analysis).length > 1) why.push("more than one viable approach: the user picks the design before the spec");
  if (ctx.ask === "thorough" && conf !== "high") why.push(`ask = thorough and confidence is ${conf ?? "unstated"}`);
  return why;
}

/** analysis.md rules that belong to the clarify stage (checked in addition to the section list). */
export function checkClarifyAnalysis(analysis: string, ctx: ClarifyContext, dir: string): string[] {
  const errors: string[] = [];
  const conf = parseConfidence(analysis);
  if (!conf) errors.push(`analysis.md has no "Confidence" section: write low, medium or high and why`);
  const none = openQuestionsEmpty(analysis);
  if (none && conf !== "high") errors.push(`"Open questions: none" is only allowed with Confidence: high${conf ? ` (yours is ${conf})` : ""}. Write the questions to questions.json instead`);
  if (none && !deliveryKnown(ctx.delivery, ctx.ask, analysis)) errors.push(`"Open questions: none" is only allowed when the delivery target is known. Ask about it in questions.json (topic "delivery.push", …), or state it in a "Delivery" section if the request or config already answers it`);
  const why = needsQuestions(analysis, ctx);
  const file = path.join(dir, "questions.json");
  if (why.length && !fs.existsSync(file)) errors.push(`questions.json is required (${why.join("; ")}). Write 3-7 questions: [{id:"Q-1", question, why_it_matters, options:[…], default, blocking, topic?}]`);
  if (fs.existsSync(file)) {
    const r = loadQuestions(file);
    errors.push(...r.errors);
    if (!r.errors.length) errors.push(...checkQuestionSet(r.questions, analysis, ctx));
  }
  return errors;
}

export function loadQuestions(file: string): { questions: Question[]; errors: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return { questions: [], errors: [`questions.json is not valid JSON: ${(e as Error).message}`] }; }
  const list = Array.isArray(raw) ? raw : (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list)) return { questions: [], errors: ["questions.json must be an array of questions"] };
  const errors: string[] = [];
  const out: Question[] = [];
  const seen = new Set<string>();
  list.forEach((q: Record<string, unknown>, i) => {
    const at = `questions.json[${i}]`;
    const bad: string[] = [];
    const id = typeof q?.id === "string" ? q.id.toUpperCase() : "";
    if (!/^Q-\d+$/.test(id)) bad.push(`${at}.id must look like Q-1`);
    else if (seen.has(id)) bad.push(`${at}.id ${id} is used twice`);
    seen.add(id);
    for (const k of ["question", "why_it_matters", "default"] as const) if (typeof q?.[k] !== "string" || !(q[k] as string).trim()) bad.push(`${at}.${k} must be a non-empty string`);
    if (!Array.isArray(q?.options) || !q.options.every((o) => typeof o === "string")) bad.push(`${at}.options must be an array of strings (empty = free text)`);
    if (typeof q?.blocking !== "boolean") bad.push(`${at}.blocking must be true or false`);
    if (q?.topic !== undefined && typeof q.topic !== "string") bad.push(`${at}.topic must be a string`);
    if (bad.length) { errors.push(...bad); return; }
    out.push({ id, question: String(q.question).trim(), why_it_matters: String(q.why_it_matters).trim(), options: (q.options as string[]).map((o) => o.trim()), default: String(q.default).trim(), blocking: q.blocking as boolean, topic: typeof q.topic === "string" ? q.topic : undefined });
  });
  return { questions: out, errors };
}

/** Count, delivery and design coverage of a well-formed question list. */
export function checkQuestionSet(qs: Question[], analysis: string, ctx: ClarifyContext): string[] {
  const errors: string[] = [];
  if (qs.length < 1 || qs.length > 7) errors.push(`questions.json has ${qs.length} questions; ask 3-7 (fewer only when ask = minimal)`);
  else if (qs.length < 3 && ctx.ask !== "minimal") errors.push(`questions.json has ${qs.length} question(s); ask 3-7, or lower [sdd].ask to minimal`);
  for (const q of qs) if (q.options.length && !q.options.some((o) => sameAnswer(o, q.default))) errors.push(`${q.id}: default "${q.default}" is not one of its options`);
  if (!deliveryKnown(ctx.delivery, ctx.ask, analysis) && !qs.some((q) => q.topic === "delivery.push")) {
    errors.push(`the delivery target is unknown, so questions.json needs a question with topic "delivery.push" (push yes/no; also target repo/dir, base branch, work branch or PR, remote, who merges as delivery.remote / delivery.branch / delivery.pr / delivery.merge)`);
  }
  if (parseApproaches(analysis).length > 1 && !qs.some((q) => q.topic === "design")) errors.push(`analysis.md lists several Approaches, so questions.json needs a question with topic "design" whose options are those approaches`);
  return errors;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
export const sameAnswer = (a: string, b: string): boolean => norm(a) === norm(b);

/** What the user typed → the answer to record: an option number picks that option, "default" picks the default. */
export function resolveAnswer(q: Question, text: string): string {
  const t = text.trim();
  if (!t) throw new Error(`${q.id}: an answer is needed (or "default")`);
  if (/^default$/i.test(t)) return q.default;
  const n = /^#?(\d+)$/.exec(t);
  if (n && q.options.length) {
    const o = q.options[Number(n[1]) - 1];
    if (!o) throw new Error(`${q.id}: there are only ${q.options.length} options`);
    return o;
  }
  const exact = q.options.find((o) => sameAnswer(o, t));
  return exact ?? t;
}

/** Remove delivery questions the project has already answered (never ask the same delivery question twice). */
export function dropAnswered(qs: Question[], d: Delivery): Question[] {
  return qs.filter((q) => {
    if (d.push !== null && q.topic === "delivery.push") return false;
    if (d.push !== null && q.topic === "delivery.remote" && d.remote) return false;
    if (d.push !== null && d.pr !== null && q.topic === "delivery.pr") return false;
    return true;
  });
}

const yes = (s: string) => /^(?:y|yes|true|push|open)\b/i.test(s.trim());
const no = (s: string) => /^(?:n|no|false|don'?t|do not|never|local)\b/i.test(s.trim());

/** Delivery settings implied by the answers (only what was asked; the rest stays as it was). */
export function deliveryFromAnswers(qs: Question[], answers: Answer[]): Partial<Delivery> {
  const out: Partial<Delivery> = {};
  for (const a of answers) {
    const q = qs.find((x) => x.id === a.id);
    if (!q) continue;
    if (q.topic === "delivery.push") { if (yes(a.answer)) out.push = true; else if (no(a.answer)) out.push = false; }
    if (q.topic === "delivery.pr") { if (yes(a.answer)) out.pr = true; else if (no(a.answer)) out.pr = false; }
    if (q.topic === "delivery.remote" && /^[\w.-]+$/.test(a.answer.trim())) out.remote = a.answer.trim();
  }
  if (out.push === false && out.pr === undefined) out.pr = false;
  return out;
}

/** answers.md: what the specify stage reads. Defaults are marked, so a spec can tell a decision from a shrug. */
export function renderAnswers(qs: Question[], answers: Answer[]): string {
  const lines = ["# Answers", "", "These are the user's decisions. Treat them as requirements; an answer marked (default) was not chosen by the user.", ""];
  for (const q of qs) {
    const a = answers.find((x) => x.id === q.id);
    lines.push(`## ${q.id}${q.topic ? ` [${q.topic}]` : ""}: ${q.question}`, `Answer: ${a?.answer ?? q.default}${a?.by === "default" ? " (default)" : ""}`, "");
  }
  return lines.join("\n");
}

export const unanswered = (qs: Question[], answers: Answer[]): Question[] => qs.filter((q) => !answers.some((a) => a.id === q.id));
