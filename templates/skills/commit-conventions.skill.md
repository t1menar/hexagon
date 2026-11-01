---
name: commit-conventions
version: 2
applies_to: [developer, qa, devops, security, release]
summary: Hexagon commits for you; keep the diff focused.
---
## Rules
- Hexagon commits with the task id and requirement references; do not stage files outside your write scope.
- Never leave generated artifacts or secrets in the worktree.
- Leave the worktree in the state you want committed: no debug output, no scratch files.
