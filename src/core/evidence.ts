import fs from "node:fs";
import path from "node:path";
import type { ResultEnvelope } from "../contracts/types.js";
import { confinePath } from "../util/fsx.js";
import { ASSERT } from "./integrity.js";

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

const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--|;|"""|''\')/;

/** Where the named test is defined: the first line that mentions the name and is not a comment. */
function definitionLine(lines: string[], name: string): number {
  return lines.findIndex((l) => l.includes(name) && !COMMENT.test(l));
}

/**
 * A weak look at the test source: the name must be on a non-comment line, and an assertion must follow it before the
 * next 40 lines end. It cannot tell a meaningful assertion from `expect(1).toBe(1)`; that is what the mutation check is for.
 */
export function inspectTest(source: string, name: string): { ok: true } | { ok: false; why: string } {
  const lines = source.split("\n");
  const at = definitionLine(lines, name);
  if (at < 0) return { ok: false, why: lines.some((l) => l.includes(name)) ? `"${name}" occurs only in comments` : `"${name}" does not occur` };
  if (!lines.slice(at, at + 40).some((l) => !COMMENT.test(l) && ASSERT.test(l))) return { ok: false, why: `"${name}" has no assertion in the ${40} lines after it` };
  return { ok: true };
}

/**
 * The weak half of the check: the reference is well-formed, the test is in the worktree, looks like a test with an
 * assertion, and the verify output shows it (or its file) ran. A string match proves little, so a pass here is only a
 * candidate (`basis` starts with "weak:"); `confirmByMutation` decides whether it is verified.
 */
export function evaluateEvidence(worktree: string, evidence: Evidence[], verifyOutput: string): Evidence[] {
  return evidence.map((e) => {
    const m = /^test:([^\s:]+?)::(.+)$/.exec(e.evidence.trim());
    if (!m) return { ...e, verified: false, basis: "claimed: not a test reference (use test:<file>::<test name>)" };
    const [, file, name] = m as unknown as [string, string, string];
    const abs = confinePath(worktree, file);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { ...e, verified: false, basis: `claimed: ${file} is not in the worktree` };
    const look = inspectTest(fs.readFileSync(abs, "utf8"), name.trim());
    if (!look.ok) return { ...e, verified: false, basis: `claimed: ${look.why} in ${file}` };
    const base = path.basename(file);
    if (verifyOutput.includes(name.trim()) || verifyOutput.includes(file) || verifyOutput.includes(base)) return { ...e, verified: true, basis: "weak: test found with an assertion; the verify output shows it ran" };
    return { ...e, verified: false, basis: "claimed: the test exists, but the verify output does not show it ran" };
  });
}

/** What the mutation check needs from its host (the supervisor); injected so the logic is testable without git. */
export interface MutationHost {
  /** Product files the task changed (everything except tests): these are reverted to the base for the check. */
  productFiles: string[];
  /** Revert the product files to the base, run `run`, and always restore the task's state. Resolves with the exit code. */
  withoutChange(run: () => Promise<number>): Promise<number>;
  /** Run this one test; null when no concrete command is known (the caller then falls back to the task's verify). */
  runTest(file: string, name: string): Promise<number>;
  how: string;
}

/**
 * A test that still passes after the change it is supposed to prove is reverted does not depend on the change.
 * Candidates (`weak:`) become verified only if the test FAILS without the task's product changes.
 */
export async function confirmByMutation(evidence: Evidence[], host: MutationHost): Promise<Evidence[]> {
  const out: Evidence[] = [];
  for (const e of evidence) {
    const m = /^test:([^\s:]+?)::(.+)$/.exec(e.evidence.trim());
    if (!e.verified || !m) { out.push(e); continue; }
    if (!host.productFiles.length) { out.push({ ...e, verified: false, basis: "claimed: the task changes no product file, so 'the test fails without the change' cannot be shown" }); continue; }
    const code = await host.withoutChange(() => host.runTest(m[1]!, m[2]!.trim()));
    out.push(code === 0
      ? { ...e, verified: false, basis: `claimed: test does not depend on the change — it still passes with ${host.productFiles.length} product file(s) reverted to the base (${host.how})` }
      : { ...e, verified: true, basis: `verified by mutation: the test fails (exit ${code}) with the task's product changes reverted (${host.how})` });
  }
  return out;
}

export const isVerified = (e: Evidence): boolean => e.verified === true;
