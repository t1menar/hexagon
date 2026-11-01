# Adding a CLI provider

> Just want to use another CLI without writing code? Use the generic `exec` adapter: see [Adding another coding CLI](../README.md#adding-another-coding-cli). This page is for writing a full adapter.

A new integration is one class plus one `registerAdapter` call. The scheduler, supervisor, recovery and TUI only see the `AgentAdapter` contract. A complete, tested example is [`examples/acme-provider.ts`](../examples/acme-provider.ts) (exercised by `test/providers.test.ts`).

## 1. Architecture

```
config [agents.x] ──► registry.createAdapter ──► AgentAdapter ──► AgentRun (supervisor)
                                                   │ run(ctx) → events (AgentHost.emit) + outcome
                                                   │ detect() / discoverModels() / classifyError()
```
Contracts: `src/agents/types.ts` (`AgentAdapter`, `AgentRunContext`, `AdapterOutcome`), `src/agents/contracts/` (`capabilities`, `model-selection`, `errors`, `adapter`, `base`).

## 2. Pick a base

* One process per invocation, output on stdout: extend `OneShotAdapter` (`src/agents/oneshot.ts`). It spawns with an argument array and `shell:false`, writes the prompt to stdin, kills the process group on abort, splits stdout into lines across arbitrary chunk boundaries, keeps stderr, and attaches raw output to failures for classification.
* Long-lived streaming session (like Claude Code): extend `AdapterBase` and implement `run()` yourself (see `claude-code.ts`).

## 3. What to implement

| Concern | How |
|---|---|
| Identity | `adapterId`, `provider` (vendor label), `displayName` |
| Executable + version | `AdapterBase.detect()` looks up `command[0]` on PATH and runs `--version`; override the flag via `probeVersion` if different |
| Auth | override `authStatus()` to call the CLI's own status command; return `unknown` if there is none |
| Capabilities | `capabilities({...})`: set only what you implemented and verified; unset means false |
| Model discovery | override `discoverModels()` only if the CLI has a listing command; otherwise inherit `{supported:false}`. Never return a hardcoded list |
| Native default | use `this.modelArgs("--flag")`: empty when the user chose nothing, so the CLI keeps its default |
| Overrides | the string from `model = "…"` arrives via `selectionFrom(...)`; treat as opaque |
| Prompt transport | `OneShotSpec.stdin` for the prompt; if the CLI only takes an argument, put it as a single argv element, never in a shell string |
| Streaming | `onLine(line, ctx)` → `ctx.host.emit({type:"chat"|"tool_call"|"progress"|"usage"|"model", …})`; ignore malformed lines |
| Runtime model | emit `{type:"model", model}` only if the CLI reports it |
| Sessions | `ctx.sessionId`, `ctx.resume`, `ctx.followUp`; if the CLI has resume, use it, else set `supportsSessionResume:false` |
| Cancellation | handled by `OneShotAdapter` (process group SIGTERM on `ctx.signal`) |
| Security | `ctx.readOnly`, `ctx.allowCommands`; map to native flags if they exist and set `security = {readOnlyEnforced, commandAllowList}` honestly (default claims nothing) |
| Errors | return `{kind:"error", error:{kind, message, retryable, raw}}` with the CLI's raw text in `raw`; Hexagon classifies it (rate limit, quota, context, auth, …) and recovers |
| Protocol | the agent reports back by running `hexagon report|done|review|…` (documented in the system prompt); you only need to let it run shell commands |

## 4. Register and configure

```ts
registerAdapter("acme", (id, conf, override) => new AcmeAdapter(id, conf.command ?? ["acme"], selectionFrom(override || conf.model)));
```
Import the module once at daemon start (built-ins are registered in `src/agents/registry.ts`). Then:

```toml
[agents.acme]
adapter = "acme"
provider = "acme-corp"
command = ["/opt/acme/bin/acme"]
[roles.implementer]
agent = "acme"
```
Unknown adapter names fail at config load with the list of available ones.

## 5. Tests

Use a fake CLI script (see `fakeCli` in `test/providers.test.ts`): record argv/stdin, answer `--version`/`models`, print JSONL split mid-line, fail with provider-style messages. Assert: no `--model` without an override, override passed verbatim, prompt only on stdin, partial chunks parsed, errors classified, abort kills the process, `detect()` on a missing binary reports `installed:false`.

## 6. Troubleshooting

* `unknown adapter` — the module that calls `registerAdapter` was not imported before config load.
* Task fails instantly with "cannot start" — `command[0]` not on the daemon's PATH; use an absolute path.
* Rate limits treated as failures — put the CLI's stderr/stdout text in `error.raw`; classification reads that.
* Dashboard shows "CLI-managed" — the CLI did not report a model, or you did not emit a `model` event. Hexagon never guesses.
