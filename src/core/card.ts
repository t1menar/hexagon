import type { Plan, Task } from "../contracts/types.js";
import { contractSmells, isTrivialVerify, ordered, overlaps } from "./plan.js";
import type { Spec } from "./spec.js";

/**
 * What the human reads at an approval gate: a few lines, not the document. The documents stay the source of truth;
 * the card says what will change, how it will be verified, and what looks wrong, and points at the files.
 */
export interface Card {
  /** At most five bullets: what will change. */
  changes: string[];
  /** At most five bullets: how it will be verified. */
  verify: string[];
  /** Plan smells the human should see before saying yes. */
  smells: string[];
  /** Full documents to read. */
  files: string[];
}

const cap = (xs: string[], n = 5): string[] => (xs.length <= n ? xs : [...xs.slice(0, n - 1), `… and ${xs.length - n + 1} more`]);
const one = (s: string, n = 90): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The spec gate: requirements as changes, acceptance criteria as the way they will be verified. */
export function specCard(spec: Spec, files: string[]): Card {
  return {
    changes: cap(spec.requirements.map((r) => `${r.id}: ${one(r.title)}`)),
    verify: cap(spec.requirements.flatMap((r) => r.acceptance.map((a) => `${r.id}/${a.id}: ${one(a.text)}`))),
    smells: spec.requirements.filter((r) => !r.acceptance.length).map((r) => `${r.id} has no acceptance criteria: nothing could verify it`),
    files,
  };
}

/** The plan gate: tasks as changes, verify commands as the check, and the smells a reader would miss in plan.json. */
export function planCard(plan: Plan, files: string[]): Card {
  const smells: string[] = [];
  for (const t of plan.tasks) {
    if (!t.verify.length) smells.push(`${t.id} has no verify command (${t.verify_exempt ? `exempt: ${one(t.verify_exempt, 50)}` : "nothing independent checks it"})`);
    else if (t.verify.every(isTrivialVerify)) smells.push(`${t.id} verify passes whatever the code does`);
    if (!t.requirements.length) smells.push(`${t.id} cites no requirement: the spec does not cover it`);
  }
  for (let i = 0; i < plan.tasks.length; i++) {
    for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i]!, b = plan.tasks[j]!;
      if (!ordered(plan.tasks, a.id, b.id) && overlaps(a.files.write, b.files.write)) smells.push(`${a.id} and ${b.id} run in parallel but both write ${a.files.write.filter((x) => overlaps([x], b.files.write)).join(", ")}`);
    }
  }
  smells.push(...contractSmells(plan));
  const verify = [...new Set(plan.tasks.flatMap((t) => t.verify))];
  return {
    changes: cap(plan.tasks.map((t) => `${t.id}: ${one(t.title)}${t.files.write[0] === "**" ? " (whole repository)" : ` → ${cap(t.files.write, 3).join(", ")}`}`)),
    verify: cap(verify.length ? verify : ["no verify commands in this plan"]),
    smells: cap(smells, 8),
    files,
  };
}

/** Plain text for terminals and notices. */
export function formatCard(c: Card, heading: string): string {
  const list = (title: string, xs: string[]) => (xs.length ? [`${title}`, ...xs.map((x) => `  • ${x}`)] : []);
  return [heading, ...list("What will change", c.changes), ...list("How we verify", c.verify), ...list("Look twice", c.smells.map((s) => `! ${s}`)), ...list("Read in full", c.files)].join("\n");
}
