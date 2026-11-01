# Hexagon

A terminal dashboard that runs several coding agents in parallel on one goal. The agents are
Claude Code (or any other coding CLI), each in its own git worktree.

- **Chat with Claude by default.** Ask questions or ask for changes; Claude works directly
  in your repository, like Claude Code.
- **Spec-driven development when you want it.** `/sdd <goal>`: a planner agent writes a
  short spec and a task graph, and you approve it with Enter (or say what to change).
  Agents then implement the tasks in parallel. Hexagon re-runs each task's verify commands,
  a reviewer agent checks the diff, and the work is merged into an integration branch.
  `/merge` brings it into your branch.
- **Wraps agent CLIs, no API integration.** Each agent is a real `claude -p` session
  (stream-json), so it uses your Claude Code login, tools, CLAUDE.md and settings. Agents
  report back by running plain shell commands (`hexagon report|ask|note|done`). Any other
  non-interactive CLI can be plugged in with `adapter = "exec"`.
- **See everything.** A full-screen dashboard shows:
  - a live **agent network**: square cards joined by edges, each with its own review
    footer (not reviewed / in review / changes requested / approved) and an integration hub, animated only by real events (see [docs/TUI.md](docs/TUI.md));
  - an **agent navigator** grouped by role (analysis, implementation, review, integration)
    with provider, CLI, version, model, state and progress, plus an inspector and an
    activity timeline;
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

cd ~/projects/your-repo                      # any folder; Hexagon sets up git if needed
hexagon init                                 # writes HEXAGON.md (an agent studies existing code)
hexagon                                      # dashboard: chat with Claude, or /sdd <goal>
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
  chat with Claude: ask about the project or the run, or ask for a change and it makes it
    directly in the repo. `/sdd <goal>` starts the spec-driven multi-agent flow. On an
  agent's tab it goes to that agent (or answers its question). Replying to a
  blocked or failed agent continues its own session ("mvn is installed now, try again").
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
hexagon sdd "add GET /health returning the git sha"    # planner → draft spec + plan
hexagon run --follow                                   # approve and stream the run
hexagon status · hexagon tell T-2 "…" · hexagon answer Q-1 2 · hexagon takeover T-2 · hexagon merge
```

To try it all offline at no cost, set `agent = "mock"` for every role in `.hexagon/config.toml`.

## A full session, start to finish

This builds a small Java service from an empty folder. The same steps work in an
existing repository; `hexagon init` then studies the code instead of writing a stub.

**1. Set up the project.**

```bash
brew install openjdk@21 maven        # the tools your project needs, so agents can build and test
mkdir ~/projects/hello && cd ~/projects/hello
hexagon init
```

```
✔ created .hexagon/config.toml, .hexagon/roles/…, specs, .gitignore (updated)
✔ initialized a git repository and made the initial commit (agents work in git worktrees)
✔ empty repository: wrote a stub HEXAGON.md (filled in as code lands)
```

Hexagon never asks what you're building. An empty repo gets a stub brief, and whoever
writes the first code fills it in. If you already know the stack, say it up front:
`hexagon init "Spring Boot 3 REST service, Java 21, Maven"`.

**2. Small changes: just chat.** Run `hexagon` and type on the `claude` tab:

```
› you      Create a Spring Boot 3 project with Maven: GET /hello?name=X returns "Hello, X!"
           (default World), with a MockMvc test. Update HEXAGON.md with the commands.
◆ claude   Created pom.xml, HelloApplication, HelloController and HelloControllerTest;
           filled in HEXAGON.md. `mvn -q test` passes (2 tests).
           ⌁ 18k in · 1.2k out
```

Claude works directly in the repository, like Claude Code. Review the change with
`git diff`, then commit it yourself.

**3. Bigger work: spec-driven development.** Use it when a goal splits into parts that
agents can build in parallel:

```
/sdd Add a /greetings REST resource (CRUD, in-memory store), input validation with
     400 errors, and a README section on how to run it
```

- The planner (`planner` tab) writes `specs/<name>.spec.md` (requirements with acceptance
  criteria) and a task graph. The graph appears at the top as a **draft plan**.
- Read it with `/spec` and `/plan`. To change it, type feedback on the `planner` tab
  ("merge T-3 into T-2"). The planner revises the draft.
- Press **Enter** on an empty input (or `/run`) to approve it. You can also limit
  parallelism with `/run -j 2`.

**4. Watch and steer the run.**

- **The graph is a molecule.** Each task is a hexagon, and its bottom edge fills as a
  progress bar through work → verify → review → merge. Working agents pulse, with an
  electron orbiting them, and electrons flow along the bonds into them. Finished links
  become double bonds (`════▸`), and queued tasks have dashed outlines.
- **Agents list:** one card per agent: its task name, progress bar, tokens, current
  step, the task's stack (`Java · Spring Boot · Maven`) and the tools it has used
  (`⚒ mvn×3 edit×5`). Tab or ↑↓ selects an
  agent, and the right panel shows your chat with it.
- **Message an agent:** type while it works ("use records for DTOs"). The message
  arrives at its next step and shows `✓ received`.
- **Questions:** an agent may ask one (`? Q-1 …`, the chip says `answer Q-1`). Type the
  answer, or an option number.
- **Do it yourself:** Ctrl-T takes over the agent's Claude session in its worktree. Exit
  it to hand the task back.

**Areas of responsibility.** Each task owns its write scope, and every agent sees which
task owns what. Suppose an agent finds a defect in another task's code, e.g. the tester
finds a bug in T-1's handler. It doesn't fix it; it runs
`hexagon return T-1 "<what's wrong, with evidence>"`. Then:
- T-1's agent is reopened in its own session with the report.
- T-1's fix goes through verify, review and merge again.
- The returning agent waits, gets the fix merged into its worktree, and carries on.

**5. When an agent gets stuck.** An agent that can't finish (a missing tool, an unclear
spec) stops as `⊘ blocked` and explains why in its chat. Fix the cause, then reply on its
tab:

```
continue T-2  › maven is installed now, run the tests again
```

It continues in the same session and worktree. `/retry T-2` instead starts a fresh
attempt, optionally with `--effort high` or `--agent <other>`.

**Missing tools.** If agents need a toolchain that isn't installed, Hexagon says so. Run
`/install go` (also `node`, `java`, `maven`): it downloads the official release into
`~/.hexagon/toolchains`, without Homebrew or sudo. Agents and verify commands get it on
their PATH, and agents that were blocked on it continue.

**Agents, providers and models.** Each role is served by an *agent*: a provider's coding CLI
(`claude-code`, `codex`, `grok`, any `exec` wrapper, or your own adapter). Hexagon ships **no model
names**. Unless you override one, every CLI keeps using its own configured default, and the dashboard
shows the model the running process *reports* (or "CLI-managed" when it does not say).
`hexagon agents list|doctor` shows executables, versions, auth and capabilities;
`hexagon agents models <agent>` lists models only when that CLI can; `hexagon agents configure`
walks through role → agent → model; `/model <role> <identifier|default>` sets or clears an opaque override.
See [docs/PROVIDERS.md](docs/PROVIDERS.md).

**Provider limits don't fail tasks.** Rate limits, usage quotas, context overflow and truncated output
are classified and handled separately; the task waits (`waiting_quota`) and resumes by itself, also after
a daemon restart. They never consume a fix cycle or an attempt. See [docs/RECOVERY.md](docs/RECOVERY.md).

**6. Merge.** Each finished task has passed verification and review and is already merged
into the run's integration branch, `hexagon/<run>/integration`. When the run ends:

```
/diff T-1              # any task's changes (or Ctrl-D)
/merge                 # merge the integration branch into your branch
```

Then run the tests once more on your branch and push. A merged run is closed and leaves
the dashboard. `/clean` removes its worktrees, and `/close` hides a finished run without
merging it.

**The same flow without the dashboard:**

```bash
hexagon chat "add a /health endpoint returning the git sha"   # direct change by Claude
hexagon sdd "greetings CRUD resource with validation"           # draft spec + task graph
hexagon run --follow                                           # approve and stream the run
hexagon status                                                 # table of agents, tokens, states
hexagon tell T-2 "maven is installed now, run the tests again" # message (or continue) an agent
hexagon answer Q-1 2                                           # answer a question
hexagon merge                                                  # integration branch → your branch
```

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
- **Approvals:** when an agent (or Claude in the chat) is refused a command, you get a
  request (`⚠ P-1 T-2 wants to run \`brew install go\``) on its tab. Answer `1` to
  allow that command prefix for this project, `2` to allow all commands, or `3` to deny.
  The agent restarts in the same session with the new rule and runs it again. A blocked
  agent continues too. CLI: `hexagon answer P-1 1`.
- **Allow ahead of time:** `/allow brew curl` (or `/allow "git push"`) lets agents run
  those commands from now on. `/allow all` lets them run anything, including outside the
  project folder. Read-only probes (`which`, `command -v`, `go version`, `ls`, `cat`,
  `git status`…) are always allowed. When a compound command is refused, the approval
  covers just the refused part.
- Agents use the tools installed on your machine (`go`, `mvn`, `node`…). They don't
  install toolchains behind your back. Install a missing one yourself, or approve the
  agent's install command.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture and design
- [docs/PROVIDERS.md](docs/PROVIDERS.md): providers, model handling, configuration, implemented vs planned
- [docs/ADDING_PROVIDER.md](docs/ADDING_PROVIDER.md): integrate another CLI (with a tested example)
- [docs/RECOVERY.md](docs/RECOVERY.md): provider-limit recovery, fix cycles, restart behaviour
- [docs/COMMUNICATION.md](docs/COMMUNICATION.md): messaging, status contract, attach and takeover
- [schemas/](schemas/): JSON Schemas for agent status, messages, plans and results

## Development

```bash
npm run install:bin   # build the standalone executable (Node SEA) and install it
npm run build         # tsc → dist/
npm test              # unit + end-to-end (mock agent, real git worktrees)
```
