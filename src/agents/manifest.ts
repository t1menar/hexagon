import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AgentEvent } from "../contracts/types.js";
import { probe, whichExecutable, type AdapterDiagnostics } from "./contracts/adapter.js";
import { capabilities, type SecurityCapabilities } from "./contracts/capabilities.js";
import { selectionFrom, type ModelDiscoveryResult, type ModelSelection } from "./contracts/model-selection.js";
import { OneShotAdapter, safeJson, type OneShotSpec } from "./oneshot.js";
import { ADAPTER_API_VERSION, type AdapterDefinition } from "./sdk.js";
import type { AgentAdapter, AgentRunContext } from "./types.js";

/**
 * A declarative adapter: a CLI that runs once per message and prints JSON lines, described in a data file. No code, so
 * nothing for Hexagon to trust except the argv it will run. See docs/ADAPTERS.md for the field reference.
 */
export type Tpl = string | string[];
export interface EventRule {
  emit: "chat" | "tool_call" | "usage" | "session_handle" | "model" | "error" | "turn_end" | "progress";
  /** Every key must equal the value at that (dotted) path of the line. No `when`: the rule applies to every line. */
  when?: Record<string, string | number | boolean>;
  /** Paths into the line. A rule whose required paths are missing emits nothing (never a made-up value). */
  text?: string; name?: string; summary?: string; handle?: string; model?: string; message?: string;
  input?: string; output?: string; cache_read?: string; cache_write?: string; cost_usd?: string; window?: string;
}
export interface Manifest {
  apiVersion: number;
  id: string;
  provider?: string;
  display_name?: string;
  /** The executable; `command` overrides it (including from [agents.x].command). */
  cli?: string;
  auth_env?: string[];
  run: {
    new: Tpl[];
    resume?: Tpl[];
    readonly_args?: Tpl[];
    write_args?: Tpl[];
    /** One argument group per allowed command prefix, `{rule}` = the prefix. Only used when `command_allow_list` is declared. */
    allow_args?: Tpl[];
    /** "stdin" (default), "file" (a 0600 temp file, `{prompt_file}`) or "argv" (`{prompt}`: limited by ARG_MAX and visible in `ps`). */
    prompt?: "stdin" | "file" | "argv";
    /** Hexagon effort (low|medium|high|max) → the CLI's own word, for `{effort}`. Unmapped efforts leave the slot empty. */
    effort_map?: Record<string, string>;
  };
  events?: EventRule[];
  /** Lines that are not JSON become progress text (for a plain-text CLI). */
  plain_output?: "progress";
  /** Command that opens the CLI's session interactively (takeover). */
  interactive?: string[];
  detect?: { version?: string[]; auth?: string[] };
  models?: { list?: string[] };
  /** What the CLI itself enforces. Declare nothing you have not verified: `readonly_args` alone is a request, not enforcement. */
  security?: { read_only_enforced?: boolean; command_allow_list?: boolean };
}

export function loadManifestFile(file: string): Manifest {
  const text = fs.readFileSync(file, "utf8");
  const raw = file.endsWith(".json") ? JSON.parse(text) : parseToml(text);
  return checkManifest(raw, file);
}

export function checkManifest(raw: unknown, where = "manifest"): Manifest {
  const m = raw as Partial<Manifest> | null;
  const bad = (msg: string): never => { throw new Error(`${where}: ${msg}`); };
  if (!m || typeof m !== "object") return bad("not an object");
  if (m.apiVersion !== ADAPTER_API_VERSION) bad(`apiVersion must be ${ADAPTER_API_VERSION} (got ${String(m.apiVersion)})`);
  if (typeof m.id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(m.id)) bad(`id must be lower-case letters, digits, - or _ (got ${JSON.stringify(m.id)})`);
  if (!m.run || !Array.isArray(m.run.new)) bad("[run].new (the argv after the executable for a new session) is required");
  const tpls = (name: string, t: unknown) => {
    if (t === undefined) return;
    if (!Array.isArray(t) || !t.every((x) => typeof x === "string" || (Array.isArray(x) && x.every((y) => typeof y === "string")))) bad(`${name} must be a list of strings or lists of strings`);
  };
  for (const k of ["new", "resume", "readonly_args", "write_args", "allow_args"] as const) tpls(`[run].${k}`, m.run![k]);
  if (m.run!.prompt && !["stdin", "file", "argv"].includes(m.run!.prompt)) bad(`[run].prompt must be "stdin", "file" or "argv"`);
  const all = JSON.stringify([m.run!.new, m.run!.resume, m.run!.readonly_args, m.run!.write_args]);
  const mode = m.run!.prompt ?? "stdin";
  if (mode === "file" && !all.includes("{prompt_file}")) bad(`[run].prompt = "file" needs a {prompt_file} slot in the argv`);
  if (mode === "argv" && !all.includes("{prompt}")) bad(`[run].prompt = "argv" needs a {prompt} slot in the argv`);
  if (mode !== "argv" && all.includes("{prompt}")) bad(`{prompt} puts the prompt in argv: set [run].prompt = "argv" to say so (ARG_MAX and \`ps\` expose it), or use stdin / {prompt_file}`);
  for (const [i, r] of (m.events ?? []).entries()) {
    if (!["chat", "tool_call", "usage", "session_handle", "model", "error", "turn_end", "progress"].includes(r.emit)) bad(`[[events]] #${i + 1}: unknown emit "${String(r.emit)}"`);
  }
  return m as Manifest;
}

const SLOT = /\{(prompt_file|prompt|session|model|cwd|hexagon_bin|effort|rule)\}/g;

/** Expand argument templates. A string or group that names a slot with no value is dropped as a unit, never passed half-filled. */
export function expand(tpl: Tpl[] | undefined, slots: Record<string, string | null | undefined>): string[] {
  const out: string[] = [];
  const one = (s: string): string | null => {
    let missing = false;
    const r = s.replace(SLOT, (_, k: string) => { const v = slots[k]; if (v === undefined || v === null || v === "") { missing = true; return ""; } return v; });
    return missing ? null : r;
  };
  for (const t of tpl ?? []) {
    if (Array.isArray(t)) { const g = t.map(one); if (g.every((x) => x !== null)) out.push(...(g as string[])); } else { const x = one(t); if (x !== null) out.push(x); }
  }
  return out;
}

/** Value at a dotted path (`a.b.0.c`), or undefined. */
export function at(obj: unknown, p: string): unknown {
  let cur: unknown = obj;
  for (const k of p.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/** Turn one parsed line into events by the manifest's rules. Pure; a line no rule matches produces nothing. */
export function applyRules(rules: EventRule[], line: Record<string, unknown>): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (const r of rules) {
    if (r.when && !Object.entries(r.when).every(([k, v]) => at(line, k) === v)) continue;
    const g = (p?: string) => (p ? at(line, p) : undefined);
    switch (r.emit) {
      case "chat": { const t = str(g(r.text)); if (t) out.push({ type: "chat", from: "agent", text: t.slice(0, 8000) }); break; }
      case "tool_call": { const n = str(g(r.name)) ?? "tool"; const s = str(g(r.summary)) ?? n; if (r.name || r.summary) out.push({ type: "tool_call", name: n, summary: s.split("\n")[0]!.slice(0, 160) }); break; }
      case "session_handle": { const h = str(g(r.handle)); if (h) out.push({ type: "session_handle", handle: h }); break; }
      case "model": { const m = str(g(r.model)); if (m) out.push({ type: "model", model: m }); break; }
      case "error": { const m = str(g(r.message)); if (m) out.push({ type: "progress", text: m.slice(0, 200) }); break; }
      case "progress": { const m = str(g(r.text)); if (m) out.push({ type: "progress", text: m.slice(0, 200) }); break; }
      case "usage": {
        // Real numbers or nothing: input and output must both be present, the rest default to 0 only because the CLI said the call happened.
        const i = num(g(r.input)), o = num(g(r.output));
        if (i === null || o === null) break;
        const w = num(g(r.window));
        out.push({ type: "usage", input: i, output: o, cache_read: num(g(r.cache_read)) ?? 0, cache_write: num(g(r.cache_write)) ?? 0, cost_usd: num(g(r.cost_usd)) ?? 0, step: true, ...(w ? { window: w } : {}) });
        break;
      }
      case "turn_end": break; // a one-shot turn ends when the process exits; accepted so a manifest can state it
    }
  }
  return out;
}

export class ManifestAdapter extends OneShotAdapter implements AgentAdapter {
  readonly adapterId: string;
  readonly provider: string;
  readonly displayName: string;
  readonly capabilities;
  override readonly security: SecurityCapabilities;
  protected override readonly authEnv: readonly string[];
  private handles = new Map<string, string>();

  constructor(id: string, private m: Manifest, command: string[], selection: ModelSelection) {
    super(id, command, selection);
    this.adapterId = m.id;
    this.provider = m.provider ?? m.id;
    this.displayName = m.display_name ?? m.id;
    this.authEnv = m.auth_env ?? [];
    const rules = m.events ?? [];
    const has = (e: EventRule["emit"]) => rules.some((r) => r.emit === e);
    this.capabilities = capabilities({
      supportsStreaming: rules.length > 0,
      supportsSessionResume: Boolean(m.run.resume) && has("session_handle"),
      supportsModelDiscovery: Boolean(m.models?.list),
      supportsRuntimeModelReporting: has("model"),
      supportsUsageMetrics: has("usage"),
      supportsStructuredOutput: rules.length > 0,
    });
    // Nothing is claimed that the manifest did not declare: readonly_args alone is a request, not enforcement.
    this.security = { readOnlyEnforced: m.security?.read_only_enforced === true, commandAllowList: m.security?.command_allow_list === true };
  }

  protected override async authStatus() {
    const a = this.m.detect?.auth;
    if (!a) return { auth: "unknown" as const, authDetail: "this manifest declares no auth probe" };
    const r = await probe(this.command.slice(0, 1), a);
    if (r.missing) return { auth: "unknown" as const };
    return r.ok ? { auth: "ok" as const, authDetail: (r.stdout + r.stderr).trim().split("\n")[0]?.slice(0, 120) } : { auth: "unauthenticated" as const, authDetail: `\`${[...this.command.slice(0, 1), ...a].join(" ")}\` failed: ${(r.stderr || r.stdout).trim().split("\n")[0]?.slice(0, 120)}` };
  }

  override async detect(): Promise<AdapterDiagnostics> {
    const flag = this.m.detect?.version;
    if (!flag) return super.detect();
    const exe = await whichExecutable(this.command[0]!);
    if (!exe) return { installed: false, executable: null, version: null, auth: "unknown", problems: [`\`${this.command[0]}\` was not found on PATH — install ${this.displayName} or set command = ["/path/to/${this.command[0]}"]`] };
    const r = await probe(this.command.slice(0, 1), flag);
    const v = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(r.stdout + " " + r.stderr)?.[0] ?? null;
    const a = await this.authStatus();
    return { installed: true, executable: exe, version: r.ok ? v : null, ...a, problems: a.auth === "unauthenticated" ? [a.authDetail ?? `${this.displayName} is not logged in`] : [] };
  }

  override async discoverModels(): Promise<ModelDiscoveryResult> {
    const l = this.m.models?.list;
    if (!l) return super.discoverModels();
    const r = await probe(this.command.slice(0, 1), l, 15000);
    if (!r.ok) return { supported: false, diagnostic: r.missing ? `${this.command[0]} is not installed` : `\`${[...this.command.slice(0, 1), ...l].join(" ")}\` failed: ${(r.stderr || r.stdout).trim().slice(0, 160)}` };
    const models = r.stdout.split("\n").map((x) => x.trim()).filter((x) => x && !/^[-=─_]{3,}$/.test(x)).map((x) => ({ identifier: x.replace(/^[-*•]\s*/, "").split(/\s+/)[0]! })).filter((x) => x.identifier);
    return { supported: true, models, source: "cli", discoveredAt: new Date().toISOString() };
  }

  override takeoverCommand(): string[] | null { return this.m.interactive ?? null; }

  private handleFor(ctx: AgentRunContext): string | null { return ctx.handle ?? this.handles.get(ctx.sessionId) ?? null; }
  protected override continues(ctx: AgentRunContext): boolean { return ctx.resume && Boolean(this.m.run.resume) && this.handleFor(ctx) !== null; }

  protected build(ctx: AgentRunContext, prompt: string): OneShotSpec {
    const run = this.m.run;
    const mode = run.prompt ?? "stdin";
    const resumed = this.continues(ctx);
    let promptFile: string | null = null;
    if (mode === "file") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hexagon-prompt-"));
      promptFile = path.join(dir, "prompt.md");
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
    }
    const slots = {
      prompt_file: promptFile, prompt: mode === "argv" ? prompt : null, cwd: ctx.cwd, model: this.model, hexagon_bin: ctx.env.HEXAGON_BIN ?? "hexagon",
      session: resumed ? this.handleFor(ctx) : ctx.sessionId, effort: run.effort_map?.[ctx.effort] ?? null,
    };
    const allow = this.security.commandAllowList && ctx.allowCommands.length && !ctx.allowCommands.includes("*")
      ? ctx.allowCommands.flatMap((rule) => expand(run.allow_args, { ...slots, rule })) : [];
    const argv = [...this.command, ...expand(resumed && run.resume ? run.resume : run.new, slots), ...expand(ctx.readOnly ? run.readonly_args : run.write_args, slots), ...allow];
    return { argv, stdin: mode === "stdin" ? prompt : null, cleanup: promptFile ? () => fs.rmSync(path.dirname(promptFile!), { recursive: true, force: true }) : undefined };
  }

  protected onLine(line: string, ctx: AgentRunContext): void {
    const e = safeJson(line);
    if (!e) { if (this.m.plain_output === "progress") ctx.host.emit({ type: "progress", text: line.slice(0, 200) }); return; }
    for (const ev of applyRules(this.m.events ?? [], e)) {
      if (ev.type === "session_handle") this.handles.set(ctx.sessionId, ev.handle);
      ctx.host.emit(ev);
    }
  }
}

/** The definition a plugin loader registers for a manifest file. */
export function manifestDefinition(m: Manifest): AdapterDefinition {
  return {
    apiVersion: ADAPTER_API_VERSION,
    id: m.id,
    create: (_id, c, o) => new ManifestAdapter(_id, m, c.command?.length ? c.command : [m.cli ?? m.id], selectionFrom(o || c.model)),
    meta: { cli: m.cli ?? undefined },
  };
}
