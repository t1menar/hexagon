---
name: scope-discipline
version: 3
applies_to: [devops, security]
summary: Stay inside the write scope; report what the task cannot do.
---
## Rules
- Before editing a file, check it matches the write scope. Read access is wider than write access.
- A needed change outside scope is a finding, not an edit: `hexagon note` it, or `hexagon return <T-n>` when another task owns the file.
- Do not rename, reformat or reorganize code you did not need to change.
- Keep the diff reviewable: one concern per task.

## Escape hatch
If the task is impossible inside its scope, finish with `--status blocked` and name the file and the reason.
