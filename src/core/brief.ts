import fs from "node:fs";
import path from "node:path";
import type { Role, Task } from "../contracts/types.js";
import { atomicWriteJson } from "../util/fsx.js";

/**
 * The per-task brief: before an implementing agent edits product files it writes down what it will do, in its own
 * context, where it can be checked, reviewed and — after a retry or a reset — read again instead of rediscovered.
 *
 *   .hexagon/runs/<run>/tasks/<T-n>/brief.md      the brief (a living log: Progress / Found are appended)
 *   .hexagon/runs/<run>/tasks/<T-n>/compact.md    the agent's own summary from the last compaction
 *   .hexagon/runs/<run>/tasks/<T-n>/failure.md    the last thing that sent the work back (verify output, review findings)
 *
 * Agents reach it through `hexagon brief …` (they cannot write outside their worktree); the daemon owns the files.
 */
export type BriefMode = "required" | "optional" | "off";
export const BRIEF_MODES: readonly BriefMode[] = ["required", "optional", "off"];
export type BriefReview = "off" | "auto" | "user";
export const BRIEF_REVIEWS: readonly BriefReview[] = ["off", "auto", "user"];

/** Roles that change product files; the others (reviewer, analyst, release …) have nothing to brief. */
export const BRIEF_ROLES: readonly Role[] = ["developer", "qa", "devops", "security"];

export const taskDir = (runDir: string, taskId: string): string => path.join(runDir, "tasks", taskId);
export const briefFile = (runDir: string, taskId: string): string => path.join(taskDir(runDir, taskId), "brief.md");
export const compactFile = (runDir: string, taskId: string): string => path.join(taskDir(runDir, taskId), "compact.md");
export const failureFile = (runDir: string, taskId: string): string => path.join(taskDir(runDir, taskId), "failure.md");

export const briefApplies = (mode: BriefMode, role: Role): boolean => mode !== "off" && BRIEF_ROLES.includes(role);

function sections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    const h = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1]!.toLowerCase().replace(/[:.]+$/, ""); out.set(cur, out.get(cur) ?? ""); continue; }
    if (cur) out.set(cur, `${out.get(cur)}${line}\n`);
  }
  return out;
}

const find = (s: Map<string, string>, key: string): string | undefined => {
  const k = [...s.keys()].find((x) => x.includes(key));
  return k === undefined ? undefined : s.get(k);
};

/** Acceptance ids of the task that the Verification section must mention (bare AC-n only when it is unambiguous). */
function acRefs(task: Pick<Task, "acceptance">, verification: string): string[] {
  const missing: string[] = [];
  for (const id of task.acceptance) {
    const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    const unique = task.acceptance.filter((x) => (x.includes("/") ? x.slice(x.indexOf("/") + 1) : x) === bare).length === 1;
    const re = new RegExp(`(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w-])`);
    const reBare = new RegExp(`(^|[^\\w/-])${bare}(?![\\w-])`);
    if (!re.test(verification) && !(unique && reBare.test(verification))) missing.push(id);
  }
  return missing;
}

/** What a skeleton looks like; shown whenever a check fails, so the fix is one edit away. */
export function briefTemplate(task: Pick<Task, "id" | "title" | "acceptance">): string {
  return [
    `# Brief ${task.id}: ${task.title}`,
    "## Goal", "<1-2 lines: what will be true when this is done>",
    "## Files to change", "- path/to/file.ext:LINE — what changes there   (new files: `path (new)`)",
    "## Approach", "<the steps, in order>",
    "## Decisions and assumptions", "- <what you decided or assumed, and why>",
    "## Risks", "- <what could go wrong, and how you will notice>",
    "## Verification", ...(task.acceptance.length ? task.acceptance.map((a) => `- ${a}: <command or test that proves it>`) : ["- <command or test that proves the task is done>"]),
    "## Progress", "## Found", "",
  ].join("\n");
}

/** Errors that stop a brief from counting, each with what to do about it. Empty = valid. */
export function checkBrief(text: string, task: Pick<Task, "id" | "title" | "acceptance">): string[] {
  const s = sections(text);
  const errors: string[] = [];
  const need = (key: string, label: string): string | undefined => {
    const body = find(s, key);
    if (body === undefined) { errors.push(`no "${label}" section`); return undefined; }
    if (!body.trim() || /^<[^>]*>$/.test(body.trim())) { errors.push(`section "${label}" is empty`); return undefined; }
    return body;
  };
  const goal = need("goal", "Goal");
  if (goal && goal.trim().split("\n").filter((l) => l.trim()).length > 4) errors.push(`"Goal" is ${goal.trim().split("\n").length} lines; keep it to 1-2`);
  const files = need("files to change", "Files to change");
  if (files && !/[\w./-]+\.\w+:\d+|[\w./-]+\s*\(new\)/.test(files)) errors.push(`"Files to change" has no file:line anchor (e.g. src/a.ts:42) and no "(new)" file; name where the change goes`);
  need("approach", "Approach");
  need("decision", "Decisions and assumptions");
  need("risk", "Risks");
  const ver = need("verification", "Verification");
  if (ver && task.acceptance.length) {
    const missing = acRefs(task, ver);
    if (missing.length) errors.push(`"Verification" does not map ${missing.join(", ")} to a command or test`);
  }
  return errors;
}

/** Reply text for a failed check: the errors, then what a valid brief looks like. */
export function explainBrief(errors: string[], task: Pick<Task, "id" | "title" | "acceptance">): string {
  return `The brief is not valid yet:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nWrite the whole file again with \`hexagon brief write\` (text on stdin). Skeleton:\n${briefTemplate(task)}`;
}

export type LogKind = "progress" | "found";

/** Add one dated line to the Progress or Found section (created if missing). */
export function appendEntry(text: string, kind: LogKind, entry: string, at: string): string {
  const title = kind === "progress" ? "Progress" : "Found";
  const line = `- ${at} ${entry.trim().replace(/\n+/g, " ")}`;
  const lines = text.replace(/\n+$/, "").split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^#{1,3}\\s+${title}\\s*$`, "i").test(l));
  if (idx < 0) return `${lines.join("\n")}\n\n## ${title}\n${line}\n`;
  let end = idx + 1;
  while (end < lines.length && !/^#{1,3}\s/.test(lines[end]!)) end++;
  while (end > idx + 1 && !lines[end - 1]!.trim()) end--;
  lines.splice(end, 0, line);
  return `${lines.join("\n")}\n`;
}

export const hasProgress = (text: string): boolean => /\S/.test(find(sections(text), "progress") ?? "");

/** The brief is read by the user before work starts when [run].brief_review says so (or the task looks risky). */
export function needsReview(mode: BriefReview, task: Pick<Task, "estimate" | "files">): boolean {
  if (mode === "off") return false;
  if (mode === "user") return true;
  const risky = /\b(high|risky|critical)\b/i.test(task.estimate?.risk ?? "");
  const iface = task.files.write.some((g) => /(^|\/)(api|apis|interfaces?|contracts?|schemas?|proto|openapi)(\/|\.|$)|\.d\.ts$|\.proto$|openapi/i.test(g));
  return risky || iface;
}

export function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Persist the compaction summary of a task, so a new Supervisor (retry, restart, session reset) still has it. */
export function saveCompact(runDir: string, taskId: string, summary: string): void {
  writeText(compactFile(runDir, taskId), summary);
}
export const loadCompact = (runDir: string, taskId: string): string => readText(compactFile(runDir, taskId));
export function saveFailure(runDir: string, taskId: string, text: string): void {
  writeText(failureFile(runDir, taskId), text);
}
export const loadFailure = (runDir: string, taskId: string): string => readText(failureFile(runDir, taskId));

const cap = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.floor(n * 0.6))}\n… (${s.length - n} chars cut) …\n${s.slice(-Math.floor(n * 0.4))}`);

/**
 * What a fresh session or attempt receives instead of rediscovering the repository: the brief, the agent's own
 * summary, the current diffstat and the last failure. Empty when there is nothing to carry.
 */
export function recoveryBlock(p: { taskId: string; brief: string; summary: string; diffstat: string; failure: string }): string {
  const parts = [
    p.brief.trim() ? `<brief file="hexagon brief show">\n${cap(p.brief.trim(), 6000)}\n</brief>` : "",
    p.summary.trim() ? `<your_summary note="written by you before the earlier session was compacted">\n${cap(p.summary.trim(), 4000)}\n</your_summary>` : "",
    p.diffstat.trim() ? `<current_changes note="git diff --stat of this worktree against the base">\n${cap(p.diffstat.trim(), 1500)}\n</current_changes>` : "",
    p.failure.trim() ? `<last_failure>\n${cap(p.failure.trim(), 3000)}\n</last_failure>` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  return `<resume task="${p.taskId}">\nYou are continuing earlier work on this task. Read your brief first; do not rediscover the repository. The files named in the brief are where the work is.\n${parts.join("\n")}\n</resume>`;
}

export const READ_BRIEF_FIRST = "Read your brief first (`hexagon brief show`), then ";

/** Marker file: the user approved this brief (brief_review). */
export const reviewFile = (runDir: string, taskId: string): string => path.join(taskDir(runDir, taskId), "brief.review.json");
export function saveReview(runDir: string, taskId: string, state: { approved: boolean; at: string }): void {
  fs.mkdirSync(taskDir(runDir, taskId), { recursive: true });
  atomicWriteJson(reviewFile(runDir, taskId), state);
}
