# Spec-driven pipeline

A goal goes through gated stages. Each stage writes one artifact and Hexagon validates it before the next stage starts.

| Stage | Agent | Artifact | Checked for |
|---|---|---|---|
| analyze | analyst | `analysis.md` | sections: current state, constraints, risks, open questions, mode, impacted areas |
| specify | analyst | `spec.md` (+ optional `design.md`) | spec lint (requirement ids, acceptance criteria); design: interfaces, data flow, trade-offs |
| **approve** | you | `.hexagon/approvals.json` | the spec exactly as on disk, hashed per requirement |
| plan | analyst | `plan.json` | `hexagon plan-check` |

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
