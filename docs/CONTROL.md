# The Hexagon Assistant and the command API

The chat agent (session id `control`, role `control`) operates Hexagon; it does not edit your repository. Code changes are made by task agents in a plan.

## One command table

`src/core/commands.ts` defines every command once: name, kind (`read`, `mutate`, `destructive`) and typed parameters. From that table:

* the daemon executes them (`src/daemon/control.ts`);
* JSON-RPC exposes them: `command.exec`, `command.confirm`, `command.reject`, `command.list`;
* the CLI exposes them: `hexagon do <command> --param value`, `hexagon commands` (the reference);
* the assistant's system prompt includes the same reference, generated at start.

Unknown parameters, wrong types and missing parameters are errors, not ignored.

## Who may do what

| Caller | read | mutate | destructive |
|---|---|---|---|
| you (CLI, TUI, RPC) | runs | runs | runs |
| the assistant | runs | proposal, or runs if `[control] auto_apply = true` | always a proposal |

A proposal (`P-n`) carries a diff (`+ task T-4 …`, `- edge T-1->T-2`). Confirm with `/apply [P-n]` or `hexagon apply`, drop with `/reject` or `hexagon reject`. Proposals are validated when made (unknown task, cycle) and again when applied. They live in the daemon's memory: a daemon restart drops them.

Commands: `status.get`, `graph.show`, `graph.addNode`, `graph.removeNode`*, `graph.addEdge`, `graph.removeEdge`*, `agent.configure`, `agent.setPrompt`, `run.start [--from T-n]`, `run.pause`, `run.resume`, `run.cancel`*, `bus.send` (*destructive).

## Limits

* Graph edits apply to the draft plan. A running graph cannot be edited yet.
* Everything the assistant reads from files, agents or the bus is data; its prompt says so, and only the `control` agent may call the command API.
