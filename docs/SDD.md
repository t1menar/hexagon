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
