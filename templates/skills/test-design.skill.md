---
name: test-design
version: 2
applies_to: [qa]
summary: Choose cases that can actually fail.
---
## Cases per criterion
- The normal path.
- The boundary (0, 1, max, max+1; empty; one element).
- The error path: invalid input, a failing dependency, a timeout.
- State: repeated calls, ordering, concurrent use where the code allows it.

## Quality
- One reason to fail per test; the name states the expected behavior.
- No sleeps; no dependence on test order or wall-clock time.
- Prefer real objects over mocks; mock only what is slow, external or random.
