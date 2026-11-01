import type { Effort } from "../contracts/types.js";

/**
 * Roles are data. The built-in ones use industry job titles; a project can add its own under [roles.<id>] in
 * config.toml (agent, effort, optionally prompt = "<file>", title, skills, group).
 */
export type RoleGroup = "analysis" | "implementation" | "review" | "integration";

export interface RoleDef {
  id: string;
  title: string;
  summary: string;
  /** task: runs inside a plan · solo: runs outside a run (chat, bootstrap). */
  kind: "task" | "solo";
  group: RoleGroup;
  effort: Effort;
  builtin: boolean;
}

export const BUILTIN_ROLES: readonly RoleDef[] = [
  { id: "bootstrap", title: "Project Onboarding", summary: "studies a repository and writes HEXAGON.md", kind: "solo", group: "analysis", effort: "low", builtin: true },
  { id: "analyst", title: "Business & Systems Analyst", summary: "analyses the request and writes analysis, spec and task graph", kind: "solo", group: "analysis", effort: "high", builtin: true },
  { id: "architect", title: "Software Architect", summary: "designs interfaces and data flow when the change needs it", kind: "solo", group: "analysis", effort: "high", builtin: true },
  { id: "developer", title: "Software Development Engineer", summary: "implements a task test-first inside its write scope", kind: "task", group: "implementation", effort: "medium", builtin: true },
  { id: "qa", title: "QA Engineer (SDET)", summary: "designs and writes tests, hunts regressions", kind: "task", group: "implementation", effort: "medium", builtin: true },
  { id: "devops", title: "DevOps / Infrastructure Engineer", summary: "build, CI and infrastructure-as-code changes", kind: "task", group: "implementation", effort: "medium", builtin: true },
  { id: "security", title: "Security Engineer", summary: "security fixes and hardening", kind: "task", group: "implementation", effort: "high", builtin: true },
  { id: "reviewer", title: "Code Reviewer", summary: "reviews a diff against the acceptance criteria, read-only", kind: "task", group: "review", effort: "high", builtin: true },
  { id: "release", title: "Release Engineer", summary: "merges work and resolves conflicts", kind: "task", group: "integration", effort: "high", builtin: true },
  { id: "control", title: "Hexagon Assistant", summary: "the main chat: operates Hexagon", kind: "solo", group: "analysis", effort: "low", builtin: true },
];

/** Names used before the industry vocabulary. Configs, plans, skills and prompts that use them keep loading. */
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  planner: "analyst",
  implementer: "developer",
  tester: "qa",
  integrator: "release",
  resolver: "release",
  lead: "control",
  init: "bootstrap",
};

export const canonicalRole = (r: string): string => ROLE_ALIASES[r] ?? r;

/** Old file names of a role's prompt, checked after the current one. */
export const legacyNames = (role: string): string[] => Object.entries(ROLE_ALIASES).filter(([, v]) => v === role).map(([k]) => k);

export function builtinRole(id: string): RoleDef | undefined {
  return BUILTIN_ROLES.find((r) => r.id === id);
}

/** Display title of any role id, built-in or custom. */
export function roleTitle(id: string, custom?: { title?: string }): string {
  return custom?.title ?? builtinRole(canonicalRole(id))?.title ?? id;
}
