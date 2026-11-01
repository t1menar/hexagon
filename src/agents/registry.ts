// The set of integrations that ship with Hexagon. Each one registers itself (adapter-registry.ts) from its own file;
// importing it here is what makes it available. A third-party integration imports `registerAdapter` and calls it.
import "./claude-code.js";
import "./codex.js";
import "./exec.js";
import "./grok.js";
import "./mock.js";

export { adapterNames, createAdapter, defaultAgents, migrateAgentEntry, primaryAgentId, registerAdapter, type AdapterFactory, type AdapterMeta } from "./adapter-registry.js";
