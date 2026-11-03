# Spec-driven pipeline

A goal goes through gated stages. Each stage writes one artifact and Hexagon validates it before the next stage starts.

| Stage | Agent | Artifact | Checked for |
|---|---|---|---|
| analyze | analyst | `analysis.md` (+ `questions.json`) | sections: current state, constraints, risks, open questions, confidence, mode, impacted areas; the clarify rules below |
| **clarify** (only when the analyst has questions) | you | `answers.md` | every question answered, or the defaults accepted; nothing is specified before that |
| spike (only when analyze is uncertain) | analyst, read-only | `spike.md` | every `S-n` answered with `file:line` evidence, then a decision |
| specify | analyst | `spec.md` (+ optional `design.md`) | spec lint (requirement ids, acceptance criteria); design: interfaces, data flow, trade-offs |
| **approve** | you | `.hexagon/approvals.json` | the spec exactly as on disk, hashed per requirement |
| plan | analyst | `plan.json` | `hexagon plan-check` |
| replan (only when a running plan breaks) | analyst | `replan.json` (+ patched `spec.md`) | graph commands only, never a started task |

```
goal → analyze → [clarify] → [spike] → specify → approve (card) → plan (card) → run → merge
                                          ↑                          │
                                          └── replan ← blocked(plan) / needs_spec_change / spec edited after approval
```

It is not a one-way waterfall: findings during the run flow back into the spec and the tasks that have not started.

## Asking you first (clarify)

The analyst states `Confidence: low|medium|high` and, if more than one design is viable, `Approaches` (`- A-1: …`). `Open questions: none` passes only with confidence high **and** a known delivery target; low confidence, listed open questions, several approaches, or an unknown delivery target require `questions.json`: 3-7 entries `{id, question, why_it_matters, options[], default, blocking, topic?}`. Hexagon validates it (a `delivery.push` question when delivery is unknown, a `design` question when there are approaches, the default among the options), shows the batch in the TUI and holds the pipeline.

* `/answer Q-n <text>` (or `hexagon answer Q-n <text>`): an option number picks that option; `/answer defaults` (`hexagon answer --defaults`) accepts every default. Answers are written to `answers.md` (defaults are marked) and passed to the spike/specify stage as binding decisions. Free-text feedback is refused while questions are open.
* `[sdd] ask = minimal|normal|thorough` (default `normal`): minimal asks only when confidence is low or designs differ and never about delivery; thorough also asks below high confidence.
* The delivery block (`delivery.push`, `.remote`, `.pr`, `.branch`, `.merge`) is persisted to `[delivery] remote, push, pr` in `config.toml` after the first answer; a project that answered it is never asked again (answered delivery questions are dropped from later batches).
* After `/merge`, if `[delivery]` asks for a push or a pull request, Hexagon only tells you: `hexagon deliver` shows the commands, `hexagon deliver --yes` (`/deliver yes`) runs them (`git push <remote> <base>`, or with `pr = true` push the integration branch and `gh pr create`).

## The brief (spec-then-implement in the agent's own context)

Before a developer, qa, devops or security agent edits a product file, it writes `.hexagon/runs/<run>/tasks/<T-n>/brief.md` with `hexagon brief write` (text on stdin; the agent cannot write outside its worktree, the daemon owns the file): **Goal** (1-2 lines), **Files to change** (`file:line` anchors or `(new)`), **Approach**, **Decisions and assumptions**, **Risks**, **Verification** (every acceptance id mapped to a command or test). `hexagon brief check` explains what is missing and prints a skeleton.

* `[run] task_brief = required|optional|off` (default `required`). Required: `hexagon done` (status completed) is refused without a valid brief and at least one Progress line; product files that were already modified (by mtime) when the brief became valid are warned about once, then reverted like out-of-scope edits. The solo/assistant path does not create tasks, so it has no brief.
* Living log: `hexagon brief append progress|found "<line>"` adds dated lines.
* `[run] brief_review = off|auto|user`: with `user` (every task) or `auto` (tasks with `estimate.risk` high/risky/critical, or whose write scope looks like an interface: api, interfaces, contracts, schemas, proto, openapi, `*.d.ts`) the user is asked to approve the brief before the agent goes on.
* The reviewer receives the brief with the diff and checks the diff against it and the spec.
* Restart without re-learning: the compaction summary (`compact.md`) and the last thing that sent the work back (`failure.md`) are persisted next to the brief. A new session or attempt for the task starts with `<resume>`: the brief, current diffstat and last failure (the summary arrives as before); a resumed turn begins "Read your brief first".
* Handoff envelopes to downstream tasks carry the brief's path in `fields.brief`.

## Exploring first (spike)

If the analysis says the cause is unknown, the change is cross-cutting, or the boundaries are unclear, it must contain a `## Spike` section (`S-n` questions) or analysis validation fails (`[run].require_spike`, default on). A spike is a read-only investigation by the analyst: it reads and runs nothing that changes the repo, writes `spike.md` (findings with `file:line` per question, then the decision), and the specify step is told to build on that decision. No sandbox experiments yet.

## What you read at a gate

Both gates show a card of at most five bullets: what will change, how it will be verified, the plan smells (task without verify or with a verify that passes whatever the code does, no requirement cited, parallel tasks writing the same files, a shared interface without a contract task) and the files to read in full. Nothing is approved by showing it.

## When the plan breaks (replan)

A task blocked by the plan itself, an agent answer of `needs_spec_change`, or a requirement edited after approval, asks the analyst for a minimal change: a patch to the spec (per-requirement hashes show what moved) plus `graph.*` edits to tasks that have not started. It arrives as one proposal showing both. `/apply` re-approves the patched spec, edits the live graph and retries the blocked task; `/reject` leaves everything as it was. Started and finished tasks are never edited. If the analyst is busy the Assistant is asked instead. Tool and scope blocks are not replans: they point at `hexagon exec/install` and `scope request`. A requirement changed after approval gates the tasks citing it and sends the first gated one to replan once (not in unattended runs, `HEXAGON_NO_CHECKPOINT=1`, which keep the plain gate).

## Checkpoint after the first merge

In a graph of two or more tasks the run pauses after the first task merges (`[run].checkpoint_after_first`, default on): look at `/changes`, then `/resume`, or change course with `/respec`, `/add`, `/rm`, `/link`. Resumed runs and `HEXAGON_NO_CHECKPOINT=1` skip it.

## Parallel tasks and shared interfaces

Two tasks that run in parallel and share an interface (one exports what the other imports) need a contract task both wait for: the plan check warns without one. A task that lists acceptance criteria needs a verify command that names a test file or selector; a bare `npm test` does not show a criterion is met (skipped for single-task mode).

## Modes: single-task or graph

The analyst picks (and you can override with `/sdd --mode dag|single-task <goal>` or `hexagon sdd --mode …`) how much machinery the request gets:

| Mode | What runs | Use it when |
|---|---|---|
| `solo` | advice only: ask the Assistant in chat (the pipeline still runs one checked task) | one small edit with a known cause |
| `single-task` (default) | **one task, one agent, the whole repository as scope**; no file masks, no graph. Verify, mutation-checked evidence, review and test-integrity all still run | small or unclear work, or slices that share files |
| `dag` | several tasks with disjoint write scopes, run in parallel | three or more modules with slices that are truly independent |

A graph costs coordination: disjoint masks, leases, merges. Choose it only when parallel work pays for that. Drafts made before modes existed stay graphs. Not a benchmark claim: nobody has measured here which mode produces better code.

## What Hexagon checks on every task

* **Scope.** Changes outside the task's write mask are not reverted the first time: the agent is told which paths, its mask and its options, and reverts only follow a repeat. Reverted paths are shown to the reviewer. A task needing a lockfile or index file asks with `hexagon scope request <path> --why …` (granted at once if no running task holds it; otherwise you decide; `[run].shared_files` stay with the integration).
* **Verify.** A verify command that passes whatever the code does (`true`, `echo`, `ls` …) is refused by the plan check. After each merge, `[run].integration_verify` (`task` | `merged` (default) | `full`) re-runs this task's verify, plus those of tasks already merged, plus `final_verify` for `full`. A failure names the task whose check broke and the merge is undone.
* **Evidence.** A test the agent claims is *verified* only if it fails when the task's product files are reverted to the base (the mutation check). `[run].test_command` (e.g. `npx vitest run {file} -t {name}`) runs just that test; without it the task's verify commands are re-run, which is coarser. A task that changes no product file cannot show this and stays "claimed".
* **Review.** The reviewer may ask you a product question (`hexagon review question`), at most twice, and the answer returns into the same review.
* **Blocked.** A block caused by a missing tool or a scope problem points at `hexagon exec/install` or `scope request`. Only a block caused by the plan itself asks the Assistant to propose edits to the tasks that have not started (you confirm with `/apply`); it cannot change the spec.

## The gate

* Nothing is planned until you approve the spec: **Enter** on the analyst tab, `/approve-spec [file]`, or `hexagon approve-spec [file]`. Typing text instead asks the analyst to revise.
* A spec with lint errors cannot be approved.
* A task that cites requirements only starts if every cited spec is approved and each cited requirement still has the approved hash. `run.start` fails with `spec gate: …` otherwise; during a run the task is blocked with a notification.
* Editing a requirement after approval blocks only the tasks that cite it. Approve again (or `/respec <change>`) and those tasks resume.
* Tasks that cite no requirement are not gated.
* Changing `spec.md` after approval and before the plan is materialized is refused (`spec.md was changed after you approved it`).

Approvals are stored per spec file; hashes cover title, body and acceptance criteria of each requirement.

## Task lifecycle

`queued → preparing → working → verifying → reviewing → (fixing → verifying → reviewing)* → integrating → done`, plus `waiting_input`, `paused`, `waiting_quota`, `failed`, `blocked`, `cancelled`. `fixing` is `working` that answers a failed verification or a review rejection.

**Preparing** happens before the agent spends tokens, and its result is stored in `runs/<run>/agents/<task>-aN/prepare.json`:

1. The worktree is created from the integration branch head, so merged dependencies are in it (`base_commit`).
2. The tools the task's verify commands need are looked up (`tools`); missing ones become warnings, not failures.
3. Verify commands outside `allow_commands` are put to you now, once per command line (`denied_commands`), not in the middle of the task.
4. The verify commands run once on the fresh worktree (`baseline`, `[run] baseline = true`). The agent is told what already fails, so it does not chase it.
5. A short work plan is derived from the acceptance criteria (`steps`).

State names written before this (`starting`, `running`, `merging`) are still read: they load as `preparing`, `working`, `integrating`.
