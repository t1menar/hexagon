# Providers, agents and models

## Concepts (kept separate)

| Concept | Where it lives |
|---|---|
| Role (planner, implementer, reviewer, …) | `[roles.<role>]` → `agent = "<id>"` |
| Agent (a configured CLI) | `[agents.<id>]`: `adapter`, `provider`, `command`, `args` |
| Provider (vendor label) | `provider = "anthropic"`; defaults to the adapter's own |
| Adapter (integration code) | registered in `src/agents/registry.ts` |
| Model selection | optional `model = "…"` on the role or agent; absent = the CLI's default |
| Runtime model | what the process reports (`model` event); shown as **CLI-managed** when it does not |

```toml
[agents.analyst]   # example: assignment only, no model anywhere
adapter = "codex"
provider = "openai"
command = ["codex"]

[agents.dev]
adapter = "claude-code"
provider = "anthropic"

[roles.planner]
agent = "analyst"
[roles.implementer]
agent = "dev"
[roles.reviewer]
agent = "dev"
fallback_agent = "analyst"   # used only if [recovery].allow_provider_failover = true
```

Unknown adapter names, and roles that name an undefined agent, are configuration errors. There is no fallback to another provider.

## Models

* No catalogue and no identifiers are built in (a test scans `src/` and `templates/` for model names).
* `ModelSelection` is `cli-default` (nothing is passed) | `discovered` | `custom`. Identifiers are opaque strings handed to the CLI unchanged.
* `adapter.discoverModels()` returns `{supported:false, diagnostic}` unless the CLI has a listing command. Results are cached per adapter + executable + CLI version (10 min) and only successes are cached.
* Old configs with `model = "…"` keep working: the string is treated as a user-supplied custom override.

## Implemented vs planned

| Integration | Status |
|---|---|
| Claude Code (`claude-code`) | Implemented and used against the real CLI (stream-json, resume, native permissions, runtime model from `system/init`). Model discovery: **unsupported** (the CLI has no listing command). Auth: `claude auth status`. |
| OpenAI Codex (`codex`) | Implemented from the public CLI docs (`exec --json`, `-m`, `-s`, `-C`, `exec resume`). **Not run against the real CLI** (not installed here); tested with a mock CLI. Discovery unsupported (no documented listing command); runtime model not reported. |
| xAI Grok (`grok`) | Implemented from docs.x.ai (`-p`, `--output-format streaming-json`, `-m`, `--session-id/--resume`, `grok models`). **Not run against the real CLI**; tested with a mock CLI. `grok models` output format is undocumented, so parsing is best-effort. No documented read-only switch: it cannot review unless `allow_weaker_isolation = true`. |
| Generic (`exec`) | Implemented. Claims no discovery/usage/runtime-model support. |
| Environment-variable filtering, OS sandbox fallback | Planned. Today: worktree isolation (all), CLI-native permissions (Claude Code, Codex read-only), explicit authorization for weaker read-only isolation. |

## Security reporting

`hexagon agents doctor` prints, per agent, whether read-only execution and a command allow-list are enforced by the CLI. A reviewer on a CLI that cannot enforce read-only is refused unless `allow_weaker_isolation = true` is set under that agent. The same policy applies on resume after a limit and after failover.

## CLI

```
hexagon agents list | doctor           executables, versions, auth, capabilities, model selection
hexagon agents models <agent>          what the CLI reports (or why it cannot)
hexagon agents configure [role agent]  interactive menu, or set a role's agent
hexagon agents add <id> <adapter> [--provider P] [--command bin]
hexagon model [role identifier|default]
hexagon trace                          requirement → task → agent → verify → review → done
```
