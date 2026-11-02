/**
 * Which integrations have actually been run against the real CLI, with what version and when. This file is a record
 * of evidence, not configuration: an integration sets `realRun` when it registers, only after running the conformance suite against the real CLI
 * (HEXAGON_REAL_CLI=<id> npx vitest run test/conformance.test.ts). An integration with no row has been tested against
 * a fake CLI only, and `hexagon agents doctor` says so.
 */
import { realRunOf } from "../registry.js";

export function realCliNote(adapter: string, installedVersion: string | null): string {
  const run = realRunOf(adapter);
  if (!run) return "NOT run against the real CLI: covered by fake-CLI tests only, so treat it as unverified";
  const same = installedVersion ? installedVersion.includes(run.version) : null;
  const when = `run against the real CLI ${run.version} on ${run.date} (${run.covered})`;
  if (same === false) return `${when}; installed ${installedVersion} is a different version: untested`;
  return when;
}
