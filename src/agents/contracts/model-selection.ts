/**
 * An execution-time model choice. Never a catalogue entry: identifiers are opaque strings that either
 * came from the CLI's own discovery or were typed by the user. Hexagon does not interpret them.
 */
export type ModelSelection =
  | { mode: "cli-default" }
  | { mode: "discovered"; identifier: string }
  | { mode: "custom"; identifier: string };

export const CLI_DEFAULT: ModelSelection = { mode: "cli-default" };

export interface DiscoveredModel {
  /** Opaque identifier, passed back to the CLI unchanged. */
  identifier: string;
  label?: string;
  /** Only from a reliable provider/runtime source; never inferred from the identifier. */
  contextWindow?: number;
}

export interface ModelDiscoveryResult {
  supported: boolean;
  models?: DiscoveredModel[];
  source?: "cli" | "runtime" | "user";
  discoveredAt?: string;
  diagnostic?: string;
}

/** The override to pass to the CLI, or null: no override means no model argument at all. */
export function overrideOf(sel: ModelSelection | undefined): string | null {
  return sel && sel.mode !== "cli-default" && sel.identifier.trim() ? sel.identifier.trim() : null;
}

/** Normalise config input (`model = "x"` or `model_mode`) into a selection. A bare string is a user-supplied custom id. */
export function selectionFrom(model: unknown): ModelSelection {
  if (typeof model !== "string") return CLI_DEFAULT;
  const id = model.trim();
  return !id || id === "default" || id === "cli-default" ? CLI_DEFAULT : { mode: "custom", identifier: id };
}

export function describeSelection(sel: ModelSelection): string {
  return sel.mode === "cli-default" ? "native CLI default" : `${sel.mode === "custom" ? "custom" : "discovered"}: ${sel.identifier}`;
}

/** Discovery cache keyed by what can change the answer (adapter, CLI version, environment fingerprint). Not a catalogue. */
export class DiscoveryCache {
  private entries = new Map<string, { at: number; result: ModelDiscoveryResult }>();
  constructor(private ttlMs = 10 * 60_000, private now: () => number = Date.now) {}

  async get(key: string, load: () => Promise<ModelDiscoveryResult>): Promise<ModelDiscoveryResult> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.result;
    const result = await load();
    // Failures are not cached for long: the user may fix auth and retry.
    if (result.supported) this.entries.set(key, { at: this.now(), result });
    return result;
  }
  clear(): void { this.entries.clear(); }
}
