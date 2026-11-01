---
name: merge-conflicts
version: 2
applies_to: [release]
summary: Resolve conflicts keeping both intents.
---
## Method
1. For each conflicted file, read the base, both sides and the task specs.
2. Decide per hunk: keep both, keep one with a reason, or stop and report.
3. Resolve only the conflict markers and what the resolution needs.
4. Build and run the tests of both tasks.

## Stop conditions
The two sides implement incompatible behavior, or a resolution would delete tested behavior. Report both options; do not choose.
