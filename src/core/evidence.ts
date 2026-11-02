import fs from "node:fs";
import path from "node:path";
import type { ResultEnvelope } from "../contracts/types.js";
import { confinePath } from "../util/fsx.js";

type Evidence = ResultEnvelope["acceptance_evidence"][number];

/** `AC-1: test:src/a.test.ts::adds two numbers` → { ac, evidence }. The AC may be qualified (`REQ-X/AC-1`). */
export function parseEvidenceFlag(flag: string): { ac: string; evidence: string } {
  const m = /^\s*((?:[A-Za-z0-9_-]+\/)?AC-\d+)\s*[:=]\s*([\s\S]*)$/i.exec(flag);
  return m ? { ac: m[1]!.replace(/ac-/i, "AC-"), evidence: m[2]!.trim() } : { ac: "AC-?", evidence: flag.trim() };
}

const same = (listed: string, given: string): boolean => listed === given || listed.endsWith(`/${given}`) || given.endsWith(`/${listed}`);

/** Acceptance criteria of the task that have no evidence entry. */
export function missingEvidence(acceptance: string[], evidence: Pick<Evidence, "ac" | "evidence">[]): string[] {
  return acceptance.filter((ac) => !evidence.some((e) => same(ac, e.ac) && e.evidence.trim()));
}

/**
 * What Hexagon itself can confirm. `verified` is set here and nowhere else: an agent saying so does not count.
 * A `test:<file>::<name>` reference is verified when the file is in the worktree, the name occurs in it, and the
 * task's verify output shows that test (or its file) ran. Everything else is a claim.
 */
export function evaluateEvidence(worktree: string, evidence: Evidence[], verifyOutput: string): Evidence[] {
  return evidence.map((e) => {
    const m = /^test:([^\s:]+?)::(.+)$/.exec(e.evidence.trim());
    if (!m) return { ...e, verified: false, basis: "claimed: not a test reference (use test:<file>::<test name>)" };
    const [, file, name] = m as unknown as [string, string, string];
    const abs = confinePath(worktree, file);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ...e, verified: false, basis: `claimed: ${file} is not in the worktree` };
    if (!fs.readFileSync(abs, "utf8").includes(name.trim())) return { ...e, verified: false, basis: `claimed: "${name.trim()}" does not occur in ${file}` };
    const base = path.basename(file);
    if (verifyOutput.includes(name.trim()) || verifyOutput.includes(file) || verifyOutput.includes(base)) return { ...e, verified: true, basis: "test found; the verify output shows it ran" };
    return { ...e, verified: false, basis: "claimed: the test exists, but the verify output does not show it ran" };
  });
}

export const isVerified = (e: Evidence): boolean => e.verified === true;
