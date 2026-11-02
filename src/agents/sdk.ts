/**
 * The adapter SDK: everything a third-party integration needs, behind one versioned entry point.
 *
 *   export default defineAdapter({ apiVersion: 1, id: "acme", create: (id, conf, model) => new AcmeAdapter(...) });
 *
 * `defineAdapter` only validates and returns the definition; Hexagon (or `registerDefinition`) registers it. A plugin module
 * therefore needs no import from Hexagon at all, which matters because the standalone binary has no `node_modules`
 * to resolve one from. A module that wants the base classes exports a function instead and receives them: see `PluginSdk`.
 */
import { AdapterBase, probe } from "./contracts/base.js";
import { capabilities, NO_CAPABILITIES, NO_SECURITY } from "./contracts/capabilities.js";
import { classifyProviderError } from "./contracts/errors.js";
import { selectionFrom } from "./contracts/model-selection.js";
import { LineBuffer, OneShotAdapter, safeJson } from "./oneshot.js";
import { registerAdapter, type AdapterFactory, type AdapterMeta } from "./adapter-registry.js";

/** Bumped only when an adapter written against the previous version stops working. */
export const ADAPTER_API_VERSION = 1;

export interface AdapterDefinition {
  apiVersion: number;
  /** The name `[agents.x] adapter = "…"` uses. */
  id: string;
  create: AdapterFactory;
  meta?: AdapterMeta & { agentId?: string };
}

export function defineAdapter(def: AdapterDefinition): AdapterDefinition {
  checkDefinition(def);
  return def;
}

export function checkDefinition(def: unknown): asserts def is AdapterDefinition {
  const d = def as Partial<AdapterDefinition> | null;
  if (!d || typeof d !== "object") throw new Error("an adapter definition must be an object { apiVersion, id, create }");
  if (d.apiVersion !== ADAPTER_API_VERSION) {
    throw new Error(`adapter "${String(d.id ?? "?")}" targets adapter API version ${String(d.apiVersion)}, but this Hexagon speaks version ${ADAPTER_API_VERSION}. ${typeof d.apiVersion === "number" && d.apiVersion > ADAPTER_API_VERSION ? "Upgrade Hexagon" : "Update the adapter"} (see docs/ADAPTERS.md).`);
  }
  if (typeof d.id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(d.id)) throw new Error(`adapter id must be lower-case letters, digits, - or _ (got ${JSON.stringify(d.id)})`);
  if (typeof d.create !== "function") throw new Error(`adapter "${d.id}" needs create(id, conf, modelOverride) returning an AgentAdapter`);
}

/** Register a validated definition. In-tree adapters and plugins go through the same call. */
export function registerDefinition(def: AdapterDefinition): void {
  checkDefinition(def);
  registerAdapter(def.id, def.create, def.meta ?? {});
}

/** What a plugin module that exports a function receives. */
export const sdk = {
  apiVersion: ADAPTER_API_VERSION,
  defineAdapter,
  AdapterBase,
  OneShotAdapter,
  LineBuffer,
  safeJson,
  probe,
  capabilities,
  NO_CAPABILITIES,
  NO_SECURITY,
  selectionFrom,
  classifyProviderError,
};
export type PluginSdk = typeof sdk;

export type { AdapterFactory, AdapterMeta } from "./adapter-registry.js";
export type { AgentAdapter, AgentRunContext, AdapterOutcome } from "./types.js";
