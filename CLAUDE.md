# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hexagon is a terminal orchestrator that runs several coding-agent CLIs (Claude Code by default, any other via adapters) in parallel on one goal, each in its own git worktree. TypeScript, ESM, Node ≥ 22, shipped as a standalone Node SEA binary. No API integration: agents are wrapped CLI sessions (`claude -p` stream-json) that report back by running `hexagon report|ask|note|done|…` shell commands. README.md is the full user-facing reference.

## Commands

```bash
npm run typecheck                 # tsc --noEmit
npm run build                     # role-hashes script + tsc → dist/
npm test                          # vitest run (test/**/*.test.ts)
npx vitest run test/bus.test.ts   # single file
npx vitest run -t "name pattern"  # single test by name
HEXAGON_REAL_CLI=claude npx vitest run test/conformance.test.ts   # adapter-conformance against the real CLI (costs tokens)
npm run install:bin               # build + standalone binary → ~/.local/bin/hexagon
```

- `npm run build` only updates `dist/`; the `hexagon` on your PATH is the SEA binary, so re-run `npm run install:bin` after source changes before trying them by hand.
- Tests set `HEXAGON_NO_REAL_CLI=1` and a temp `HEXAGON_STATE_DIR` (see `vitest.config.ts`), so they never touch the real CLI or user state unless `HEXAGON_REAL_CLI` is set.
- For offline/free manual runs, set `agent = "mock"` for every role in `.hexagon/config.toml`.

## Architecture

Process model: `src/cli.ts` (commands) and `src/tui/` (full-screen dashboard, built-in ANSI renderer, no Ink) talk through `src/client/` to a background **daemon** (`src/daemon/`: `server`, `orchestrator`, `run`, `broker`, `control`, `auth`). The daemon keeps running when the TUI is closed. Orchestration logic lives in `src/core/`.

Key pieces to understand across files:

- **Adapters** (`src/agents/`): `contracts/` defines the `AgentAdapter` interface and shared base/capabilities/errors; `claude-code.ts`, `codex.ts`, `grok.ts`, `exec.ts` (any one-shot CLI), `mock.ts`, `oneshot.ts` implement it; `adapter-registry.ts`/`registry.ts` resolve them. Adding a provider: `docs/ADDING_PROVIDER.md`, `examples/acme-provider.ts`. Native session handles belong to the *session*, not the adapter instance. Runs that report no usage are "unknown", not zero.
- **Conformance**: `test/adapter-conformance.ts` is the shared suite every adapter must pass (fake CLI always, real CLI opt-in).
- **Hub-and-spoke messaging**: agents never talk directly; everything goes through `core/router.ts`/`core/bus.ts` (see `docs/COMMUNICATION.md`). Everything is an event on one append-only log that the TUI, metrics and recovery read.
- **Pipeline** (`core/pipeline.ts`, `scheduler.ts`, `supervisor.ts`, `plan.ts`, `spec.ts`): goal → planner writes `specs/*.spec.md` + task graph → user approves → per task: worktree from the integration branch → agent implements → out-of-scope edits reverted → commit → verify commands re-run → reviewer agent → merge into `hexagon/<run>/integration` → `/merge` into the user's branch. Scheduling uses deps, file leases and `-j N`.
- **Contracts**: JSON schemas in `schemas/` (status, message, plan, result), validated via `src/contracts/validate.ts` (ajv). Agents publish a schema-validated `status.json`.
- **Prompts**: role prompts/skills live in `templates/` and are checked by `hexagon prompts lint` (`core/promptlint.ts`, `test/prompts.test.ts`); `scripts/role-hashes.mjs` runs as part of build.
- **Typed command API**: `core/commands.ts` is the single definition used by the CLI, the assistant (`hexagon do`), and docs.
- **Docs** in `docs/` (ARCHITECTURE, COMMUNICATION, PROVIDERS, RECOVERY, SDD, SECURITY, TOKENS, TUI). ARCHITECTURE.md is partly historical (see its status note); PROVIDERS/RECOVERY/ADDING_PROVIDER reflect the implemented provider-independent design.

## Project rules

- **Metrics are personal and local-only**: no export, upload, or team/shared views of usage/quality metrics (`test/neutrality.test.ts`-style checks guard provider neutrality too: no vendor model names shipped as defaults; each CLI keeps its own default model).
- TUI changes are covered by snapshot/golden tests (`test/golden`, `scripts/tui-snapshots.ts`, `docs/TUI-SNAPSHOTS.md`); regenerate deliberately.
