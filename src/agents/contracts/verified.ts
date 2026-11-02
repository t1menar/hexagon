/**
 * Which integrations have actually been run against the real CLI, with what version and when. This file is a record
 * of evidence, not configuration: add a row only after running the conformance suite against the real CLI
 * (HEXAGON_REAL_CLI=<id> npx vitest run test/conformance.test.ts). An integration with no row has been tested against
 * a fake CLI only, and `hexagon agents doctor` says so.
 */
export interface RealRun { version: string; date: string; covered: string }

export const REAL_CLI_RUNS: Record<string, RealRun | undefined> = {
  "claude-code": { version: "2.1.316", date: "2026-11-02", covered: "conformance suite (resume remembers, usage reported), bench, window size" },
};

export function realCliNote(adapter: string, installedVersion: string | null): string {
  const run = REAL_CLI_RUNS[adapter];
  if (!run) return "NOT run against the real CLI: covered by fake-CLI tests only, so treat it as unverified";
  const same = installedVersion ? installedVersion.includes(run.version) : null;
  const when = `run against the real CLI ${run.version} on ${run.date} (${run.covered})`;
  if (same === false) return `${when}; installed ${installedVersion} is a different version: untested`;
  return when;
}
