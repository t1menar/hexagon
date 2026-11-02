# Terminal UI: design and motion system

Hexagon's dashboard is a control room for a graph of agents. It is built on the in-house `Canvas` renderer
(character grid + style grid, diffed per line). No UI framework was added: the renderer already gives full control
over cells, which regular hexagon geometry and particle paths need, and avoids a heavy dependency.

## Visual identity

- **Square cards as the unit.** Agents are plain rectangular cards (square corners; dashed while queued). Edges are box-drawing
  lines (`═`/`║` once the source task is done), particles are small squares. The hexagon appears only in the brand mark
  (header logo, startup sequence).
- **Semantic colour tokens** (`src/tui/theme.ts`): `brand`, `brand2`, `text`, `muted`, `border`, `surface`,
  `success`, `warning`, `error`, `active`, `waiting`, `info`. Components use tokens, never raw colour codes.
  Colour depth: truecolor → 256 → 16 → none; `NO_COLOR` is honoured (bold/dim attributes only).
- **Never colour alone.** Every state has a symbol *and* a text label (`● WORKING`, `◷ WAITING · LIMIT`, `✖ FAILED`);
  provider identity is always text (`openai · codex 0.9`). ASCII fallbacks exist for every glyph.

## Layout (`src/tui/layout.ts`)

| Mode | Terminal | Regions |
|---|---|---|
| large | ≥150×30 | header · navigator (40) · network · inspector (38) · activity ‖ chat · input · shortcut bar |
| medium | ≥100×22 | header · navigator (36) · network · optional inspector (F2) · activity ‖ chat |
| small | smaller | header · one-line selected-agent strip · network · activity ‖ chat |

The inspector only opens while the network keeps at least 60 columns. `computeLayout` is pure; tests assert that regions never overlap and always fit, from 200×60 down to 40×16.

The **navigator** groups agents by role (ANALYSIS, IMPLEMENTATION, REVIEW, INTEGRATION). It degrades gracefully when
height is short: 4 lines per agent → 3 → 2, scrolling to keep the selection visible. Tab / ↑↓ follow the visual order.
The **inspector** separates *selection* (config: "native CLI default" or an override) from *runtime* model (what the
process reported, or "unknown (CLI-managed)"). Models are never hardcoded; they come from config, CLI discovery or runtime.

## Node cards (`src/tui/network.ts`)

```text
┌─ T-2 · implementer ────────┐   id · role in the frame
│  Build the API             │   task title
│  openai · codex 0.9        │   provider · CLI (text, never colour alone)
│  model: CLI-managed        │   runtime model only if the process reported it
│  ● WORKING                 │   state symbol + label (+ fix cycle)
│  ━━━━━━━────────── 40%     │   progress
├─ REVIEW ───────────────────┤
│  ○ not reviewed yet        │   review verdict, always in words
└────────────────────────────┘
```

Four sizes (30×9, 26×7, 23×7, 20×5) are chosen to fit the panel; the compact card drops model and bar first and keeps id, state and review.
Graphs that still do not fit are clipped without malformed shapes: only fully visible cards are reported and a "+N more" hint is shown.

### Edge routing

Orthogonal, with fixed ports: edges leave a card at its right-middle (`├`) and enter the target at its left-middle (`▸`).

- A source that has to change rows draws **one vertical trunk** in its own track column inside the gap; all its outgoing edges
  share it (fan-out). Different sources never share a column, so every crossing and junction in the picture is real.
- Track order avoids needless crossings: lower sources take the left tracks for downward edges, higher sources for upward ones.
- Gaps grow by one column per trunk (minimum 5), so dense graphs stay readable and sparse ones stay compact.
- Edges that skip layers pass through a one-row lane between cards instead of reserving a full card slot, which also keeps the graph short.
- Style carries state: dim for waiting, state colour for active, double line (`═ ║`) once the source task is done.
- The geometry (`Geometry.edges`) is exactly what is drawn, so particles follow the visible lines.

### Review design

Review is part of the card, so it is always clear which agent a verdict belongs to. The footer says one of:
`○ not reviewed yet` · `◐ in review` · `↩ changes requested (fix N)` · `✔ approved`. Two lanes carry the movement:

- **Rejection lane:** a dotted rail `╎` in the card's left gutter from the review row up to the work area, with `▲` at the top.
  On a rejection, particles climb the rail and the footer reads `▲ REJECTED → developer` for a couple of seconds.
- **Approval lane:** out of the review row through the right border (`▸`) and along the card's real outgoing edges toward integration;
  the footer reads `✔ APPROVED → integration`.

## Animation architecture (`src/tui/motion.ts`)

One `AnimationManager` owns all animation:

- **Elapsed-time based**, never frame-count based. A `Clock` is injected; `FakeClock` makes tests deterministic.
- **Demand-driven.** Idle means no timer armed and no redraws. A frame is produced only when something was invalidated, a tween/particle
  is alive, or a *hold* is active. Holds are continuous effects with their own frame rate: `live` (an agent is working, at the
  manager fps) and `wait` (only quota waits, 4 fps). A 1 s housekeeping tick redraws only if the minute changed, a notice expired or
  a run is live (elapsed time).
- **Primitives:** `tween` (easing), `timeline` (ordered steps), `spawn` (particles), `cancel(tag)`, `cancelAll`, `dispose`. Timers are `unref`'d.
- **Modes:** `full` (24 fps), `reduced` (8 fps, no ambient particles; default over SSH), `off` (end states applied immediately).

### Particles

A pool of 48 small squares (bounded, priority replacement: review/completion/recovery beat execution/information beat ambient).
Paths are polylines taken from the *real drawn edges* of the network (`Geometry.edges`, `Geometry.reviewers`). Particles are
drawn onto the network canvas **before** it is blitted, and only land on blank cells or connection lines, so they can never
cover a label or node outline.

### Director (`src/tui/director.ts`): events → effects

Nothing animates on a timer of its own and nothing is invented; if an event lacks enough information it only enters the activity timeline.

| Real event | Effect |
|---|---|
| agent `starting` | activation sweep, execution particles along incoming edges |
| agent working | perimeter arc (hold) |
| `tool_call` | one small execution pulse (rate-limited) |
| message between agents with a dependency edge | information particles along that edge, flash |
| `reviewing` | review footer highlight |
| `fix_cycle` while `reviewing` | **rejection**: particles up the rejection rail, footer says REJECTED, warning flash |
| `fix_cycle` otherwise | verification failure: logged only |
| `reviewing → merging` | **approval**: completion particles out of the review row and along outgoing edges |
| `waiting_quota` | restrained: slow arc, reset time as text, no particles |
| `waiting_quota → running` | recovery sweep + flash + recovery particles |
| `done` | success flash and sweep |
| `failed` / `blocked` | static, logged |

On start the director is *seeded* with the current state, so old completions are never replayed.

### Startup (`src/tui/startup.ts`)

A 1.5 s assembly (centre hexagon, six neighbours, outer ring, "H E X A G O N") that reveals the panels top-down. Any key skips it.
Disabled when motion is off, over `ui.startup_animation = false`, or `HEXAGON_STARTUP=off`.

## Approval dialog and command broker

Agents ask for commands through `hexagon exec | install | sudo`; the daemon blocks that call until the user decides. `app.ts` opens a modal (`approvalModal`, `drawApproval`) with the command, who asks, why, and the folder it runs in. Keys: the choice key (`y` once, `a` always, `*` all, `n` deny, `t` terminal for sudo), `Enter` = first choice, `Esc` = decide later (header badge `⚠ N approvals waiting`), `F5` reopens. The dialog swallows other keys while open. See the README for the user view.

## Where the work is

`run.changes` (daemon) returns branches, worktrees, files and line counts; the TUI refreshes it at most every 3 s and shows it as the header chip, the inspector sections **WHERE THE WORK IS** / **WORKSPACE**, and `/changes`.

## Screenshots

`npx tsx scripts/screens.ts` renders the real `App` against a fake daemon and converts the ANSI output to `docs/img/*.svg` (used by the README).

## Configuration

```toml
[ui]
animation = "auto"        # auto (= full; reduced over SSH) | full | reduced | off
startup_animation = true
inspector = true
```

Environment: `HEXAGON_ANIMATION` (auto|full|reduced|off), `NO_MOTION`, `REDUCE_MOTION`, `HEXAGON_STARTUP=off`, `HEXAGON_ASCII=1`,
`HEXAGON_CELL_ASPECT`, `NO_COLOR`. `SSH_*` → reduced motion. Non-TTY / `TERM=dumb` → no animation.

## Keyboard

| Key | Action |
|---|---|
| Tab / Shift-Tab, ↑ ↓ (empty input) | move through agents, in navigator order |
| Enter | send / run the draft plan |
| F1 | help (command list) |
| F2 | toggle the inspector |
| F3 | toggle motion (`/animate [full\|reduced\|off]`) |
| F4 | agents, providers, CLI versions, discovered models (`/agents`) |
| Alt-Enter / Ctrl-J / trailing `\` | new line in the input (up to six rows; ↑ ↓ move between lines) |
| PgUp / PgDn, wheel | scroll the chat (wheel over the agent list: move the selection) |
| click | select an agent in the list or the graph (`[ui] mouse`, `HEXAGON_MOUSE=off`; Shift-drag selects text) |
| ^T / ^O / ^D | take over / open window / diff |
| / and @ | commands and mentions with completion |
| ^C ^C | quit (agents keep running) |

All earlier commands are unchanged.

## Tests

`test/motion.test.ts` (clock, tweens, timelines, holds, cancellation, cleanup, particle pool/occlusion), `test/director.test.ts`
(event → effect mapping, no replay, restraint), `test/network.test.ts` (geometry, responsiveness, colour/ASCII/still modes,
performance), `test/layout.test.ts` (no overlap across sizes), `test/dashboard.test.ts` (the real `App` against a fake daemon:
layouts, identity, idle = no frames, bounded frame rate, cleanup). Visual states are in [TUI-SNAPSHOTS.md](TUI-SNAPSHOTS.md)
(regenerate with `npx tsx scripts/tui-snapshots.ts`).

## Known limitations

- Truecolour gradients degrade to the nearest 256/16 colour; in 16-colour terminals highlights are coarser.
- Cell aspect is auto-detected from env and defaults to 2; terminals with unusual cell shapes need `HEXAGON_CELL_ASPECT`.
- Very large graphs (about 20+ agents) are clipped in the network panel; the navigator always lists every agent.
- Mouse input is not supported.


## Graph and progress

* The drawn graph is the **transitive reduction** of the plan: an edge is dropped when another dependency of the same task already implies it. The order is unchanged.
* **Progress** is the stage a task is in plus, while it works, the share of its acceptance criteria that are done: preparing 2% · working 5–65% by criteria · verifying 70% · reviewing 85% · integrating 97% · done 100%. With no criteria the work stage shows its floor, not a guess. A fix cycle moves a task back. The header shows the mean over all tasks.

## Bus traffic

Messages on the agent bus travel the dependency edge between the two tasks as particles (more for a bigger payload; handoffs, findings and decisions have their own colour). Messages without an edge, or to a role or topic, fan out from the sender; nothing is drawn that did not happen. Model calls only pulse the card.

## Cost

A 40-task frame renders in ~1.8 ms; an unchanged frame writes ~140 bytes (only changed lines are sent). Session pushes carry only the new feed lines: 42.5 KB → 0.4 KB per event.

## Style: minimal (default) or classic

`[ui].style = "minimal" | "classic"` (or `HEXAGON_UI_STYLE`). Minimal draws the dashboard as one grid of solid rules with rounded corners and real junctions: neighbouring panels share a rule, titles are dim text inside it, focus changes the title colour only. The input is `› text`, a rule and one dim status line; the full key list is behind `?` / F1. Cards use one rounded solid border for every state; edge activity recolors the line (it never draws a glyph over it). Feed lines are unboxed (`⏺ what happened`, `  ⎿ tool call`). Classic keeps the framed panels, the bar input and the dashed queued cards.

## Input latency

A key press repaints at the next ~16 ms slot, not at the animation rate. While you type (text in the box, or a key in the last 1.5 s) ambient effects and the continuous "working" effect release their timers and come back afterwards. Full motion is capped at 15 fps (8 fps for the working effect), frames are skipped while stdout has not drained, and ambient hexagons are off unless `ui.ambient = true` or `HEXAGON_AMBIENT=on`. Measured in `test/input-latency.test.ts`: an invalidate under a 4 fps hold took ~190 ms before, under 60 ms now (timer-level, not end-to-end terminal latency).
