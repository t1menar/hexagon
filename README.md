# Hexagon

A terminal dashboard that runs several coding agents in parallel on one goal. The agents are
Claude Code (or any other coding CLI), each in its own git worktree.

- **One step from goal to running agents.** Type what you want. A planner agent writes a
  short spec and a task graph, and you approve it with Enter (or say what to change).
  Agents then implement the tasks in parallel. Hexagon re-runs each task's verify commands,
  a reviewer agent checks the diff, and the work is merged into an integration branch.
  `/merge` brings it into your branch.
- **Wraps agent CLIs, no API integration.** Each agent is a real `claude -p` session
  (stream-json), so it uses your Claude Code login, tools, CLAUDE.md and settings. Agents
  report back by running plain shell commands (`hexagon report|ask|note|done`). Any other
  non-interactive CLI can be plugged in with `adapter = "exec"`.
- **See everything.** A full-screen dashboard shows:
  - a live task graph (boxes and arrows, state per task);
  - the active agents, with what each is doing and the tokens it has used;
  - a **chat with the selected agent**: its replies, your messages (✓ once received),
    Hexagon's instructions, and its tool steps folded into compact lines.
- **Steer and take over.** Message any agent mid-task, answer its questions, pause it, or
  take over: you land in the same Claude Code conversation (`claude --resume`) in its
  worktree, and hand it back when you're done.
- **`hexagon init` runs an agent.** It studies the repository (or asks what you're
  building) and writes `HEXAGON.md`, the brief every agent reads first.
- **Status contract.** Every agent publishes a schema-validated `status.json`, so scripts
  can follow along too. Metrics are local and personal; nothing is exported.

## Quick start

Requires git and [Claude Code](https://claude.com/claude-code) (`claude` on your PATH,
logged in). Building needs Node ≥ 22; the binary doesn't.

```bash
git clone git@github.com:t1menar/hexagon.git && cd hexagon
npm install && npm run install:bin           # standalone binary → ~/.local/bin/hexagon

cd ~/projects/your-repo                      # a git repo with at least one commit
hexagon init                                 # an agent writes HEXAGON.md (commit it)
hexagon                                      # dashboard: type a goal, press Enter
```

```
⬡ HEXAGON  your-repo │ ⠙ running │ 1/3 done │ 412k tokens │ 18k out · 87% cached │ ⏱ 2m10s
╭─ Task graph ────────────────────────────────────────────────────────────────╮
│  ╭──────────────────────╮     ╭──────────────────────╮                      │
│  │ ✔ T-1 implementer    │     │ ⠙ T-2 tester         │                      │
│  │ Hello controller     │──┬─▶│ Smoke test script    │                      │
│  ╰──────────────────────╯  │  ╰──────────────────────╯                      │
│                            │  ╭──────────────────────╮                      │
│                            ╰─▶│ ? T-3 implementer    │                      │
│                               │ README run section   │                      │
╰─────────────────────────────────────────────────────────────────────────────╯
╭─ Agents ───────────────────╮╭─ Chat · T-2 · tester · claude (sonnet) ────────╮
│  ◆ claude  chat            ││ ⬡ hexagon  14:02                               │
│  ✔ T-1 implementer  161k   ││   Task T-2: Smoke test script (AC-1)            │
│▌ ⠙ T-2 tester       128k   ││ ◆ T-2  14:03                                    │
│▌   $ sh scripts/smoke.sh   ││   The jar builds; now starting the server…      │
│  ? T-3 implementer   97k   ││   ▸ $ mvn -q package                            │
╰────────────────────────────╯╰─────────────────────────────────────────────────╯
  to T-2  › also check /hello?name=Ann▏
```

**Keys:**
- **Typing** goes to whoever the chip before the input names. On the `claude` tab it is a
  chat with Claude: ask about the project or the run, or describe what to build and it
  starts the planner. On an agent's tab it goes to that agent (or answers its question).
- Metrics are tokens, not money: per run, per agent, and per model step in each chat
  (`⌁ 12k in · 310 out`).
- `/` opens commands and `@` mentions, with suggestions as you type (Tab or → to
  complete).
- **Tab** or **↑↓** switches agents.
- **Ctrl-T** takes over the selected agent, **Ctrl-O** opens it in a new terminal window,
  and **Ctrl-D** shows its diff.
- **Ctrl-C** twice leaves; the agents keep working in the background daemon.

Without the dashboard:

```bash
hexagon new "add GET /health returning the git sha"    # planner → draft spec + plan
hexagon run --follow                                   # approve and stream the run
hexagon status · hexagon tell T-2 "…" · hexagon answer Q-1 2 · hexagon takeover T-2 · hexagon merge
```

To try it all offline at no cost, set `agent = "mock"` for every role in `.hexagon/config.toml`.

## How it works

```
goal ─▶ planner agent ─▶ specs/<name>.spec.md + task graph ─▶ you approve
     ─▶ for each ready task (deps, file leases, -j N): worktree from the integration branch
        ─▶ `claude -p` session implements it, runs `hexagon done`
        ─▶ out-of-scope edits reverted ─▶ commit ─▶ verify commands re-run ─▶ reviewer agent
        ─▶ merged into hexagon/<run>/integration
     ─▶ /merge into your branch
```

- Failed attempts are retried with more effort.
- A failed verify or review sends the agent back into the same session with the output.
- The run pauses when its token use reaches `[run].budget_tokens` (0 = no limit).

**Agent permissions:**
- Edits are auto-accepted inside the worktree.
- Shell commands are limited to `[sandbox].allow_commands` (Claude Code
  `--allowedTools "Bash(<prefix>:*)"`). `hexagon init` adds what your project needs.
- `["*"]` allows everything (bypass mode).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture and design
- [docs/COMMUNICATION.md](docs/COMMUNICATION.md): messaging, status contract, attach and takeover
- [schemas/](schemas/): JSON Schemas for agent status, messages, plans and results

## Development

```bash
npm run install:bin   # build the standalone executable (Node SEA) and install it
npm run build         # tsc → dist/
npm test              # unit + end-to-end (mock agent, real git worktrees)
```
