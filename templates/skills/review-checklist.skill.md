---
name: review-checklist
version: 2
applies_to: [reviewer]
summary: What every review checks.
---
## In order
1. Each acceptance criterion has evidence: a test that exercises it, or command output you saw.
2. The diff stays inside the task's write scope.
3. Behavior on the error path and on empty or boundary input.
4. Tests would fail if the behavior broke.
5. No leftover debug code, secrets, or unrelated edits.

## Reporting
Report findings in severity order. One approval or one change request per review, never both.
