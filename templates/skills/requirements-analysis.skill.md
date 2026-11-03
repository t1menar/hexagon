---
name: requirements-analysis
version: 3
applies_to: [analyst]
summary: Turn a request into facts, constraints and open questions.
---
## Method
- Separate what was asked, what is implied, and what you assume. Write assumptions down.
- Find the existing behavior the change touches by reading code and tests, not by guessing.
- List constraints: compatibility, data formats, performance numbers, deadlines, forbidden dependencies.
- List risks with a likelihood and the cheapest way to check each.
- An open question is worth asking when two answers lead to different designs, or when a wrong guess is expensive: ambiguous scope, several viable designs, irreversible or data-affecting changes, public API changes, an unknown delivery target (repo, base branch, work branch or PR, push, who merges).
- State your Confidence (low|medium|high). Low confidence always means questions.

## Escape hatch
If the request is too vague to analyze, put the questions in questions.json (clarify skill); the user answers or accepts the defaults.
