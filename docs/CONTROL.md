# The Hexagon Assistant and the command API

The chat agent (session id `control`, role `control`) operates Hexagon; it does not edit your repository. Code changes are made by task agents in a plan.

## One command table

`src/core/commands.ts` defines every command once: name, kind (`read`, `mutate`, `destructive`) and typed parameters. From that table:

* the daemon executes them (`src/daemon/control.ts`);
* JSON-RPC exposes them: `command.exec`, `command.confirm`, `command.reject`, `command.list`;
* the CLI exposes them: `hexagon do <command> --param value`, `hexagon commands` (the reference);
* the assistant's system prompt includes the same reference, generated at start.

Unknown parameters, wrong types and missing parameters are errors, not ignored.

The analyst's pending questions are in the table too: `clarify.show` (read) and `clarify.answer` (`question_id` + `answer`, or `defaults`; proposed, applied after you confirm: the decision is yours).

## Who may do what

| Caller | read | mutate | destructive |
|---|---|---|---|
| you (CLI, TUI, RPC) | runs | runs | runs |
| the assistant | runs | proposal, or runs if `[control] auto_apply = true` | always a proposal |

A proposal (`P-n`) carries a diff (`+ task T-4 …`, `- edge T-1->T-2`). Confirm with `/apply [P-n]` or `hexagon apply`, drop with `/reject` or `hexagon reject`. Proposals are validated when made (unknown task, cycle) and again when applied. They live in the daemon's memory: a daemon restart drops them.

Commands: `status.get`, `graph.show`, `graph.addNode`, `graph.removeNode`*, `graph.addEdge`, `graph.removeEdge`*, `agent.configure`, `agent.setPrompt`, `run.start [--from T-n]`, `run.pause`, `run.resume`, `run.cancel`*, `bus.send` (*destructive), and for supervising a run:

| Command | Kind | What it does |
|---|---|---|
| `task.retry {id, agent?, effort?, fresh_session?}` | destructive | new attempt (a running one is stopped); `fresh_session` resets the agent's session, and the brief and last failure are re-sent |
| `task.continue {id, text}` | mutate | text to a blocked/failed/cancelled task (it resumes its session) or a running one |
| `task.pause` / `task.resume {id}` | mutate | one task's agent |
| `task.cancel {id}` | destructive | stop one task |
| `task.update {id, title?, description?, write?, read?, verify?, role?, agent?}` | mutate | only a task that has not started; the result must still pass the plan check |
| `graph.insertNode {after, before?, …}` | mutate | a task between two others; `before` must not have started |
| `graph.replaceTask {id, …}` | destructive | cancels the task (even a started one; not a merged one) and adds a new task with its dependencies; what waited for it waits for the new one; unset fields are copied |
| `run.replan {task, reason}` | mutate | the analyst's replan flow (spec patch + graph edits, one proposal) |
| `session.compact {agent?}` / `session.reset {agent}` | mutate | compact at the next safe point / start a new session next turn |
| `bus.read {task?, waiting?, limit?}`, `bus.waiting`, `health.get` | read | the bus log (`hexagon bus log [--task T-n] [--waiting]`), who waits for whom, the watchdog's findings |

## Supervision: the watchdog and the Assistant

The daemon runs pure rules over the run every `[watchdog] interval_s` seconds (`src/core/watchdog.ts`, unit-tested). It never acts; it publishes `health` items in the run status (and as `attention` entries of kind `health`):

| Rule | Fires when |
|---|---|
| `stalled` | an active task has produced no event for `stall_minutes` (10) |
| `waiting_input` | a question has waited `waiting_minutes` (30) |
| `token_burn` | `burn_tokens` (300k) used within `burn_window_minutes` (15) while the files changed did not grow |
| `ping_pong` | the same two tasks exchanged more than `ping_pong` (4) questions/answers/returns |
| `oscillation` | fixes reopened A, then B, then A |
| `stale_context` | a task started before a `decision` envelope or spec patch that touches one of its requirements |

New items (by stable id) are announced as notices and, at most every `digest_every_minutes` (5), sent to the Assistant as a `<hexagon_health>` digest. It diagnoses with the read commands and proposes fixes. `[assistant] autonomy = propose` (default): every change waits for `/apply`. `safe`: `task.pause`, `task.resume`, `session.compact` and `bus.send` (tell) apply at once; retry, cancel, graph edits, replans and session resets always wait.

## Editing the graph

`graph.addNode`, `graph.removeNode`, `graph.addEdge` and `graph.removeEdge` edit the **running graph** when a run is active, otherwise the draft plan.

* Adding a task or an edge to a running graph is allowed at any time; the new task starts when its prerequisites are done.
* A task can be removed, or given or relieved of a prerequisite, only while it has not started. A started or finished task is history: cancel it (`agent.cancel`) or `/retry` it instead. Removing a task that a started task depends on is refused.
* Every edit is validated first (unknown task, unknown role, cycle) and shows a diff. The edited graph is written to the run's `plan.json` and pushed to every UI.
* **Removing** a task or an edge is destructive: it waits for your yes whoever asked. From the TUI, `/rm T-3` or `/unlink T-1 T-3` shows the diff as a proposal; `/apply` confirms. `hexagon do graph.removeNode --id T-3` asks `Apply? [y/N]` (`--yes` skips the question; the assistant's `--yes` is ignored).
* TUI shortcuts: `/add <role> <title> in <globs> verify <cmd> [after T-1,T-2]` (the write scope and a check are required; `exempt <reason>` replaces `verify`), `/rm`, `/link <T-a> <T-b>` (T-b waits for T-a), `/unlink`.
* A removed task stays in the run's status as `cancelled — removed from the graph`, so the history is complete.

## Limits

* If a run and a draft both exist, graph edits go to the run.
* Pending proposals live in the daemon's memory; a restart drops them.
* Everything the assistant reads from files, agents or the bus is data; its prompt says so, and only the `control` agent may call the command API.
