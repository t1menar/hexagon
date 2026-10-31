import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { Role } from "../contracts/types.js";
import { formatErrors, rawSchema } from "../contracts/validate.js";
import { confinePath, matchesAny, truncateMiddle } from "../util/fsx.js";
import type { ToolOutcome, ToolSpec } from "./types.js";

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", additionalProperties: false, properties, required });
const str = (description: string) => ({ type: "string", description });

const checklistItem = obj(
  { id: str("AC id (e.g. AC-3) or a short step id"), label: str("Short label"), status: { enum: ["pending", "in_progress", "done", "failed", "skipped"] } },
  ["id", "status"],
);

function stripMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, $id: _i, title: _t, ...rest } = schema;
  return rest;
}

export const TOOL_SPECS: Record<string, ToolSpec> = {
  list_files: {
    name: "list_files",
    description: "List files under a directory of the workspace (recursive, relative paths). Skips .git and node_modules.",
    input_schema: obj({ dir: str("Directory relative to the workspace root; '.' for root"), max: { type: "integer", minimum: 1, maximum: 2000 } }, ["dir"]),
  },
  read_file: {
    name: "read_file",
    description: "Read a text file from the workspace.",
    input_schema: obj({ path: str("Path relative to the workspace root") }, ["path"]),
  },
  write_file: {
    name: "write_file",
    description: "Create or overwrite a file. Only paths matching the task's write scope are allowed.",
    input_schema: obj({ path: str("Path relative to the workspace root"), content: str("Full file content") }, ["path", "content"]),
  },
  edit_file: {
    name: "edit_file",
    description: "Replace one exact occurrence of old_str with new_str in a file within the write scope. old_str must match exactly once.",
    input_schema: obj({ path: str("Path relative to the workspace root"), old_str: str("Exact text to replace"), new_str: str("Replacement text") }, ["path", "old_str", "new_str"]),
  },
  run_cmd: {
    name: "run_cmd",
    description: "Run a shell command in the workspace (tests, linters, builds). Returns exit code and combined output.",
    input_schema: obj({ cmd: str("Command line"), timeout_s: { type: "integer", minimum: 1, maximum: 3600 } }, ["cmd"]),
  },
  report_status: {
    name: "report_status",
    description: "Tell the user what you are doing. Call when you change phase or finish a checklist item. Keep activity to one short line.",
    input_schema: obj(
      { phase: { enum: ["reading", "planning", "editing", "testing", "reporting"] }, activity: str("One short line"), checklist: { type: "array", items: checklistItem } },
      [],
    ),
  },
  ask_user: {
    name: "ask_user",
    description:
      "Ask the user a question. Use blocking=true only when the answer materially changes the result and cannot be inferred from the spec or code; the call waits for the answer. With blocking=false you get the default immediately and continue.",
    input_schema: obj(
      {
        kind: { enum: ["clarification", "choice", "approval", "spec_change"] },
        prompt: str("The question, with the context needed to answer it"),
        options: { type: "array", items: obj({ id: str("Short id, e.g. '1'"), label: str("Option text") }, ["id", "label"]) },
        default_option: str("Option id (or text) you would choose if not answered"),
        blocking: { type: "boolean" },
        refs: { type: "array", items: { type: "string" } },
      },
      ["kind", "prompt", "blocking"],
    ),
  },
  post_note: {
    name: "post_note",
    description: "Share a fact other tasks will need (e.g. a new interface and where it lives). Goes to the shared blackboard.",
    input_schema: obj({ body: str("The note"), refs: { type: "array", items: { type: "string" } } }, ["body"]),
  },
  request_change: {
    name: "request_change",
    description: "Ask the orchestrator for a change outside your write scope instead of making it yourself.",
    input_schema: obj({ outside_scope: { type: "array", items: { type: "string" } }, why: str("Why it is needed") }, ["outside_scope", "why"]),
  },
  ack: {
    name: "ack",
    description: "Acknowledge user messages you received (by id) once you have taken them into account.",
    input_schema: obj({ message_ids: { type: "array", items: { type: "string" }, minItems: 1 } }, ["message_ids"]),
  },
  git_diff: {
    name: "git_diff",
    description: "Show the diff of this task's branch against its base.",
    input_schema: obj({ stat_only: { type: "boolean" } }, []),
  },
  submit_result: {
    name: "submit_result",
    description: "Submit your final result envelope. Call exactly once, as your last action.",
    input_schema: stripMeta(rawSchema("result.v1.schema.json")),
  },
  submit_review: {
    name: "submit_review",
    description: "Submit your review verdict. Call exactly once, as your last action.",
    input_schema: obj(
      {
        verdict: { enum: ["approve", "request_changes"] },
        summary: str("One or two sentences"),
        findings: {
          type: "array",
          items: obj(
            { file: str("Path"), line: { type: "integer" }, severity: { enum: ["high", "medium", "low"] }, ac: str("AC id if related"), issue: str("What is wrong"), suggestion: str("How to fix") },
            ["severity", "issue"],
          ),
        },
      },
      ["verdict", "summary", "findings"],
    ),
  },
  submit_plan: {
    name: "submit_plan",
    description: "Submit the task plan. Call exactly once, as your last action.",
    input_schema: obj(
      {
        tasks: { type: "array", minItems: 1, items: (rawSchema("plan.v1.schema.json") as { $defs: { task: unknown } }).$defs.task },
        spec_issues: { type: "array", items: { type: "string" } },
      },
      ["tasks", "spec_issues"],
    ),
  },
};

export const ROLE_TOOLS: Record<Role, string[]> = {
  implementer: ["ack", "ask_user", "edit_file", "list_files", "post_note", "read_file", "report_status", "request_change", "run_cmd", "submit_result", "write_file"],
  tester: ["ack", "ask_user", "edit_file", "list_files", "post_note", "read_file", "report_status", "request_change", "run_cmd", "submit_result", "write_file"],
  resolver: ["ack", "ask_user", "edit_file", "list_files", "read_file", "report_status", "run_cmd", "submit_result", "write_file"],
  reviewer: ["git_diff", "list_files", "read_file", "report_status", "run_cmd", "submit_review"],
  planner: ["ask_user", "list_files", "read_file", "report_status", "submit_plan"],
  integrator: [],
  lead: [],
};

export const SUBMIT_TOOL: Partial<Record<Role, string>> = {
  implementer: "submit_result", tester: "submit_result", resolver: "submit_result", reviewer: "submit_review", planner: "submit_plan",
};

/** Sorted tool list for a role — deterministic order keeps the prompt cache warm. */
export function toolsForRole(role: Role): ToolSpec[] {
  return ROLE_TOOLS[role].slice().sort().map((n) => TOOL_SPECS[n]!);
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();
export function validateToolInput(name: string, input: unknown): string[] {
  const spec = TOOL_SPECS[name];
  if (!spec) return [`unknown tool ${name}`];
  let v = validators.get(name);
  if (!v) { v = ajv.compile(spec.input_schema); validators.set(name, v); }
  return v(input) ? [] : formatErrors(v.errors ?? []);
}

export interface WorkspaceOptions {
  cwd: string;
  writeGlobs: string[] | null; // null = read-only
  allowCommands: string[];
  timeoutS: number;
  onFileWritten?: (rel: string) => void;
}

const SKIP_DIRS = new Set([".git", "node_modules", ".hexagon", "dist", "build", "__pycache__", ".venv"]);
const SHELL_META = /[;&|`<>]|\$\(/;

/** File and command tools confined to one worktree. */
export class WorkspaceTools {
  constructor(readonly o: WorkspaceOptions) {}

  async run(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    switch (name) {
      case "list_files": return this.listFiles(String(input.dir ?? "."), Number(input.max ?? 500));
      case "read_file": return this.readFile(String(input.path));
      case "write_file": return this.writeFile(String(input.path), String(input.content));
      case "edit_file": return this.editFile(String(input.path), String(input.old_str), String(input.new_str));
      case "run_cmd": return this.runCmd(String(input.cmd), Number(input.timeout_s ?? this.o.timeoutS), true, signal);
      default: return { content: `unknown workspace tool ${name}`, is_error: true };
    }
  }

  private resolve(p: string): { abs: string; rel: string } | null {
    const abs = confinePath(this.o.cwd, p);
    if (!abs) return null;
    return { abs, rel: path.relative(this.o.cwd, abs).split(path.sep).join("/") };
  }

  listFiles(dir: string, max: number): ToolOutcome {
    const r = this.resolve(dir);
    if (!r || !fs.existsSync(r.abs)) return { content: `directory not found: ${dir}`, is_error: true };
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (out.length >= max) return;
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(path.relative(this.o.cwd, full).split(path.sep).join("/"));
      }
    };
    walk(r.abs);
    return { content: out.length ? out.join("\n") + (out.length >= max ? `\n… (truncated at ${max})` : "") : "(empty)" };
  }

  readFile(p: string): ToolOutcome {
    const r = this.resolve(p);
    if (!r) return { content: "path escapes the workspace", is_error: true };
    if (!fs.existsSync(r.abs)) return { content: `file not found: ${p}`, is_error: true };
    const stat = fs.statSync(r.abs);
    if (stat.isDirectory()) return { content: `${p} is a directory; use list_files`, is_error: true };
    if (stat.size > 2_000_000) return { content: `${p} is too large (${stat.size} bytes)`, is_error: true };
    return { content: truncateMiddle(fs.readFileSync(r.abs, "utf8"), 120_000) };
  }

  private checkWrite(p: string): { abs: string; rel: string } | ToolOutcome {
    const r = this.resolve(p);
    if (!r) return { content: "path escapes the workspace", is_error: true };
    if (this.o.writeGlobs === null) return { content: "this role cannot modify files", is_error: true };
    if (!matchesAny(r.rel, this.o.writeGlobs)) {
      return { content: `${r.rel} is outside your write scope (${this.o.writeGlobs.join(", ")}). Use request_change if it must change.`, is_error: true };
    }
    return r;
  }

  writeFile(p: string, content: string): ToolOutcome {
    const r = this.checkWrite(p);
    if ("content" in r) return r;
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    fs.writeFileSync(r.abs, content);
    this.o.onFileWritten?.(r.rel);
    return { content: `wrote ${r.rel} (${content.length} chars)` };
  }

  editFile(p: string, oldStr: string, newStr: string): ToolOutcome {
    const r = this.checkWrite(p);
    if ("content" in r) return r;
    if (!fs.existsSync(r.abs)) return { content: `file not found: ${p}`, is_error: true };
    const text = fs.readFileSync(r.abs, "utf8");
    const count = text.split(oldStr).length - 1;
    if (count !== 1) return { content: `old_str must occur exactly once in ${r.rel}; found ${count}`, is_error: true };
    fs.writeFileSync(r.abs, text.replace(oldStr, () => newStr));
    this.o.onFileWritten?.(r.rel);
    return { content: `edited ${r.rel}` };
  }

  commandAllowed(cmd: string): string | null {
    const allow = this.o.allowCommands;
    if (allow.includes("*")) return null;
    if (SHELL_META.test(cmd)) return "shell operators (; & | < > ` $()) are not allowed; run one command at a time";
    const trimmed = cmd.trim();
    const ok = allow.some((a) => trimmed === a || trimmed.startsWith(a + " "));
    return ok ? null : `command not in allowlist (${allow.join(", ")}); ask the user or configure [sandbox].allow_commands`;
  }

  runCmd(cmd: string, timeoutS: number, enforceAllowlist: boolean, signal?: AbortSignal): Promise<ToolOutcome> {
    if (enforceAllowlist) {
      const why = this.commandAllowed(cmd);
      if (why) return Promise.resolve({ content: why, is_error: true });
    }
    return runShell(cmd, this.o.cwd, timeoutS, signal).then((r) => ({
      content: `exit ${r.code}${r.timedOut ? " (timed out)" : ""}\n${truncateMiddle(r.output, 30_000)}`,
      is_error: r.code !== 0,
    }));
  }
}

export interface ShellResult { code: number; output: string; timedOut: boolean }

export function runShell(cmd: string, cwd: string, timeoutS: number, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, detached: true });
    let output = "";
    let timedOut = false;
    const onData = (d: Buffer) => {
      output += d.toString();
      if (output.length > 2_000_000) output = output.slice(-1_000_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutS * 1000);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve({ code: code ?? 1, output, timedOut });
    });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 127, output: String(e), timedOut: false }); });
  });
}
