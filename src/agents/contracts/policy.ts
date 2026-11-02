import type { Effort } from "../../contracts/types.js";
import { NO_SECURITY, type SecurityCapabilities } from "./capabilities.js";

/**
 * What the core wants enforced for one run. The core builds it once; each adapter projects it onto its own CLI's flags
 * and says what it really enforced *for this run* (`project().enforced`). Nothing is claimed that the projection did not do.
 */
export interface RunPolicy {
  /** The agent may not change files (reviewers). */
  readOnly: boolean;
  /** Shell command prefixes the agent may run; "*" means anything. */
  allowCommands: string[];
  /** The path of the `hexagon` binary the agent reports through; always allowed. */
  hexagonBin: string | null;
  /** Files the agent should not read (secret files), as plain globs. */
  secretDeny: string[];
  effort: Effort;
}

export const SECRET_DENY_GLOBS = ["**/.env", "**/.env.*"];

export interface Projection {
  /** CLI arguments for permissions/sandbox/effort. */
  args: string[];
  env?: Record<string, string>;
  /** What this projection enforces for this run. */
  enforced: SecurityCapabilities;
}

export interface PolicyProjector {
  project(policy: RunPolicy): Projection;
}

/** The policy of a run: the one the core put on the context, or (for a hand-built context) derived from its fields. */
export function policyOf(ctx: { policy?: RunPolicy; readOnly: boolean; allowCommands: string[]; env: Record<string, string>; effort: Effort }): RunPolicy {
  return ctx.policy ?? { readOnly: ctx.readOnly, allowCommands: ctx.allowCommands, hexagonBin: ctx.env.HEXAGON_BIN ?? null, secretDeny: SECRET_DENY_GLOBS, effort: ctx.effort };
}

export function hasProjector(a: unknown): a is PolicyProjector { return typeof (a as Partial<PolicyProjector>)?.project === "function"; }

/** What an adapter enforces for this policy: its projection when it has one, otherwise its static claim. */
export function enforcedFor(a: { security: SecurityCapabilities }, policy: RunPolicy): SecurityCapabilities {
  return hasProjector(a) ? a.project(policy).enforced : a.security ?? NO_SECURITY;
}
