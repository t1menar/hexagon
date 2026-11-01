# Spec-driven pipeline

A goal goes through gated stages. Each stage writes one artifact and Hexagon validates it before the next stage starts.

| Stage | Agent | Artifact | Checked for |
|---|---|---|---|
| analyze | analyst | `analysis.md` | sections: current state, constraints, risks, open questions, impacted areas |
| specify | analyst | `spec.md` (+ optional `design.md`) | spec lint (requirement ids, acceptance criteria); design: interfaces, data flow, trade-offs |
| **approve** | you | `.hexagon/approvals.json` | the spec exactly as on disk, hashed per requirement |
| plan | analyst | `plan.json` | `hexagon plan-check` |

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
