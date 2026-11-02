import { classifyError, probe, probeVersion, whichExecutable, type AdapterDiagnostics } from "./adapter.js";
import { NO_SECURITY, type AgentCapabilities, type SecurityCapabilities } from "./capabilities.js";
import type { ClassifiedError } from "./errors.js";
import { agentProcessEnv } from "./env.js";
import { CLI_DEFAULT, overrideOf, type ModelDiscoveryResult, type ModelSelection } from "./model-selection.js";

/** Shared behaviour for CLI-backed integrations. Subclasses add only what is specific to their CLI. */
export abstract class AdapterBase {
  abstract readonly adapterId: string;
  abstract readonly provider: string;
  abstract readonly displayName: string;
  abstract readonly capabilities: AgentCapabilities;
  /** Policy enforcement this CLI really provides; the default claims nothing. */
  readonly security: SecurityCapabilities = NO_SECURITY;

  /** Environment variables the CLI needs to log in (names or `PREFIX_*`). Everything else is withheld from the agent process. */
  protected readonly authEnv: readonly string[] = [];
  /** [agents.x].env_passthrough: extra variables the user chose to hand over. */
  envPassthrough: string[] = [];
  protected processEnv(ctxEnv: Record<string, string>): Record<string, string> { return agentProcessEnv(ctxEnv, this.authEnv, this.envPassthrough); }

  constructor(readonly id: string, protected command: string[], readonly selection: ModelSelection = CLI_DEFAULT) {}

  get model(): string | null { return overrideOf(this.selection); }
  get supportsLiveInput(): boolean { return this.capabilities.supportsLiveInput; }

  /** Arguments that select a model. Empty when no override exists: the CLI keeps its own default. */
  protected modelArgs(flag = "--model"): string[] {
    const m = this.model;
    return m ? [flag, m] : [];
  }

  /** Subclasses that can ask their CLI who is logged in override this. */
  protected async authStatus(): Promise<Pick<AdapterDiagnostics, "auth" | "authDetail">> {
    return { auth: "unknown", authDetail: "this integration cannot query authentication state" };
  }

  async detect(): Promise<AdapterDiagnostics> {
    const executable = await whichExecutable(this.command[0]!);
    const problems: string[] = [];
    if (!executable) {
      problems.push(`\`${this.command[0]}\` was not found on PATH — install ${this.displayName} or set command = ["/path/to/${this.command[0]}"]`);
      return { installed: false, executable: null, version: null, auth: "unknown", problems };
    }
    const { version } = await probeVersion(this.command.slice(0, 1));
    const a = await this.authStatus();
    if (a.auth === "unauthenticated") problems.push(a.authDetail ?? `${this.displayName} is not logged in`);
    return { installed: true, executable, version, ...a, problems };
  }

  async discoverModels(): Promise<ModelDiscoveryResult> {
    return { supported: false, diagnostic: `${this.displayName} exposes no model listing; Hexagon uses the CLI's own configuration. A custom identifier can still be supplied.` };
  }

  classifyError(text: string): ClassifiedError { return classifyError(text); }
}

export { probe };
