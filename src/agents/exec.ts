import { capabilities } from "./contracts/capabilities.js";
import { selectionFrom } from "./contracts/model-selection.js";
import { ManifestAdapter, checkManifest } from "./manifest.js";
import { registerAdapter } from "./adapter-registry.js";

/**
 * Generic wrapper for any non-interactive coding CLI: a manifest built from `command = [...]`.
 * The prompt (system + task) goes to the CLI's stdin. To pass it another way, name the slot in the command:
 * `{prompt_file}` (a private temp file) or `{prompt}` (in argv: limited by ARG_MAX and visible in `ps`, so it is opt-in).
 * No live input, no usage, no runtime model: a generic wrapper claims nothing it cannot do. Messages that arrive while it runs are
 * delivered on the next run. The agent reports back through the same `hexagon …` shell commands as every other agent.
 * For a CLI that prints JSON lines and has sessions, write a manifest instead (docs/ADAPTERS.md).
 */
export class ExecAdapter extends ManifestAdapter {
  constructor(id: string, command: string[], interactive: string[] | null, provider = "unknown") {
    const tail = command.slice(1);
    const all = JSON.stringify(tail);
    const prompt = all.includes("{prompt}") ? "argv" : all.includes("{prompt_file}") ? "file" : "stdin";
    const m = checkManifest({ apiVersion: 1, id: "exec", provider, display_name: "Generic CLI", run: { new: tail, prompt }, plain_output: "progress", interactive: interactive ?? undefined }, `[agents.${id}]`);
    super(id, m, command.slice(0, 1), selectionFrom(null));
    (this as { capabilities: unknown }).capabilities = capabilities({ supportsStreaming: false, supportsSessionResume: false });
  }
}

registerAdapter("exec", (id, c) => {
  if (!c.command?.length) throw new Error(`[agents.${id}] needs command = ["…"]`);
  return new ExecAdapter(id, c.command, c.interactive ?? null, c.provider ?? "unknown");
});
