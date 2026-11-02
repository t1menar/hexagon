# Adding an agent CLI (adapters)

Hexagon drives coding-agent CLIs through an **adapter**. You can add one without touching Hexagon's source: as a **manifest** (a data file, preferred) or as a **module** (code, when a manifest is not enough). Both load through `[plugins]`.

```toml
# .hexagon/config.toml
[plugins]
adapters = ["./adapters/acme.toml"]      # paths are relative to the project root; a package name also works

[agents.acme]
adapter = "acme"                          # the manifest's id
# command = ["/opt/acme/bin/acme"]       # optional: override the executable
# model = "whatever-your-cli-calls-it"   # opaque string handed to the CLI; Hexagon ships no model names

[roles.developer]
agent = "acme"
```

In-tree adapters (`claude-code`, `codex`, `grok`, `exec`, `mock`) are always there; plugins are additive and cannot replace them. A plugin that fails to load is named in `hexagon agents doctor` and in the "unknown adapter" error of any agent that needs it.

## The 15-minute path

```
hexagon agents scaffold acme            # adapters/acme.toml + fixtures + [plugins]/[agents.acme] in config.toml
$EDITOR adapters/acme.toml              # your CLI's flags and its JSON-line shape
hexagon agents record acme --yes        # runs the REAL CLI once (spends tokens), saves its output as a fixture
hexagon agents conformance acme         # replay checks, no tokens
hexagon agents conformance acme --real  # + read-only and "resume remembers"; on success records it as verified
hexagon agents doctor                   # plugin status, version, auth, what is enforced, verified or not
```

### "DeepSeek" (or any model) through Aider / OpenCode

Most setups are a general CLI plus a model string, not a new CLI. Write (or reuse) a manifest for the CLI and pass the model as data:

```toml
[agents.deep]
adapter = "opencode"                        # a manifest you wrote for the CLI
model = "<provider/model as that CLI spells it>"
```

Check the CLI's own docs for its non-interactive flag, its machine-readable output, and how it resumes; put exactly those in the manifest. Hexagon does not know or care which model sits behind it.

## Manifest reference

A complete, runnable example is [`examples/adapters/example.toml`](../examples/adapters/example.toml).

| Field | Meaning |
|---|---|
| `apiVersion = 1` | Required. A manifest for another version is refused with both versions named. |
| `id` | The name `[agents.x] adapter = "…"` uses. Lower-case letters, digits, `-`, `_`. Must not be a built-in. |
| `provider`, `display_name` | Labels. |
| `cli` | The executable (`command` in the agent entry overrides). Also what `HEXAGON_NO_REAL_CLI` guards in tests. |
| `auth_env` | Login variables the CLI needs (`NAME` or `PREFIX_*`). Everything else is withheld from the process, plus `[agents.x] env_passthrough`. |
| `[run].new` | Argv after the executable for a new session. |
| `[run].resume` | Same, for continuing a session. Needs a `session_handle` event rule, or the id Hexagon chose (`{session}`). |
| `[run].readonly_args` / `write_args` | Appended for read-only runs (reviewers) / write runs. |
| `[run].allow_args` | One group per allowed command prefix, `{rule}` = the prefix. Used only if `command_allow_list = true`. |
| `[run].prompt` | `stdin` (default), `file` (`{prompt_file}`, a private temp file removed afterwards) or `argv` (`{prompt}`: limited by ARG_MAX, visible in `ps`; the manifest must say so). Using `{prompt}` without `prompt = "argv"` is an error. |
| `[run].effort_map` | `{ low = "…", medium = "…", high = "…", max = "…" }` → `{effort}`. Unmapped = slot empty. |
| `[detect].version` / `auth` | Probe argv. Version is the first `x.y.z` in the output; auth: exit 0 = logged in, otherwise "unauthenticated". No `auth` = "unknown". |
| `[models].list` | Argv that prints one model per line. Omit if the CLI cannot list. |
| `[security]` | `read_only_enforced`, `command_allow_list`: **declare only what you verified.** `readonly_args` alone is a request, not enforcement. A reviewer on an adapter that does not enforce read-only is blocked unless the user sets `allow_weaker_isolation`. |
| `plain_output = "progress"` | Non-JSON lines become progress text (for a plain-text CLI). |
| `interactive` | Command for takeover (Ctrl-T). |

**Slots**: `{prompt_file} {prompt} {session} {model} {cwd} {hexagon_bin} {effort} {rule}`. A string or a `[group, of, strings]` that names a slot with no value is dropped as a unit: `["--model", "{model}"]` disappears when no model is set, so nothing is ever passed half-filled.

**Events** (`[[events]]`, one rule each; the first column is what Hexagon sees):

| `emit` | Fields (dotted paths into the JSON line) | Used for |
|---|---|---|
| `chat` | `text` | what the agent says |
| `tool_call` | `name`, `summary` | the activity feed |
| `session_handle` | `handle` | the CLI's own session id, stored and given back on resume |
| `model` | `model` | the model actually serving (shown instead of "CLI-managed") |
| `usage` | `input`, `output` (both required), `cache_read`, `cache_write`, `cost_usd`, `window` | token accounting. **Real numbers or nothing**: a line missing `input` or `output` emits no event; an unknown run is "unknown", not zero. |
| `error` / `progress` | `message` / `text` | shown as progress |
| `turn_end` | – | the CLI finished a turn and waits for input |

`when = { path = value }` limits a rule to lines where every pair matches. A rule without `when` applies to every line. Lines that are not JSON, or that no rule matches, are ignored (never an error).

## Module adapters (TypeScript/JavaScript)

When a manifest cannot express your CLI (live stdin, an unusual protocol), export a definition. A **function** export receives the SDK, so the module needs no import from Hexagon (the standalone binary has no `node_modules` to resolve one from):

```js
// adapters/acme.mjs   (ES module, no top-level await; Node >= 22.12)
export default (sdk) => sdk.defineAdapter({
  apiVersion: sdk.apiVersion,
  id: "acme",
  create: (agentId, conf, model) => new (class extends sdk.OneShotAdapter {
    adapterId = "acme"; provider = "acme"; displayName = "Acme";
    capabilities = sdk.capabilities({ supportsStreaming: true });
    build(ctx, prompt) { return { argv: [...this.command, "run", "--json", ...this.modelArgs()], stdin: prompt }; }
    onLine(line, ctx) { const e = sdk.safeJson(line); if (e?.type === "text") ctx.host.emit({ type: "chat", from: "agent", text: e.text }); }
  })(agentId, conf.command?.length ? conf.command : ["acme"], sdk.selectionFrom(model || conf.model)),
  meta: { cli: "acme" },
});
```

`sdk` gives `defineAdapter`, `AdapterBase`, `OneShotAdapter`, `LineBuffer`, `safeJson`, `probe`, `capabilities`, `NO_SECURITY`, `selectionFrom`, `classifyProviderError`. Inside the repository you can import `src/agents/sdk.ts` directly. `src/agents/manifest.ts` is a complete worked example of a `OneShotAdapter`.

### The contract

| Surface | Rule |
|---|---|
| `run(ctx)` | Returns an outcome (`finished`, `interrupted`, `error`), **never throws**. Abort → `interrupted`. A missing binary → `error`, `retryable: false`. |
| Events | `chat`, `tool_call`, `model`, `session_handle`, `usage`, `progress`, `turn_end`; see `AgentEvent`. Unknown lines never throw. |
| Prompt | Goes to stdin or a private file. In argv only if the adapter declares `promptInArgv = true`. |
| Environment | Only `PATH, HOME, locale, terminal, proxy` variables + `authEnv` + `env_passthrough` + `HEXAGON_*`. |
| Inbox | `ctx.host.drainInbox()` messages must reach the CLI, and `ctx.host.received(id)` is called when it has them (a live CLI acknowledges from its replay). |
| Usage | Real numbers or none. Never all-zero events. |
| Security | `security` and `project(policy)` state what the CLI enforces for the run. Claim nothing you did not enforce. `enforcedFor(adapter, policy)` is what the reviewer gate and doctor read. |
| Errors | `classifyError(text)` maps stderr/output to rate limit, quota, context, auth, … by text, never by model name. |
| Reporting | The agent reports by running `hexagon report|ask|note|done` in its shell: that is the source of truth. If it ends a turn without `hexagon done`, the **core** asks it (up to twice, same session) when the adapter can resume and has no live input; a live-input CLI is nudged in its own stream. |

## Conformance (what `hexagon agents conformance` checks)

Replay checks run the adapter against a tiny stand-in CLI that prints your fixtures (`test/fixtures/agents/<adapter>/<name>.jsonl` + `<name>.expect.json`) and records the argv, stdin and environment it received. `--real` adds the checks that need the real CLI.

| # | Check |
|---|---|
| 1 | detect: missing binary, version, auth |
| 2 | run never throws; abort → `interrupted`; missing binary → non-retryable error |
| 3 | protocol (`hexagon done` is accepted): **skipped**, covered by `test/turn-lifecycle.test.ts` |
| 4 | read-only: no claim, or (`--real`) edits fail |
| 5 | allow-list claim: skipped when claimed (only a real CLI can show it) |
| 6 | `session_handle` emitted; (`--real`) a resumed session remembers the first turn |
| 7 | this adapter's own fixtures parse (chat, tool_call, model); junk lines are survived; at least one fixture must expect a chat event |
| 8 | usage: no all-zero events; `usage: "none"` fixtures emit none |
| 9 | error fixtures classify (`exit` + `stderr` + `cls`) |
| 10 | inbox messages reach the CLI and are acknowledged |
| 11 | the process environment contains no variable outside the allow-list |
| 12 | the prompt is not in argv unless declared |
| 13 | no vendor model identifiers in the adapter's source (`// conformance-ok` on a line excuses it) |

`--real` success writes `<state dir>/verified.json` (`hexagon agents doctor` then shows "run against the real CLI x.y.z on DATE"). The in-tree list in the source is only a cache of the same facts.

The in-tree fixtures (`test/fixtures/agents/*`) are **synthetic** (see the README there): they prove each parser handles the shape it was written for, not that the real CLI still prints it. Known gaps are listed in `test/conformance-v2.test.ts` (`KNOWN_GAPS`).

## Not covered yet

* Live-stdin protocols other than Claude Code's stream-json (e.g. ACP): `OneShotAdapter` runs one process per message. A shared `StreamJsonAdapter` is not extracted yet; Claude Code still has its own loop.
* Per-run policy projection exists for Claude Code only; Codex, Grok and manifest adapters are judged by their static claim.
* Conformance check 3 (the real `hexagon done` round trip) and check 5 (command allow-list) need a real CLI and are not automated.
