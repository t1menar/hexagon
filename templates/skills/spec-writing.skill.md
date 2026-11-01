---
name: spec-writing
version: 2
applies_to: [analyst]
summary: Write requirements that a test can check.
---
## Requirement shape
- One behavior per requirement; title is a short noun phrase.
- Acceptance criteria are observable: an input, an action, an expected output or state, with numbers where they matter.
- No criterion contains "should be fast", "robust", "intuitive", "etc.".
- Each criterion can be made true or false by one test or command.

## Size
Few requirements beat many: usually 1-4. Split only when parts can be built and verified independently.

## Touches
List the globs where the work will happen; tasks are scheduled from them, so keep them narrow and disjoint where possible.
