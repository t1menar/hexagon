---
name: design-review
version: 2
applies_to: [architect]
summary: Check a design against the requirements before building.
---
## Checks
- Every requirement maps to a part of the design; nothing in the design maps to no requirement.
- Each interface states inputs, outputs, errors and who owns it.
- Failure modes: what happens when a dependency is down, input is malformed, or two writers collide.
- The design fits the repository's conventions; deviations are justified in Trade-offs.
- It can be built in independent tasks with disjoint write scopes.

## Escape hatch
If two requirements cannot both hold, report `needs_spec_change` with the conflicting criteria.
