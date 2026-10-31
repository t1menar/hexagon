# Hexagon

Terminal orchestrator for spec-driven development with multiple AI coding agents
(Claude, OpenAI CLI, DeepSeek, …) running in parallel.

- **Specs are the source of truth** — markdown requirements with acceptance criteria are
  broken into a task DAG, implemented in isolated git worktrees, verified, reviewed and merged.
- **Rich terminal UI** — live dashboard of every agent: state, progress, tokens, cost.
- **Reusable skills** — versioned markdown workflow instructions compiled into each agent's prompt.
- **Personal metrics** — local-only records of agent usage and output quality, for your own
  analysis. Nothing is exported.

Status: design phase. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
