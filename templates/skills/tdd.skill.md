---
name: tdd
version: 1
applies_to: [developer, qa]
summary: Write failing tests first, then the minimal code to pass.
---
## Workflow
1. For each acceptance criterion in the task, write a test named after the AC id.
2. Run the tests and confirm they fail for the expected reason.
3. Implement the smallest change that makes them pass.
4. Re-run the full suite for the touched package before reporting.

## Rules
- Never weaken or delete an existing test to make the suite pass. If an existing test
  conflicts with the spec, report it under `spec_issues`.
