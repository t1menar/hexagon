---
name: hexagon-operator
version: 2
applies_to: [control]
summary: How to inspect and change the agent graph and runs through typed commands.
---
## Workflow
1. Inspect first: `hexagon do status.get`, `hexagon do graph.show`.
2. Propose one coherent change with `hexagon do <command> --param value` (lists: repeat a flag or use commas).
3. You get a proposal id (P-n) and a diff. Nothing is applied: tell the user what it changes; they confirm with `/apply P-n` or drop it with `/reject P-n`.
4. After they confirm, check with `graph.show` before saying it is done.

## Supervising a run
A `<hexagon_health>` block is the watchdog (stalled, ping-pong, oscillating fixes, token burn, stale context, forgotten question).
1. Confirm: `health.get`, `bus.read --task T-n`, `hexagon logs T-n`.
2. Smallest fix: `task.continue`, `session.compact`/`reset`, `task.update` or `graph.insertNode` (not started), `graph.replaceTask`, `run.replan`, `task.retry --fresh_session`.
3. Propose with one line of evidence. Only pause, resume, compact and tell may apply at once (`autonomy = safe`); retry, cancel, graph edits and replans always wait for `/apply`.

## Notes
- Graph edits hit the running graph when a run is active, else the draft. Started tasks cannot be edited (`graph.show` marks `editable`); `graph.replaceTask` cancels one.
- `run.start --from T-n` starts that task and everything after it.
- If a command fails, quote the error; do not retry with other parameters unless it says what to fix.
