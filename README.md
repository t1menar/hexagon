# Hexagon

Terminal orchestrator for spec-driven development with multiple AI coding agents
running in parallel.

- **Specs are the source of truth.** Markdown requirements with acceptance criteria are
  planned into a task DAG. Each task is implemented in an isolated git worktree, then
  verified, reviewed and merged.
- **Interactive shell.** Run `hexagon` and drive everything with slash commands. You can
  focus, message, attach to or take over any agent, each in its own terminal if you like.
- **Status contract.** Every agent publishes a schema-validated `status.json`, written
  atomically by a single writer, so any console or script can follow along.
- **Reusable skills.** Versioned markdown workflow instructions are compiled into each
  agent's prompt.
- **Personal metrics.** Agent usage and output quality are recorded locally for your own
  analysis. Nothing is exported.

## Quick start

Requires git. Building needs Node ≥ 22; the resulting binary does not.

```bash
git clone git@github.com:t1menar/hexagon.git && cd hexagon
npm install
npm run install:bin        # builds a standalone ./build/hexagon and copies it to ~/.local/bin
#   or: npm run build:bin  (binary only)   ·   npm run build && npm link  (dev: runs from dist/)

cd ~/projects/your-repo                      # a git repo with at least one commit
hexagon init                                 # creates .hexagon/ (config, roles, skills) and specs/
$EDITOR specs/feature.spec.md                # write a spec (format below)
hexagon                                      # open the shell
```

Inside the shell:

```
/spec lint                 validate specs
/plan                      planner turns specs into tasks (saved to .hexagon/plans/)
/run                       start: agents work in parallel, each in its own worktree
/focus T-2                 plain text now goes to T-2 …
please also handle the empty-password case
/inbox · /answer Q-1 2     answer agents' questions
/attach T-2 · /open T-2    live view here, or in a new terminal (tmux / iTerm / Terminal)
/takeover T-2              pause the agent and get a shell in its worktree
/merge                     merge the run's integration branch into your branch
```

Claude agents use `claude-sonnet-5-5` and find credentials through the Anthropic SDK
(`ANTHROPIC_API_KEY`, or a profile from `ant auth login`). To try the whole workflow
offline, set `agent = "mock"` for the roles in `.hexagon/config.toml`.

### Spec format

```markdown
---
spec: auth
---
# Authentication

## REQ-AUTH-001: Password login
Users log in with email + password and receive a session cookie.

**Acceptance**
- AC-1: Valid credentials → 200 with an HttpOnly session cookie
- AC-2: Invalid credentials → 401, generic message

**Touches**: `src/auth/**`
```

## How a run works

```
spec → planner → task DAG → for each ready task (respecting deps, file leases, -j N):
  worktree ← integration branch → agent implements → out-of-scope changes reverted → commit
  → verify commands re-run by Hexagon → reviewer agent → merge into hexagon/<run>/integration
→ /merge integration branch into your base branch
```

Failed attempts are retried with one step more effort, and a fix loop runs when
verification or review fails. A task's dependents are blocked if it can't complete.
Spending pauses the run at `budget_usd`.

## Status

v0.1 has the following:

- Daemon with a JSON-RPC Unix-socket API, plus `status.json` / `run.status.json` /
  `events.jsonl` / `messages.jsonl`. Contracts are in `schemas/`.
- Spec parser and linter, plan validation, scheduler, supervisor, retries and budget.
- Claude adapter. It streams the Messages API with adaptive thinking, effort per role,
  prompt caching, refusal fallback, and an append-only transcript.
- Mock adapter for offline runs.
- Messaging: user → agent instructions delivered at safe points and acknowledged, blocking
  and non-blocking questions, blackboard notes, change requests, and the Lead
  (`@lead …`).
- Shell with slash commands, completion, history, focus cycling, attach, open-in-terminal
  and takeover.

Not built yet:

- Adapters for Claude Code (Agent SDK), the OpenAI CLI and DeepSeek.
- A full-screen dashboard.
- `hexagon resume` after a daemon restart.
- An agent that resolves merge conflicts.
- Personal metrics analysis (`stats` beyond per-run totals, ratings).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture and implementation plan
- [docs/COMMUNICATION.md](docs/COMMUNICATION.md): messaging, the agent status contract,
  the shell, and attach/takeover
- [schemas/](schemas/): JSON Schemas for agent status, messages, plans and results

## Development

```bash
npm run build:bin  # standalone executable (Node SEA: esbuild bundle + embedded templates/schemas)
npm run build      # tsc → dist/
npm test           # unit + end-to-end (mock agent, real git worktrees)
```
