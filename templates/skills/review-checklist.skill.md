---
name: review-checklist
version: 1
applies_to: [reviewer]
summary: What every review checks.
---
- Each acceptance criterion: is there a test or command output that demonstrates it?
- Scope: are all changed files inside the task's write scope?
- Errors: are failure paths handled the way the spec says (status codes, messages)?
- Security: input validation, secrets, injection, auth checks where relevant.
- Tests: do they assert behavior, and would they fail if the AC were broken?
