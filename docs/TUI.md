# Terminal UI: design and motion system

Hexagon's dashboard is a control room for a graph of agents. It is built on the in-house `Canvas` renderer
(character grid + style grid, diffed per line). No UI framework was added: the renderer already gives full control
over cells, which regular hexagon geometry and particle paths need, and avoids a heavy dependency.

## Visual identity

- **Hexagon as the unit.** Agents are regular hexagons ("molecules"); reviewer satellites are small `⬡/⬢`; particles
  are micro hexagons/dots. Bonds are box-drawing lines (`═`/`║` once the source task is done).
- **Semantic colour tokens** (`src/tui/theme.ts`): `brand`, `brand2`, `text`, `muted`, `border`, `surface`,
  `success`, `warning`, `error`, `active`, `waiting`, `info`. Components use tokens, never raw colour codes.
  Colour depth: truecolor → 256 → 16 → none; `NO_COLOR` is honoured (bold/dim attributes only).
- **Never colour alone.** Every state has a symbol *and* a text label (`● WORKING`, `◷ WAITING · LIMIT`, `✖ FAILED`);
  provider identity is always text (`openai · codex 0.9`). ASCII fallbacks exist for every glyph.

## Layout (`src/tui/layout.ts`)

| Mode | Terminal | Regions |
|---|---|---|
| large | ≥124×30 | header · navigator (32) · network · inspector (38) · activity ‖ chat · input · shortcut bar |
| medium | ≥90×22 | header · navigator (28) · network · optional inspector (F2) · activity ‖ chat |
| small | smaller | header · one-line selected-agent strip · network · activity ‖ chat |

`computeLayout` is pure; tests assert that regions never overlap and always fit, from 200×60 down to 40×16.

The **navigator** groups agents by role (ANALYSIS, IMPLEMENTATION, REVIEW, INTEGRATION). It degrades gracefully when
height is short: 4 lines per agent → 3 → 2, scrolling to keep the selection visible. Tab / ↑↓ follow the visual order.
The **inspector** separates *selection* (config: "native CLI default" or an override) from *runtime* model (what the
process reported, or "unknown (CLI-managed)"). Models are never hardcoded; they come from config, CLI discovery or runtime.

## Node geometry (`src/tui/hex.ts`, `network.ts`)

Terminal cells are ~2× taller than wide, so a hexagon must be corrected for the cell aspect (auto-detected, or
`HEXAGON_CELL_ASPECT`). For `r` rows per half and `k` columns per row, the flat-top outline has `top = round(r·hypot(k, aspect))`,
width `top + 2rk`, height `2r`; tests assert all six sides are within ~12% of equal physical length. The network picks the
largest `r` (5→2) that fits; below that it is compact (title/provider dropped first, id and state kept). A graph that still
does not fit is clipped without malformed shapes: only fully visible nodes are reported and a "+N more" hint is shown.

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

A pool of 48 (bounded, priority replacement: review/completion/recovery beat execution/information beat ambient).
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
| `reviewing` | reviewer satellite highlight |
| `fix_cycle` while `reviewing` | **rejection**: review particles from satellite back to the developer, warning flash |
| `fix_cycle` otherwise | verification failure: logged only |
| `reviewing → merging` | **approval**: completion particles from the satellite along outgoing edges |
| `waiting_quota` | restrained: slow arc, reset time as text, no particles |
| `waiting_quota → running` | recovery sweep + flash + recovery particles |
| `done` | success flash and sweep |
| `failed` / `blocked` | static, logged |

On start the director is *seeded* with the current state, so old completions are never replayed.

### Startup (`src/tui/startup.ts`)

A 1.5 s assembly (centre hexagon, six neighbours, outer ring, "H E X A G O N") that reveals the panels top-down. Any key skips it.
Disabled when motion is off, over `ui.startup_animation = false`, or `HEXAGON_STARTUP=off`.

## Configuration

```toml
[ui]
animation = "auto"        # auto | full | reduced | off
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
| PgUp / PgDn | scroll the chat |
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
