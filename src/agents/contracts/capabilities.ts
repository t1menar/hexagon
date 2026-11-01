/** What an integration can actually do. Declared per adapter; never assumed uniform across providers. */
export interface AgentCapabilities {
  supportsStreaming: boolean;
  supportsSessionResume: boolean;
  supportsLiveInput: boolean;
  supportsInteractiveTakeover: boolean;
  /** The CLI has a way to list the models it currently offers. */
  supportsModelDiscovery: boolean;
  /** The CLI's output names the model that is actually serving the request. */
  supportsRuntimeModelReporting: boolean;
  supportsUsageMetrics: boolean;
  supportsStructuredOutput: boolean;
  /** Tool/command permissions are enforced by the CLI itself (not only by Hexagon's worktree isolation). */
  supportsNativePermissions: boolean;
}

export const NO_CAPABILITIES: AgentCapabilities = {
  supportsStreaming: false,
  supportsSessionResume: false,
  supportsLiveInput: false,
  supportsInteractiveTakeover: false,
  supportsModelDiscovery: false,
  supportsRuntimeModelReporting: false,
  supportsUsageMetrics: false,
  supportsStructuredOutput: false,
  supportsNativePermissions: false,
};

export function capabilities(over: Partial<AgentCapabilities>): AgentCapabilities {
  return { ...NO_CAPABILITIES, ...over };
}

/** What the integration itself enforces. Hexagon's worktree isolation applies to every agent regardless. */
export interface SecurityCapabilities {
  /** Read-only execution is enforced by the CLI (tool denial or sandbox), not just requested in the prompt. */
  readOnlyEnforced: boolean;
  /** Shell commands are limited to an allow-list by the CLI. */
  commandAllowList: boolean;
}
export const NO_SECURITY: SecurityCapabilities = { readOnlyEnforced: false, commandAllowList: false };
