import { execFile } from "node:child_process";
import type { AgentCapabilities } from "./capabilities.js";
import { classifyProviderError, type ClassifiedError } from "./errors.js";
import type { ModelDiscoveryResult, ModelSelection } from "./model-selection.js";

export interface AdapterDiagnostics {
  installed: boolean;
  executable: string | null;
  version: string | null;
  auth: "ok" | "unauthenticated" | "unknown";
  authDetail?: string;
  /** Actionable problems (not installed, not logged in, …). */
  problems: string[];
}

/** Run a short, read-only probe command: argv array, no shell, hard timeout. */
export function probe(command: string[], args: string[], timeoutMs = 8000, env?: Record<string, string>): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(command[0]!, [...command.slice(1), ...args], { timeout: timeoutMs, env: { ...process.env, ...env }, shell: false, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const missing = (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), missing });
    });
  });
}

/** First version-looking token in `--version` output; null when the CLI did not answer. */
export async function probeVersion(command: string[], flag = "--version"): Promise<{ version: string | null; missing: boolean }> {
  const r = await probe(command, [flag]);
  const m = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(r.stdout + " " + r.stderr);
  return { version: r.ok && m ? m[0] : null, missing: r.missing };
}

/** Resolve an executable on PATH (or an explicit path) without invoking a shell. */
export async function whichExecutable(bin: string): Promise<string | null> {
  if (bin.includes("/")) return (await probe([bin], ["--version"])).missing ? null : bin;
  const r = await probe(["/usr/bin/which", bin], []);
  return r.ok ? r.stdout.trim().split("\n")[0] || null : null;
}

export function classifyError(text: string): ClassifiedError {
  return classifyProviderError(text);
}

/** Common identity every integration exposes, independent of how it runs. */
export interface AdapterIdentity {
  readonly id: string;
  /** Vendor / model ecosystem (anthropic, openai, xai, …); a label, not used for behaviour. */
  readonly provider: string;
  /** Integration kind (claude-code, codex, grok, exec, mock). */
  readonly adapterId: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  /** Execution selection. `cli-default` means no model argument is passed. */
  readonly selection: ModelSelection;
}

export interface AdapterDiscovery {
  detect(): Promise<AdapterDiagnostics>;
  discoverModels(): Promise<ModelDiscoveryResult>;
  classifyError(text: string): ClassifiedError;
}
