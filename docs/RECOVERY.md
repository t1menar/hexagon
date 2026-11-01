# Provider limits, recovery and fix cycles

## Classification (`src/agents/contracts/errors.ts`)

What a CLI printed on failure is classified, each class with its own policy:

| Class | Policy |
|---|---|
| `rate_limit`, `overloaded` | wait (provider `Retry-After` if given, else backoff), resume the same session |
| `quota_exhausted` | wait for the provider-reported reset (e.g. `…|1767262800`, `resets in 2 hours`, `resets 3pm`); else exponential backoff + jitter, labelled **estimated** |
| `context_overflow` | **not** a quota wait: new session with a compacted context (task card in full, files changed, criteria done, outstanding feedback), up to `max_context_recoveries` |
| `output_truncated` | ask the agent to continue; the result is still verified and reviewed |
| `auth`, `billing` | task goes `blocked` with an actionable reason; no retries; `/retry` after you fix it |

None of these counts as a repair cycle or an attempt, creates a task or branch, or discards reviewer feedback.

## Waiting and resuming

State `waiting_quota` shows why, when it resumes, and whether the time is provider-reported or estimated. Each wait is recorded in `.hexagon/runs/<run>/waits.json` (one record per agent run, replaced atomically; `claim()` succeeds once so a task is never resumed twice). The wait sleeps in the daemon (no CLI is spawned to poll), then continues the same CLI session in the same worktree, with the outstanding feedback.

* **Cancel** during a wait: the task becomes `cancelled` and is never restarted.
* **Daemon restart**: on start, runs with pending waits are reopened (`recoverRuns`): finished tasks stay finished, cancelled ones stay cancelled, waiting tasks keep their attempt, worktree and session and resume at their stored time (immediately if it passed). A task that was mid-execution (not waiting) when the daemon died is not re-run automatically; use `/retry`.
* **Failover** (off by default): with `[recovery] allow_provider_failover = true` and `fallback_agent` on the role, quota/overload moves the task to that agent in a fresh session; the change is recorded as a `recovery` event, shown in the UI, and verification and review run again as always.

```toml
[recovery]
enabled = true
auto_resume = true
unlimited_quota_wait = true
allow_provider_failover = false
initial_backoff_seconds = 60
max_backoff_seconds = 3600
backoff_multiplier = 2
backoff_jitter = true
max_wait_seconds = 0          # 0 = unlimited
max_context_recoveries = 3
```

## Fix cycles

`[run] max_fix_cycles = 0` means unlimited. Each task loops implement → Hexagon-run verification → independent review → feedback → implement, and **every revision is verified and reviewed again**; an earlier approval never carries over. Safeguards: `max_identical_failures` (default 3) stops when the same verify output or review findings repeat; cancellation; the token budget. Cycle number is on the dashboard (`fix_cycle`). Legacy `fix_loops` alone still caps cycles for old configs.

## Telemetry

`recovery` events (`waiting`/`resumed`/`blocked`/`compacted`/`failover`) carry the class, the original message, the next retry time and whether it is provider-reported; `status.json` keeps `recovery` (class, waits, waited seconds, history). Provider, adapter, agent, role, task and execution ids are on the wait records.

## Not yet implemented

Usage budgets other than tokens, human-escalation channels beyond notices, and resuming tasks that were mid-execution at a crash.
