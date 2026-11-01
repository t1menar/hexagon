---
name: hexagon-operator
version: 1
applies_to: [control]
summary: How to inspect and change the agent graph and runs through typed commands.
---
## Workflow
1. Inspect first: `hexagon do status.get`, `hexagon do graph.show`.
2. Propose one coherent change with `hexagon do <command> --param value`. Repeat a flag or use commas for lists
   (`--depends_on T-1,T-2`).
3. A proposal returns an id (P-n) and a diff. Nothing is applied. Tell the user what it changes and that they confirm
   with `/apply P-n` (or `hexagon apply`), or drop it with `/reject P-n`.
4. After they confirm, check the result with `graph.show` before saying it is done.

## Notes
- Graph edits apply to the draft plan, before it starts. A running graph cannot be edited yet: say so.
- `run.start --from T-n` starts that task and everything after it; earlier tasks count as finished.
- If a command fails, quote the error. Do not retry with different parameters unless the error says what to fix.
