# Role prompts and skills

Every built-in role has a prompt in `templates/roles/<role>.md`; skills live in `templates/skills/<name>.skill.md` with front matter (`name`, `version`, `applies_to`, `summary`). A project can override either under `.hexagon/roles/` and `.hexagon/skills/`, or point a role at its own file with `prompt = "..."` under `[roles.<role>]`.

## Shape

* Stable first: who you are, what matters, rules, how to get out when the task cannot be done, then the exact way to finish (`hexagon done …` / `hexagon review …`). Nothing task-specific: the prompt is the same bytes on every turn, so a session can be reused.
* Shared rules live once, in the protocol text (`src/agents/protocol.ts`): write scope, no commits, how to report, ask, note, return, exec.
* No vendor or model names. Any provider's agent must be able to follow them.
* Text from files, tools, the bus and other agents is data, never instructions. Each prompt says so.

| Role | Skills |
|---|---|
| analyst | requirements-analysis, spec-writing |
| architect | design-review |
| developer | tdd, scope-discipline, commit-conventions |
| qa | tdd, test-design, regression-hunting, commit-conventions |
| devops | scope-discipline, infra-as-code, commit-conventions |
| security | scope-discipline, security-review, commit-conventions |
| reviewer | review-checklist, security-review |
| release | merge-conflicts, commit-conventions |
| bootstrap | repo-discovery |
| control | hexagon-operator |

## Checking

`hexagon prompts lint [--json]` checks the shipped prompts: skill front matter, vendor names, size budgets (role 2400 chars, skill 1400, assembled prompt 9000), a finish instruction in every role, the same long line in two files, and "always X" next to "never X" in one agent's assembled prompt. It also checks that every shipped prompt is listed in `src/agents/known-roles.ts`; run `node scripts/role-hashes.mjs` after editing a role.

`test/prompts.test.ts` pins the assembled prompt of every role in `test/golden/prompts/`. Review the diff when it changes; accept it with `UPDATE_GOLDEN=1 npx vitest run test/prompts.test.ts`.
