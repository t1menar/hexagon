---
name: security-review
version: 2
applies_to: [reviewer, security]
summary: Security checks for a diff.
---
## Look for
- Untrusted input reaching a query, shell command, file path, template or deserializer.
- Missing authentication or authorization on a new entry point.
- Secrets in code, config, logs or error messages.
- New dependencies, and version changes of existing ones.
- Weakened validation, widened permissions, disabled checks.

## Report
Name the entry point, the data path and the fix. A theoretical issue with no path from untrusted input is low severity.
