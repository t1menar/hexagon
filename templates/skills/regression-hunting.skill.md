---
name: regression-hunting
version: 2
applies_to: [qa]
summary: Find what the change broke elsewhere.
---
## Method
1. List what the change touches: functions, formats, config keys, public behavior.
2. Search for their callers and tests (`grep` the names).
3. Run the tests of every caller package, not only the touched one.
4. For each caller without a test, write one that pins today's behavior.

## Report
A regression is a defect in code another task owns when it comes from their change: `hexagon return <T-n> "<what broke, the command that shows it>"`.
