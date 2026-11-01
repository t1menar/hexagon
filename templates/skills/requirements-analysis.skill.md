---
name: requirements-analysis
version: 2
applies_to: [analyst]
summary: Turn a request into facts, constraints and open questions.
---
## Method
- Separate what was asked, what is implied, and what you assume. Write assumptions down.
- Find the existing behavior the change touches by reading code and tests, not by guessing.
- List constraints: compatibility, data formats, performance numbers, deadlines, forbidden dependencies.
- List risks with a likelihood and the cheapest way to check each.
- An open question is worth asking only if two answers lead to different designs.

## Escape hatch
If the request is too vague to analyze, ask once with options and a default; if there is no answer, proceed on the default and say so in Open questions.
