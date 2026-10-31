# Penalty Box

Phone-first offline web app (PWA) that youth ice hockey game clock operators use to track penalty time and expirations. Served from GitHub Pages; volunteers install it to their home screen and use it rinkside, often with no signal.

## Ground rules

- **No build step, no runtime dependencies.** Plain ES modules, HTML and CSS served as-is. Don't add a bundler, framework or npm package without asking first.
- **Hockey rules live only in `js/engine.js`.** It's pure: no DOM, no storage. The UI never does penalty math itself.
- **Every rules change gets a test** in `tests/engine.test.mjs`. If a scenario comes from a real game, add it as a test named after the situation.
- **Plan before editing.** For anything beyond a one-line fix, describe the plan and wait for approval.
- Correctness matters more than features: a wrong expiry time sends a player out of the box early in a real game. If a rule is uncertain, say so and point to the USA Hockey rulebook; don't guess.

## Commands

```bash
npm test                      # engine tests (Node 22+, node:test, no deps)
python -m http.server 8000    # run locally: http://localhost:8000
```

To test on a phone: run the server, then open `http://<PC's LAN IP>:8000` on the same Wi-Fi. The service worker only registers on https or localhost, so offline mode can only be tested on localhost or the live Pages site.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Markup. Team cards, entry sheet and action bar are filled in by `app.js` |
| `styles.css` | All styles. Color tokens on `:root`; dark-first with a light theme |
| `js/engine.js` | Rules engine: clock math, stacking, PPG release, schedule, snapshot |
| `js/app.js` | UI: render, entry sheet, log, export, setup, team list, storage |
| `js/teams.js` | Team colors (contrast math), logo resizing, team list, `teams.json` load/export |
| `sw.js` | Service worker (offline cache) |
| `teams.json` | Club team list shared with all volunteers (logos embedded as data URLs) |
| `tools/build_teams.py` | Turns a folder of logo images into `teams.json` (Pillow) |
| `logos/` | Source logo images, kept for reference. **Not used by the app.** |
| `tests/engine.test.mjs` | Engine scenario tests |

## How the engine works

- Every clock reading (period + countdown time remaining) converts to **elapsed game seconds** (`toElapsed`), and back with `toClock` / `fmtPosition`. Carry-over between periods falls out of that for free.
- `computeSchedule(config, penalties, goals)` re-simulates the **whole game from raw entries on every change**. Nothing is stored incrementally, so edits and deletes stay consistent. Keep it that way.
- `snapshot(schedule, elapsed)` gives the penalty clocks and on-ice strength at a moment in time.
- Rules modeled: 2-man max short (delayed penalties), the same player serving back-to-back, a PPG releasing the minor with the least time left, the double-minor halves, majors never released, misconducts not affecting strength, coincidental entries, and "served by". README has the full table.
- **A goal only releases a penalty when the scoring team has more skaters.** At 4 v 4 a goal releases nothing. This is correct; it has been questioned before.

## UI conventions

- Must work at **360 px** wide. The page must never scroll sideways: flex/grid children holding text get `min-width: 0`, and long text truncates with an ellipsis.
- Team colors flow through CSS variables set by `applyTeamColors()`. They are `--home`, `--away`, `-ink` (text on the color), `-t` (the color as readable text on the current theme) and `-edge` (an outline for white jerseys). Never hard-code team colors.
- Home is the left Penalty button, away the right. The Goal button in the middle shows the score as home–away.
- "Scoreboard now" only moves forward automatically, when a new entry is later than it.
- The page can't use `alert`/`confirm`; destructive actions use the two-tap `confirmTap()`.
- Fonts come from Google Fonts with system fallbacks. Check layout with the real fonts: the fallbacks are wider.

## Storage (localStorage, per phone)

- `penaltybox.v1`: current game (entries, config, team colors and logos). Bump `v` and migrate in `load()` if the shape changes.
- `penaltybox.teams.v1`: teams saved on this phone. These override club teams of the same name.
- `penaltybox.ui.v1`: which sections are collapsed.

## Releasing

1. Run `npm test`, then check the app at 360 px and 390 px in both dark and light themes.
2. **Bump `CACHE_VERSION` in `sw.js`** (`penaltybox-vN` → `vN+1`) whenever any app file changes. Without it, installed phones keep the old version. If you add a new app file, also add it to `APP_SHELL`.
3. You don't need to bump the version when only `teams.json` changes (it's fetched network-first).
4. Commit and push to `main`; GitHub Pages deploys automatically.
