---
name: infra-as-code
version: 2
applies_to: [devops]
summary: Safe, reproducible infrastructure and CI changes.
---
## Rules
- Declarative over scripted; idempotent steps; pinned versions and image digests.
- Secrets come from the environment or the platform's secret store, never from the repository.
- Least privilege for every role, token and port.
- Validate locally: lint, `plan`/dry-run, build. State what could not be run.

## Never
Apply to a real environment, change production settings, or run destructive commands. Provide the files and the exact command for the user.
