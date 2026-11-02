# Security model

Hexagon treats every agent as untrusted input. This page says what that protects against and what it does not.

## What is enforced, and by whom

| Guarantee | Enforced by | How |
|---|---|---|
| An agent cannot approve a spec, answer a question, merge, change permissions or start runs | Hexagon daemon | Every RPC call carries a token. Agents get a per-agent token in `HEXAGON_TOKEN`; the user's token is a file. `src/daemon/auth.ts` lists every method's scope (`open`, `any`, `user`); a method without a scope is refused, and `test/security.test.ts` fails until each new method has one. An agent's identity comes from its token, never from the request. |
| The socket is not world accessible | OS | `chmod 0600` on the Unix socket. |
| Agents do not get your shell's secrets | Hexagon | The agent process environment is an allow-list: `PATH`, `HOME`, locale, terminal, proxy/CA settings, the integration's own login variables, and `env_passthrough` from `[agents.x]`. |
| Interpreters and shells are not pre-approved | Config defaults | `sh`, `node`, `python`, `make`, `npx`, `find` and `printenv` are not in the default allow-lists. The commands a task's verify steps need are asked about once, before the task starts. |
| Write scope | Hexagon | Checked on everything the agent changed, committed or not. Out-of-scope paths are reverted. Commits the agent made itself are folded into one Hexagon commit. |
| Secrets are not written to events, transcripts, status or the bus | Hexagon | `src/util/redact.ts`, applied at the single JSON write path. Known key shapes only (cloud/API keys, tokens, PEM keys, URL credentials, `KEY=value` lines). |
| Command allow-list, read-only roles | The agent's own CLI | Only integrations that declare it (`hexagon agents doctor` shows which). |

## What is not enforced

- **There is no OS sandbox.** The user's token is a file with mode 0600 in `~/.hexagon-state/tokens/` (override with `HEXAGON_STATE_DIR`). A process running as the same user can read it, and can read your files. The token stops confused or prompt-injected agents, not a determined attacker. For that, run agents in a container or VM.
- Allowed build and test tools (`npm`, `go`, `cargo`, …) run project code, which can do anything the project can. The allow-list reduces prompts; it is not a jail.
- Reading `.env*` is refused by deny rules only where the integration passes them to its CLI. This has not been verified against the real CLI.
- Redaction misses secrets whose shape it does not know.
- On macOS the permission bits of a Unix socket may not be enforced for connect; the token is the real control.

## Existing configs

A `config.toml` written before these defaults may allow `sh`, `node`, `python`, … Hexagon keeps your list and warns about each entry in `hexagon up` and `hexagon agents doctor`. It never narrows it for you.

## Reporting

See the repository's `SECURITY.md` once it exists (Phase 7).
