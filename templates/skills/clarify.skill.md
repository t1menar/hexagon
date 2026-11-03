---
name: clarify
version: 1
applies_to: [analyst]
summary: When to ask the user, and the analysis sections and questions.json that carry it.
---
## analysis.md sections
- `Confidence`: low, medium or high, and why.
- `Spike`: `- S-1: question`, one read-only investigation each; required when the cause is unknown, the change is cross-cutting or boundaries are unclear.
- `Approaches`: `- A-1: …`, only when more than one design is viable; the user picks one.
- `Delivery`: only if the request already says where the result goes.
- "Open questions: none" is allowed only with Confidence high and a known delivery target; low confidence always needs questions.

## questions.json
`[{"id":"Q-1","question":"…","why_it_matters":"…","options":["a","b"],"default":"a","blocking":true,"topic":"…"}]`: 3-7 entries; the default is one of the options (no options = free text). Topics: `design` (options are the Approaches), `delivery.push` (push to a remote after the merge: yes/no), `delivery.remote`, `delivery.pr`, `delivery.branch`, `delivery.merge` (who merges). Include the delivery block unless the request or config already answers it.
