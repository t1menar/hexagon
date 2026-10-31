# Hexagon — Architecture & Implementation Plan

Hexagon is a terminal-based orchestrator for spec-driven development. It runs several
AI coding agents (Claude, OpenAI CLI, DeepSeek, …) in parallel, turns textual specs into
agent tasks, verifies and merges their results, and records **personal** metrics about
agent usage and output quality.

**Stack:** TypeScript on Node 22, Ink for the TUI, `@anthropic-ai/sdk` for direct Claude
API calls, Claude Agent SDK for Claude Code agents, SQLite + JSONL for local state.

---

## 0. Design principles

1. **The spec is the source of truth.** Every task, commit and test traces to a requirement
   ID (`REQ-AUTH-001`). When code and spec disagree, the spec wins — or the agent files a
   spec-change proposal. Agents never silently reinterpret.
2. **Agents never talk to each other directly.** All messages go through the orchestrator's
   router (hub-and-spoke); shared knowledge lives on a blackboard. This keeps runs
   deterministic and replayable. See [COMMUNICATION.md](COMMUNICATION.md).
3. **Isolation by default.** Each task runs in its own git worktree/branch; results reach
   the main branch only through the Integrator.
4. **Everything is an event.** The TUI, metrics, `resume` and `replay` all read one
   append-only event log.
5. **Skills are code.** Workflow rules live in versioned markdown, compiled into prompts.
6. **Metrics are private.** All telemetry stays on the local machine and exists only for the
   user's own analysis of agent usage and quality. Nothing is exported or shared.

---

## 1. High-level architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         hexagon CLI / TUI (Ink)                      │
│   commands ─┐        dashboard ◄── event stream ◄──┐                 │
└─────────────┼──────────────────────────────────────┼─────────────────┘
              ▼                                      │
┌─────────────────────────┐   ┌──────────────────────┴───────────────┐
│ Spec Engine             │   │ Event Bus (in-proc) ──► events.jsonl │
│  parse · lint · diff    │   │                     ──► metrics.db   │
│  REQ graph · traceability│  │     (local only, never exported)     │
└──────────┬──────────────┘   └──────────────────────▲───────────────┘
           ▼                                         │
┌─────────────────────────┐   ┌──────────────────────┴───────────────┐
│ Planner (agent)         │──►│ Scheduler                            │
│  spec → task DAG        │   │  DAG · concurrency · file leases     │
└─────────────────────────┘   │  budgets · retries · circuit breakers│
                              └──────────┬───────────────────────────┘
                                         ▼
                 ┌───────────────── Agent Pool ─────────────────┐
                 │  Adapter interface (one per provider)        │
                 │  ├─ ClaudeApiAdapter   (Messages API + tools)│
                 │  ├─ ClaudeCodeAdapter  (Agent SDK / headless)│
                 │  ├─ OpenAICliAdapter   (subprocess)          │
                 │  └─ DeepSeekAdapter    (HTTP)                │
                 │  each run → isolated git worktree            │
                 └──────────┬───────────────────────────────────┘
                            ▼
┌─────────────────────────┐   ┌──────────────────────────────────────┐
│ Prompt Compiler         │   │ Integrator                           │
│  role + skills + spec   │   │  verify → rebase → merge → re-test   │
│  slice + task → request │   │  conflict → resolver agent / human   │
└─────────────────────────┘   └──────────────────────────────────────┘
```

### Adapter contract (the only provider-specific code)

```ts
interface AgentAdapter {
  id: string;                       // "claude-sonnet", "codex", "deepseek"
  capabilities: { tools: boolean; structuredOutput: boolean; maxContext: number };
  run(req: AgentRunRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

type AgentEvent =
  | { type: "progress"; text: string }            // shown in TUI
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "usage"; input: number; output: number; cacheRead: number }
  | { type: "result"; envelope: ResultEnvelope }  // final, schema-validated
  | { type: "error"; kind: ErrorKind; message: string; retryable: boolean };
```

Non-Claude CLIs are wrapped as subprocesses: compiled prompt on stdin, stdout parsed and
validated against the same `ResultEnvelope` schema. Providers without structured output
get a cheap "extract envelope" post-pass.

---

## 2. On-disk layout

```
repo/
├─ specs/
│  ├─ auth.spec.md                # human-authored, source of truth
│  └─ billing.spec.md
├─ .hexagon/
│  ├─ config.toml                 # agents, roles, budgets, concurrency   (committed)
│  ├─ skills/                     # reusable workflow instructions        (committed)
│  │  ├─ tdd.skill.md
│  │  ├─ commit-conventions.skill.md
│  │  └─ review-checklist.skill.md
│  ├─ roles/                      # role system prompts (templated)       (committed)
│  │  └─ planner.md implementer.md tester.md reviewer.md integrator.md
│  ├─ runs/<run-id>/              # personal data — gitignored
│  │  ├─ plan.json
│  │  ├─ events.jsonl             # append-only; source for replay & metrics
│  │  └─ tasks/<task-id>/{prompt.json,result.json,transcript.jsonl,diff.patch}
│  ├─ metrics.db                  # personal metrics (SQLite) — gitignored
│  └─ worktrees/<task-id>/        # git worktrees — gitignored
```

---

## 3. Spec-driven data flow

```
spec.md ──lint──► Spec AST ──Planner──► Task DAG ──Scheduler──► Agent runs
   ▲                                                               │
   │                                                    ResultEnvelope + diff
   │                                                               ▼
   └── spec-change proposals ◄── Reviewer ◄── Verify (tests/lint) ◄┘
                                                │ pass
                                                ▼
                                   Integrator → main → traceability report
```

### 3.1 Spec format

```markdown
---
spec: auth
version: 3
---
# Authentication

## REQ-AUTH-001: Password login
Users log in with email + password and receive a session cookie.

**Acceptance**
- AC-1: Valid credentials → 200, `Set-Cookie: sid=…; HttpOnly; Secure`
- AC-2: Invalid credentials → 401, generic message (no user enumeration)
- AC-3: 5 failures in 10 min → 429 for that account for 15 min

**Constraints**: bcrypt cost ≥ 12. No new dependencies without approval.
**Touches**: `src/auth/**`, `src/http/middleware/**`
```

`hexagon spec lint` checks: every REQ has ≥1 AC, IDs are unique, ACs are observable
(flags "fast", "user-friendly", …), and `Touches` globs exist.

### 3.2 Task (Planner output, schema-validated JSON)

```json
{
  "id": "T-007",
  "title": "Rate-limit failed logins",
  "role": "implementer",
  "requirements": ["REQ-AUTH-001"],
  "acceptance": ["AC-3"],
  "depends_on": ["T-004"],
  "files": { "write": ["src/auth/ratelimit.ts", "src/auth/login.ts"],
             "read":  ["src/http/middleware/**"] },
  "skills": ["tdd", "commit-conventions"],
  "definition_of_done": [
    "Unit tests for AC-3 exist and pass",
    "`npm test -- auth` passes",
    "No changes outside files.write"
  ],
  "estimate": { "size": "S", "risk": "medium" },
  "agent_hint": "claude-sonnet"
}
```

### 3.3 Result envelope (every agent, every provider)

```json
{
  "task_id": "T-007",
  "status": "completed",
  "summary": "Added sliding-window limiter keyed by account id; wired into login handler.",
  "files_changed": ["src/auth/ratelimit.ts", "src/auth/login.ts", "test/auth/ratelimit.test.ts"],
  "acceptance_evidence": [
    { "ac": "AC-3", "evidence": "test/auth/ratelimit.test.ts › locks after 5 failures", "verified": true }
  ],
  "commands_run": [{ "cmd": "npm test -- auth", "exit_code": 0 }],
  "blockers": [],
  "spec_issues": [],
  "follow_ups": ["Consider Redis-backed store for multi-instance deploys"]
}
```

`status` ∈ `completed | blocked | failed | needs_spec_change`. The orchestrator never trusts
`verified: true` — it re-runs `definition_of_done` commands in the worktree itself.

### 3.4 Traceability

`hexagon trace` builds a REQ → AC → task → commit → test matrix. A REQ is "done" only when
every AC has a linked passing test. Commits carry trailers
(`Hexagon-Task: T-007`, `Refs: REQ-AUTH-001/AC-3`).

---

## 4. Multi-agent orchestration

### 4.1 Roles

| Role | Input | Output | Writes code? | Typical agent |
|---|---|---|---|---|
| **Planner** | spec slice + repo map | task DAG | no | Sonnet 5.5 @ `high` |
| **Implementer** | one task + skills + relevant files | diff + envelope | yes (own worktree) | Sonnet 5.5 @ `medium`, Codex, DeepSeek |
| **Tester** | REQ/ACs + implementation diff | tests + envelope | tests only | Sonnet 5.5 @ `medium` |
| **Reviewer** | diff + spec + checklist skill | verdict + findings | no | Sonnet 5.5 @ `high`, preferably a different agent than the implementer |
| **Integrator** | approved branches | merged main | conflict fixes only | deterministic git + resolver agent on conflict |
| **Summarizer** | event log | status digests | no | Sonnet 5.5 @ `low` / Haiku 5.5 |

### 4.2 Scheduling & synchronization

- **DAG scheduler** — a task is ready when all `depends_on` tasks are *merged* (not merely
  completed), so downstream work starts from integrated code.
- **File leases** — `files.write` globs are leased exclusively; overlapping ready tasks are
  serialized. Read sets are shared. The Planner is instructed to minimize overlap.
- **Concurrency limits** — global (`max_parallel = 6`), per provider (rate limits), per role.
- **Blackboard, not chat** — cross-task knowledge goes to `.hexagon/runs/<id>/notes.md`
  (e.g. "T-004 introduced `AuthStore`; use it"). The orchestrator appends from envelopes
  and injects relevant notes into later tasks.
- **Per-task pipeline** — `implement → verify(cmds) → review → (fix loop ≤ 2) → integrate → re-verify on main`.

### 4.3 Error handling

| Error kind | Detection | Response |
|---|---|---|
| `transient` (429, 5xx, network) | adapter | Backoff + jitter; SDK retries ×2, then scheduler requeues |
| `refusal` | `stop_reason: "refusal"` | Server-side fallback (§6.5); still refused → `blocked`, surface to user |
| `truncated` | `stop_reason: "max_tokens"` | Retry once with bigger budget, else split task |
| `invalid_output` | schema validation fails | One repair turn, then fail |
| `verify_failed` | DoD commands non-zero | Feed output back (fix loop); effort `medium→high` on 2nd attempt; switch agent on 3rd |
| `scope_violation` | diff outside `files.write` | Auto-reject, re-prompt with the violation listed |
| `stuck` | no progress for N min / tool loop > K | Abort, save transcript, retry with fresh context |
| `needs_spec_change` | envelope status | Pause dependents, open proposal (`hexagon spec proposals`) |

- **Circuit breaker per agent:** 3 consecutive failures → out of rotation for 10 min.
- **Budgets:** per-task token/$ caps and a per-run cap. Hitting the run cap *pauses* and asks.
- **Resume:** state is rebuilt from `events.jsonl`; in-flight tasks are requeued from their
  last checkpoint (worktree preserved).

---

## 5. Skills

```markdown
---
name: tdd
version: 2
applies_to: [implementer, tester]
summary: Write failing tests first, then the minimal code to pass.
---
## Workflow
1. For each acceptance criterion in the task, write a test named after the AC id.
2. Run the tests and confirm they fail for the expected reason.
3. Implement the smallest change that makes them pass.
4. Re-run the full suite for the touched package before reporting.

## Rules
- Never weaken or delete an existing test to make the suite pass. If an existing
  test conflicts with the spec, report it under `spec_issues`.
```

The Prompt Compiler resolves skills by role + task, orders them deterministically
(alphabetical) so prompt caching works, and embeds them in the system prompt inside
`<skill name="…">` tags. `hexagon skills lint` validates frontmatter and flags contradictions.

---

## 6. Prompt engineering for Claude Sonnet 5.5

### 6.1 Model facts that shape the design

- Model ID `claude-sonnet-5-5`; 1M context, 128K max output — stream long requests.
- **Thinking is adaptive and on by default.** `thinking: {type: "disabled"}` returns 400.
  Control depth with `output_config.effort`. `{type: "between_tools"}` only if a route truly
  needs thinking off (effort ≤ `high`).
- **Effort defaults to `high`, levels recalibrated** — start agentic coding at `medium`,
  summaries at `low`, measure before raising.
- **Forced `tool_choice` (`any`/`tool`) returns 400** — use `auto` + prompt instruction,
  `strict: true` tools, or structured outputs (`output_config.format`) for the envelope.
- **No assistant prefill; no non-default `temperature`/`top_p`/`top_k`** (400).
- **Preserved thinking** — thinking blocks are bound to model + conversation, so the agent
  loop must be **append-only**. Inject operator nudges as mid-conversation
  `{"role": "system"}` messages, never by editing history.
- **Prompt caching is prefix-match** (`tools → system → messages`). Freeze stable parts.

### 6.2 Prompt layering (cache-friendly)

```
tools            fixed set per role, sorted                    ── cached
system[0]        role prompt                                   ── cached (shared by all tasks of the role)
system[1]        skills block                                  ── cached
system[2]        project context: repo map, conventions        ── cached per run  ◄ cache_control
messages[0].user task card + spec slice + relevant files       ── per task
messages[...]    tool calls/results (append-only)
```

Never put timestamps, run IDs or random ordering in the system prompt. Watch
`usage.cache_read_input_tokens` in metrics.

### 6.3 Role system prompt — Implementer

```markdown
You are the Implementer in Hexagon, a spec-driven development system. You complete
exactly one task in an isolated git worktree. Other agents work on other tasks in
parallel; an orchestrator verifies, reviews, and merges your work.

## What matters
The specification is the source of truth. Your job is to make the task's acceptance
criteria demonstrably true, with tests, while changing only what the task needs.
A reviewer will reject work that is outside scope, untested, or that diverges from
the spec — even if it looks like an improvement.

## Boundaries
- Write only to files matching the task's `files.write` globs. If the task genuinely
  cannot be done within them, stop and report status `blocked` with the reason;
  the orchestrator will re-plan.
- If the spec is ambiguous or contradicts existing code or tests, do not pick an
  interpretation silently. Report it in `spec_issues` and, if it blocks you, use
  status `needs_spec_change`.
- Do not add dependencies, change CI config, or modify unrelated tests.

## How to work
Use the tools to read code before changing it. Run the commands in the task's
definition of done yourself and fix failures before reporting. Keep progress notes
between tool calls short — one line on what you're doing next.

## Reporting
When finished, respond with the result envelope (the response format is enforced).
`acceptance_evidence` must name a concrete test or command output for each AC; mark
`verified: false` for anything you could not check. Report failures plainly — an
honest `failed` is more useful than an optimistic `completed`.

{{skills}}
{{project_context}}
```

Rationale: Sonnet 5.5 responds better to purpose + constraints with reasons than to walls
of capitalized MUSTs (which newer models over-apply). The prompt states the evaluation
criteria, provides explicit escape hatches (`blocked`, `needs_spec_change`) so the model
doesn't improvise, and asks for honesty in the envelope.

### 6.4 Task instruction (first user message)

```xml
<task id="T-007" role="implementer">
  <title>Rate-limit failed logins</title>
  <requirements>
    <req id="REQ-AUTH-001">Users log in with email + password …</req>
  </requirements>
  <acceptance>
    <ac id="AC-3">5 failures in 10 min → 429 for that account for 15 min</ac>
  </acceptance>
  <scope write="src/auth/ratelimit.ts, src/auth/login.ts, test/auth/**"
         read="src/http/middleware/**"/>
  <definition_of_done>
    <check>Unit tests for AC-3 exist and pass</check>
    <cmd>npm test -- auth</cmd>
  </definition_of_done>
  <context>
    <note from="T-004">AuthStore interface added in src/auth/store.ts; use it for persistence.</note>
    <file path="src/auth/login.ts">…current contents…</file>
  </context>
</task>
```

### 6.5 Request shape per run

```jsonc
// anthropic-beta: server-side-fallback-2026-07-01,thinking-display-updates-2026-08-18,task-budgets-2026-03-13
{
  "model": "claude-sonnet-5-5",
  "max_tokens": 64000,
  "stream": true,
  "thinking": { "type": "adaptive", "display": "updates" },   // progress notes → TUI
  "output_config": {
    "effort": "medium",
    "task_budget": { "type": "tokens", "total": 200000 },     // agent paces itself
    "format": { "type": "json_schema", "schema": { /* ResultEnvelope */ } }
  },
  "fallbacks": "default",              // auto-route on refusal (Claude API only)
  "tools": [ /* read_file, write_file, run_cmd … each "strict": true, sorted */ ],
  "tool_choice": { "type": "auto" },
  "system": [ /* role, skills, project context; cache_control on the last block */ ],
  "messages": [ /* task card, then append-only tool turns */ ]
}
```

- `display: "updates"` returns short between-tool progress notes → per-agent TUI status line.
- Always check `stop_reason` (`refusal`, `max_tokens`, `tool_use`, `end_turn`) before reading content.
- Execute parallel tool calls concurrently; return **all** `tool_result` blocks in one user
  message; failures use `is_error: true`.
- If a structured final turn conflicts with your loop's termination, use a `submit_result`
  tool (`strict: true`) with an instruction to call it last.

### 6.6 Effort by role (starting points — tune on your own eval set)

| Role | Effort | Escalation |
|---|---|---|
| Planner | `high` | `xhigh` for large or cross-cutting specs |
| Implementer | `medium` | `high` on 2nd attempt after `verify_failed` |
| Tester | `medium` | — |
| Reviewer | `high` | — |
| Conflict resolver | `high` | human after one failure |
| Summarizer / log triage | `low` | — |

Mid-run effort changes (fix loops) use a per-message effort system message
(beta `mid-conversation-output-config-2026-07-01`) to keep the cache intact.

### 6.7 Other roles — key prompt deltas

- **Planner:** "Produce the smallest set of tasks that covers every AC exactly once. Minimize
  overlap between `files.write` sets so tasks can run in parallel. Each task needs a
  mechanically checkable definition of done. Flag spec problems instead of planning around
  them." Output: `{tasks: Task[], spec_issues: []}`; orchestrator validates acyclicity, AC
  coverage, glob existence.
- **Reviewer:** "You review someone else's work against the spec. Approve only if every AC
  has evidence and nothing is out of scope. Rank findings by severity; skip style the linter
  enforces." Output: `{verdict: approve|request_changes, findings: [{file, line, severity, ac?, issue, suggestion}]}`.
- **Tester:** "Write tests that would fail if the AC were violated. Name each test after its
  AC id. Don't test implementation details."

### 6.8 Non-Claude agents

Same role prompt and task card; the adapter appends the JSON schema as text, and output
always goes through the same validator + one repair pass. Per-agent quality metrics (§8)
drive routing via `agent_hint`.

---

## 7. CLI user experience

### 7.1 Commands

Running `hexagon` with no arguments opens the interactive shell, where every command below
is also available as a slash command (`/run`, `/focus T-007`, `/open`, …). See
[COMMUNICATION.md §4–5](COMMUNICATION.md#4-interactive-shell-hexagon).

```
hexagon init                         # scaffold .hexagon/, detect test cmds, write config
hexagon spec lint [path]             # validate specs
hexagon spec diff <ref>              # which REQs changed since a git ref
hexagon plan <spec...> [--dry-run]   # Planner → task DAG, printed as a tree
hexagon run [--plan <id>] [-j 6] [--budget $20] [--only T-007,T-008]
hexagon status [run]                 # one-shot snapshot (non-interactive)
hexagon watch [run]                  # full-screen dashboard
hexagon logs <task> [-f] [--raw]     # transcript / tool calls
hexagon retry <task> [--agent codex] [--effort high]
hexagon pause | resume | abort [run]
hexagon review <task>                # diff + reviewer findings, approve/reject
hexagon merge [--all-approved]
hexagon trace [--format md|json]     # REQ → AC → task → commit → test
hexagon rate <task> <1-5> [--note …] # personal quality rating of an outcome
hexagon stats [--since 7d] [--by agent|role|skill|effort]
hexagon agents | skills [list|lint|show]
hexagon replay <run> --task T-007    # re-render a transcript, no API calls
```

Global flags: `--json` (NDJSON), `--no-color`, `--plain` (no animation/redraws), `-q/-v`,
`--yes`, `--config`.

### 7.2 Dashboard (`hexagon watch`)

```
 HEXAGON  run r-2026-10-31-a  ·  auth.spec v3  ·  ⏱ 12:41  ·  $3.84 / $20  ·  cache 87%
 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 Progress  ███████████████░░░░░░░░░  9/15 tasks · 14/22 ACs verified

 TASK   ROLE         AGENT          STATE        PROGRESS                          TOKENS
 T-004  implementer  claude-sonnet  ✔ merged                                       41k
 T-007  implementer  claude-sonnet  ⠹ running    Running npm test -- auth (2/3)    28k
 T-008  tester       deepseek       ⠼ running    Writing tests for AC-2            12k
 T-009  reviewer     claude-sonnet  ◐ review     Checking scope of src/auth/**     9k
 T-010  implementer  codex          ⚠ retry 2    verify_failed: 1 test failing     33k
 T-011  implementer  —              ◌ waiting    blocked by T-007 (lease src/auth/login.ts)
 T-012  implementer  claude-sonnet  ✖ blocked    needs_spec_change: AC-2 vs existing 403

 ─ Events ───────────────────────────────────────────────────────────────────────────
 12:40:58  T-009  reviewer requested changes (1 high: missing AC-3 evidence)
 12:40:31  T-004  merged → main (3 files, +142 −8)
 [↑↓] select  [enter] logs  [r] retry  [p] pause  [d] diff  [s] spec issues  [?] help
```

### 7.3 UX & accessibility rules

- **Never color-only.** Every state has glyph + word. Colorblind-safe palette (blue/orange,
  not red/green), checked on dark and light terminals.
- **Respect the environment:** `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, non-TTY → plain
  line output. `CI=true` implies `--plain --yes`.
- **Motion is optional:** spinners off under `--plain` / `HEXAGON_REDUCED_MOTION=1`;
  redraws capped ~10 fps. `--plain` prints only state changes as full sentences, for
  screen readers.
- **stdout = data, stderr = chrome.** `hexagon status --json | jq` always works.
  Exit codes: 0 ok, 1 task failures, 2 usage error, 3 budget hit, 130 interrupted.
- **Errors say what to do next:**
  `✖ T-010 failed verification (npm test -- auth exit 1). See: hexagon logs T-010 · Retry: hexagon retry T-010 --effort high`
- **Graceful Ctrl-C:** first press pauses + checkpoints; second aborts in-flight agents;
  worktrees kept for `resume`.
- **Confirm destructive actions** (`abort`, `merge --all-approved`); `--yes` skips.
- **Keyboard-first:** every dashboard action has a key; `?` lists them.

---

## 8. Personal metrics (usage & quality)

Metrics exist **only for the user's own analysis** of how agents are used and how good their
output is. They are stored locally, are gitignored, and are never exported, uploaded or
shared. There is no telemetry endpoint, no OpenTelemetry exporter, and no team/aggregate view.

### 8.1 Storage

- `.hexagon/runs/<id>/events.jsonl` — raw append-only events (source of truth).
- `.hexagon/metrics.db` — SQLite tables derived from events, for fast `hexagon stats`.
- Optional global rollup across projects at `~/.hexagon/metrics.db` (still local).
- `hexagon stats --purge [--before 90d]` deletes history; prompts/transcripts can be
  excluded entirely with `metrics.store_transcripts = false`.

### 8.2 Event example

```json
{"ts":"2026-10-31T12:40:31.212Z","run":"r-…a","task":"T-007","agent":"claude-sonnet",
 "role":"implementer","type":"usage","model":"claude-sonnet-5-5","effort":"medium",
 "input":18233,"output":2140,"cache_read":15900,"cache_write":0,
 "cost_usd":0.0532,"latency_ms":8421,"prompt_hash":"r:implementer@a1f3+s:tdd@2"}
```

Event types: `run.started`, `task.ready|started|progress|tool_call|usage|result|verified|reviewed|merged|failed|rated`,
`budget.warning`, `breaker.open`, `spec.issue`.

### 8.3 What gets measured

**Usage**
- Tokens, cost, wall time per run / task / agent / role / effort level.
- Cache hit rate (`cache_read / input`) — warn below 60%.
- Tool-call counts and types per task; turns per task.
- **Cost per merged task** (headline number), not cost per request.

**Quality**
- First-pass verify rate (DoD commands pass on first report).
- Review approval rate and average findings by severity.
- Fix-loop count; retries; agent switches needed.
- Scope-violation rate; invalid-envelope rate; refusal / truncation counts.
- Claimed-vs-actual: how often `verified: true` in the envelope was contradicted by re-run.
- Post-merge regressions: a later task's verify fails on files a merged task changed, or
  the merge commit is reverted.
- Personal rating (`hexagon rate T-007 4 --note "clean but over-engineered"`).

**Comparisons** (`hexagon stats --by …`)
- agent × role, skill version, role-prompt hash, effort level — to see whether a prompt or
  skill change actually improved quality, and which agent is worth its cost for which role.

### 8.4 Example output

```
$ hexagon stats --since 30d --by agent
AGENT          TASKS  1ST-PASS  APPROVED  FIX LOOPS  CLAIM≠ACTUAL  $/MERGED  CACHE  RATING
claude-sonnet    142      78%       91%       0.4          3%       $0.41    86%    4.2
codex             61      64%       83%       0.8          9%       $0.37    —      3.7
deepseek          38      52%       71%       1.3         14%       $0.12    —      3.3
```

The scheduler can optionally use these local numbers to route `agent_hint` per role.

---

## 9. Implementation plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **1. Skeleton** | CLI framework, config, event bus + JSONL, SQLite, `init`, `spec lint` | Lints a real spec; `--json`/`--plain` work |
| **2. Single agent end-to-end** | ClaudeApiAdapter (streaming, tools, structured envelope), Prompt Compiler, worktrees, verify step, `run --only` | One task: spec → worktree → verified diff; cache hits on 2nd task |
| **3. Planner + DAG** | Planner role, DAG validation, scheduler, file leases, `plan --dry-run` | 10+ task plan runs at `-j 4` with no lease conflicts |
| **4. Review + integrate** | Reviewer, fix loop, Integrator, conflict resolver, `trace` | Full spec → merged main with traceability matrix |
| **5. TUI** | Ink dashboard, `watch`, keybindings, accessibility modes | Usable at 80×24, `NO_COLOR`, plain screen-reader mode |
| **6. Multi-provider** | Claude Code, OpenAI CLI, DeepSeek adapters; circuit breakers | Same plan runs across mixed agents |
| **7. Personal metrics** | `metrics.db` derivation, `stats`, `rate`, purge, prompt-hash comparisons, local eval suite (~20 spec→task fixtures) | Can answer "did this prompt/skill/effort change help?" from local data |

---

## 10. Open decisions

1. **API agents vs Claude Code agents for implementers.** Direct API = full control over
   caching, effort, envelopes; Claude Code via Agent SDK = mature coding toolset for free.
   Recommendation: Agent SDK for Implementers, direct API for Planner/Reviewer/Summarizer.
2. **Sandboxing.** Worktrees + command allowlist first; containers before running untrusted specs.
3. **Spec-change governance.** Human approval for `needs_spec_change` (recommended) vs
   Planner auto-approving trivial clarifications.
