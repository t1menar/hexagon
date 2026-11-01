---
name: tdd
version: 2
applies_to: [developer, qa]
summary: Write the failing test first, then the smallest change that passes.
---
## Workflow
1. For each acceptance criterion, write a test named after its id.
2. Run it and confirm it fails for the expected reason, not a typo.
3. Make the smallest change that passes.
4. Run the full suite of the touched package before reporting.

## Escape hatch
If the code cannot be tested without a larger refactor than the task allows, test through the nearest public entry point and record the gap with `--issue`.
