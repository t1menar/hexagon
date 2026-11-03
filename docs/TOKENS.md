# Tokens: where they went, what changed

Hexagon used to start a cold CLI session for every task attempt and for every review pass, and each cold start re-sent
the role prompt, protocol, skills, a 200-path file list and the whole task card. This page records what was changed,
what it saves, and what is still open. Numbers are labelled **measured** (reproducible with the commands shown) or
**modelled** (the mock agent's accounting).

## Sessions: one per agent identity

An *agent identity* is a role slot: `implementer-1`, `reviewer-1`, … (`src/core/sessions.ts`). A session cannot run in
two processes at once, so tasks that run in parallel get different identities; tasks that run one after another reuse
the first free one. Each identity has one session record in `.hexagon/sessions/<agent-id>.json`
(`nativeSessionId`, turns, context size, compactions, token ledger by cause, what it was already told), plus an
append-only `.hexagon/sessions/events.jsonl` with the reason for every new session.

A new session is created **only** when: the identity has none; its adapter, model or prompt hash changed; the adapter
cannot resume (or cannot resume from another directory); the user reset it; or the session was compacted. Each of
these is logged with its reason. A retry, a fix loop, a review pass, a user message, a quota wait and a daemon
restart all resume the same session.

**Worktrees.** Each task still has its own worktree. Whether a session can follow it depends on the adapter:
`capabilities.resumeAcrossCwd`. Claude Code declares `true` (verified: `claude --resume <id>` from another directory
continued the session, CLI 2.1.316). An adapter that declares `false` gets one session per (identity, directory); the
registry says so in the event reason. It never falls back silently.

**UI.** The inspector shows `Session: implementer-1 · resumed, turn 6` and `Context: ctx 37% (~2.6k) ▸ compacted ×1`.
"new session" appears only when a session was really created; the CLI's per-start `session started` notice is no
longer shown.

## Compaction

`[context]` in `config.toml`: `mode` (`auto`/`manual`/`off`), `compact_at` (default 0.70 of the window),
`min_turns_between`, `assumed_window_tokens` (no adapter reports its window yet). Before each turn, at a point where
no process is running (so never mid tool call), `shouldCompact()` decides. Hexagon then asks the same session for a
350-word structured summary (decisions, done, open, gotchas), starts a fresh native session, and seeds it with the full
task card, the summary and the **pinned context rebuilt from files and state**: changed files, finished acceptance
criteria, outstanding review/verify feedback, and recent shared notes. `/compact [agent|T-n]` and `hexagon compact`
force it. The existing overflow path (`recovery.max_context_recoveries`) is the emergency fallback.

`supportsNativeCompaction` is `false` for every shipped adapter: `/compact` sent to Claude Code in stream-json mode
did not complete when probed, and the other CLIs are unverified, so Hexagon-driven compaction is used everywhere.

Fixed on the way: after an overflow the old code started a new session but the adapter only sent the task card, so the
"compacted context" never reached the agent. A fresh session in the middle of a task now always gets card + pinned
context + the pending message.

## Audit

| Leak | Change | Before → after |
|---|---|---|
| Cold session per task attempt | identity session reuse | 4-task chain, fresh input tokens 22,960 → 5,708 (**modelled**, below) |
| Cold session per review pass | reviewer identity reuse | included above |
| 200-path file list in every system prompt | directory summary + "use your search tools" | 3,406 → 1,589 tokens in a 300-file repo with a long HEXAGON.md (**measured**, `projectContext`) |
| Unbounded `HEXAGON.md` | capped at 6,000 chars, pointer to the file | included above |
| Run id and per-task skills in the system prompt | removed; requested skills travel in the task card once per session | prefix is byte-stable per identity |
| `<other_tasks>` and blackboard notes re-sent each attempt | sent only when changed / only new note lines (cursor per run) | resumed turns carry deltas |
| Reviewer prompt: 60 KB diff + pretty-printed report | diffstat + 24 KB diff with an explicit pointer for the rest; compact report without `files_changed` | up to 36 KB less per review |
| Fix loop: up to 12 KB of log | 6 KB head+tail; every truncation is recorded on the timeline | up to 6 KB less per loop |
| `<hexagon_state>` on every chat message | sent only when it changed; volatile fields (token total, activity) removed | not measured |
| Nudges / heartbeats / progress | heartbeats and progress never reach the model. The "you ended your turn without `hexagon done`" nudge (max 2) remains: it is how a stopped agent is prompted to report | unchanged |
| Effort defaults | `init` and `lead` default to `low` | Hexagon ships no model names, so cheap-model defaults are the user's `[roles.<r>] model` |

## Ledger

Every usage event carries a cause: `prompt`, `fix_loop`, `review`, `compaction`. They are summed per attempt
(`usage_by_cause` in the agent status), per run (`ledger` in `run.status` / `hexagon status --json`) and per agent
identity over the project's life (`.hexagon/sessions/*.json`). `hexagon stats [--json]` prints them. The numbers stay
on the machine (see the personal-only metrics decision).

## Benchmark

`scripts/token-bench.ts`: 4 chained tasks, mock agent, a 300-file repository with a 3 KB `HEXAGON.md`. The mock
models the real shape of token use: a cold session pays for its whole prompt, a resumed session pays for the new
message and re-reads the cached conversation. `master` was run with the same mock accounting patched in.

| | fresh input | cached re-reads | output | fresh + 0.1 × cached |
|---|---|---|---|---|
| master | 22,960 | 39,024 | 3,120 | 26,862 |
| this branch | 5,708 | 58,510 | 3,120 | 11,559 |

Fresh input falls 75 %; weighting cached reads at 10 % of a fresh token, the cost proxy falls 57 %. **Total tokens
processed do not fall** (65,104 → 67,338): a resumed session re-reads a longer conversation, which is why compaction
exists. Caveat: the mock does not model provider-side prefix caching across cold sessions, which would make master's
cold starts cheaper than modelled, so real savings are smaller than these. A run on a real CLI is still to be done.

## Open

* The chat/assistant, planner and init sessions use the registry (reuse, ledger, `session` info) but are **not**
  compacted proactively: their process stays open between messages, so there is no turn boundary to compact at.
  Overflow recovery still applies.
* No adapter reports its context window; `assumed_window_tokens` is used.
* The per-agent token gauge in the agent list is not drawn yet (the inspector shows it).

## Prompt diet (measured)

`scripts/prompt-sizes.ts` prints the system prompt per role (role prompt + protocol + skills + the capped HEXAGON.md of a
sample project, 2,899 chars) and the per-turn task card (`esbuild scripts/prompt-sizes.ts --bundle --platform=node
--format=esm --outfile=dist/tools/ps.mjs && node dist/tools/ps.mjs`). Characters; tokens ≈ chars / 4.

| Role | Before (chars) | After (chars) | Change |
|---|---|---|---|
| developer, identity only (role + protocol + skills) | 7,465 | 4,991 | −33% |
| developer, with the sample HEXAGON.md | 10,364 (≈2,591 tok) | 7,894 (≈1,974 tok) | −24% |
| qa | 10,189 | 8,146 | −20% |
| devops | 9,738 | 7,695 | −21% |
| security | 9,842 | 7,799 | −21% |
| architect | 9,281 | 7,395 | −20% |
| release | 9,243 | 7,200 | −22% |
| control | 7,956 | 7,033 | −12% |
| reviewer | 5,859 | 5,984 | +2% (it now checks the diff against the brief) |
| task card, minimal developer task | 485 (≈121 tok) | 485 | unchanged |

What moved: `bus` details, `exec`/`install`/`sudo` and `scope request` are now one line each in the protocol and the rest
sits behind `hexagon help bus|exec|scope` (`HELP_TOPICS` in `src/agents/protocol.ts`; an agent reads one only when it needs
it). `scope-discipline` is merged into the developer role (devops/security keep the skill), `commit-conventions` is one line,
the duplicated "ask only if…" and "be honest" text is gone, and the analyst stage prompts in `orchestrator.ts` point to the
analyst role instead of restating its section list. Added: the reviewer checks the diff against the brief, and "read your brief
and the handoffs before code" for restarts. The prefix stays byte-stable per identity (the golden prompts in
`test/golden/prompts` pin it; `test/prompts.test.ts` asserts the key developer rules are still present).
