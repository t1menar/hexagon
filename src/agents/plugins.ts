import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { loadManifestFile, manifestDefinition } from "./manifest.js";
import { adapterNames } from "./adapter-registry.js";
import { checkDefinition, registerDefinition, sdk, type AdapterDefinition } from "./sdk.js";

/**
 * Third-party adapters. `[plugins] adapters = ["./adapters/acme.toml", "./adapters/acme.mjs", "hexagon-adapter-acme"]`.
 * Loading is synchronous (config is loaded synchronously everywhere): a manifest is read as data; a module is loaded with
 * `require`, which can load ES modules since Node 22.12 (no top-level await in a plugin). Plugins are additive: in-tree
 * adapters are always there, and a plugin may not replace one.
 */
export interface PluginReport {
  spec: string;
  resolved: string | null;
  ok: boolean;
  /** Adapter names this entry registered. */
  adapters: string[];
  error?: string;
}

const reports = new Map<string, PluginReport>();
const BUILTIN = new Set<string>();

/** Remember which adapters exist before any plugin: those cannot be overridden. Called once, lazily. */
function snapshotBuiltins(): void { if (!BUILTIN.size) for (const n of adapterNames()) BUILTIN.add(n); }

export function pluginReports(): PluginReport[] { return [...reports.values()]; }
export function pluginErrors(): string[] { return pluginReports().filter((r) => !r.ok).map((r) => `plugin ${r.spec}: ${r.error}`); }

function resolveSpec(spec: string, baseDir: string): string {
  if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)) return path.resolve(baseDir, spec);
  // A package name: resolved from the project first, then from where Hexagon itself lives.
  try { return createRequire(path.join(baseDir, "noop.js")).resolve(spec); } catch { /* try next */ }
  return createRequire(import.meta.url).resolve(spec);
}

function definitionsOf(mod: unknown): AdapterDefinition[] {
  let m: unknown = mod;
  const asModule = m as { default?: unknown; adapter?: unknown; adapters?: unknown } | null;
  if (asModule && typeof asModule === "object") m = asModule.default ?? asModule.adapters ?? asModule.adapter ?? m;
  if (typeof m === "function") m = (m as (s: typeof sdk) => unknown)(sdk); // a function receives the SDK (base classes, helpers)
  if (m === undefined || m === null) return [];
  const list = Array.isArray(m) ? m : [m];
  return list.map((d) => { checkDefinition(d); return d as AdapterDefinition; });
}

function loadOne(spec: string, baseDir: string): PluginReport {
  const report: PluginReport = { spec, resolved: null, ok: false, adapters: [] };
  try {
    let file: string;
    try { file = resolveSpec(spec, baseDir); } catch { throw new Error(`cannot find "${spec}" (looked relative to ${baseDir}${spec.startsWith(".") ? "" : " and in node_modules"}). Check the path or install the package.`); }
    report.resolved = file;
    if (!fs.existsSync(file)) throw new Error(`${file} does not exist`);
    snapshotBuiltins();
    const defs = /\.(json|toml)$/.test(file) ? [manifestDefinition(loadManifestFile(file))] : definitionsOf(createRequire(file)(file));
    if (!defs.length) throw new Error("it exports no adapter definition (default export: defineAdapter({...}), a list of them, or a function (sdk) => definition)");
    for (const d of defs) {
      if (BUILTIN.has(d.id)) throw new Error(`adapter "${d.id}" is built in; a plugin cannot replace it (pick another id)`);
      registerDefinition(d);
      report.adapters.push(d.id);
    }
    report.ok = true;
  } catch (e) {
    report.error = (e as Error).message;
  }
  return report;
}

/** Load every entry once (a repeated config load does not re-register). Returns the reports for these entries. */
export function loadPlugins(specs: readonly string[], baseDir: string): PluginReport[] {
  const out: PluginReport[] = [];
  for (const spec of specs) {
    const key = `${baseDir}\0${spec}`;
    let r = reports.get(key);
    if (!r || !r.ok) { r = loadOne(spec, baseDir); reports.set(key, r); }
    out.push(r);
  }
  return out;
}

/** Test hook: forget loaded plugins' reports (registered adapters stay registered for the process). */
export function resetPluginReports(): void { reports.clear(); }
