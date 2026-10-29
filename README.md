# Penalty Box

A phone-first penalty tracker for youth ice hockey game clock operators. Enter a penalty with the game clock time, and it tells you when it expires — including period carry-over, stacked (delayed) penalties, power-play goal releases, double minors and misconducts.

It runs entirely in the browser: no server, no accounts, no data leaves the phone. After the first visit it works with no signal.

## Using it at the rink

1. Open the link once with signal, then **Add to Home Screen** (iPhone: Share → Add to Home Screen; Android/Chrome: ⋮ → Install app).
2. **Game setup**: team names, period lengths (e.g. 13:00), overtime, default minor (1:30 or 2:00).
3. Tap **+ Penalty** under a team → player #, type, length, period, game clock → **Add penalty**. The expiry shows before you save.
4. Tap **Goal** for every goal; the button shows the running score (home on the left, away on the right). If it is a power-play goal, the right penalty is released automatically and everything after it recalculates.
5. Type the scoreboard time into **Scoreboard now** to see exactly what each penalty clock should read and the current strength (e.g. `4 v 5`).
6. After the game: **Download CSV**, **Share CSV** (phones), or **Copy log**.

**Game setup** and **Team list** collapse: tap the heading. Collapsed Game setup still shows the matchup and period lengths. Each phone remembers which sections were open.

Clock entry fills from the right as you type: `1` → 0:01, `103` → 1:03, `1034` → 10:34.

## Team colors, logos and the team list

In **Game setup**, each team card has:

- **Saved teams…** to fill in name, color and logo from the team list in one tap.
- **Logo**: tap the square to pick an image (photo of a crest, downloaded logo, PNG/JPG/SVG). It's shrunk to 128 px (about 1–15 KB) and stored on the phone.
- **Color**: White (the usual home jersey), 12 common jersey colors, or the color wheel for an exact match. Set it to the jersey each team is wearing tonight so the Penalty buttons match the ice. **Save to team list** never overwrites a team's saved color with White. Button text switches between white and black automatically. Dark colors are lightened only where they're used as text on the dark theme.
- **Save to team list** stores the team for future games.

A warning appears if both teams pick nearly the same color.

### Sharing the team list with other volunteers

1. Set up each club team in the app and tap **Save to team list**.
2. In **Team list**, tap **Download teams.json** (or **Share teams.json** on a phone to send it to Files, Drive or email).
3. In the GitHub repo, **Add file → Upload files** → drop in `teams.json` (replace the existing one) → Commit.

Every volunteer's app loads the club list the next time it opens with signal, and keeps a copy for offline use. Teams someone saves on their own phone stay private to that phone; if they edit a club team, their copy wins on their phone only.

`teams.json` format (hand-editing is fine):

```json
{
  "version": 1,
  "teams": [
    { "name": "Hawks 12U", "color": "#c8102e", "logo": "logos/hawks.png" },
    { "name": "Bears 10U", "color": "#0b2346", "logo": "data:image/webp;base64,..." }
  ]
}
```

`logo` can be an embedded image (what the export produces) or a path to an image you upload into a `logos/` folder in the repo. `color` must be a 6-digit hex value. Invalid entries are skipped rather than breaking the app.

### Rebuilding the league list from a folder of logos

`tools/build_teams.py` turns a folder of logo images (PNG, JPG, WebP, AVIF) into `teams.json`: it trims borders, shrinks each logo to 128 px, embeds it, names the team from the file name (`RestonRaiders.png` → "Reston Raiders"), and suggests a color from the logo.

```bash
pip install pillow
python3 tools/build_teams.py path/to/logos teams.json contact-sheet.png
```

Open `contact-sheet.png` to check names and colors. Fix any name in `NAME_FIXES` and any color in `COLOR_OVERRIDES` at the top of the script, then run it again. To add one team later, it's easier to add it in the app and use **Download teams.json**.

## Rules the engine applies

| Situation | Behavior |
|---|---|
| Period carry-over | Remaining time carries into the next period using that period's length |
| Penalty at 0:00 | Starts with the next period |
| Third (or more) strength penalty | Delayed: starts when the earliest running one expires (team never below 3 skaters) |
| Same player, two penalties | Served back to back |
| Power-play goal | Releases the minor with the least time left; majors are never released |
| Double minor + PPG | 1st half: first half ends, second half starts fresh at the goal. 2nd half: penalty ends |
| Misconduct | No effect on strength; starts after the same player's other penalties |
| Coincidental (toggle) | Time runs, but no strength change and no PPG release |
| Served by | Queues against the server's number (goalie or bench penalties) |
| Game misconduct / Match | Logged only. Add the major or minor that goes with it as its own entry |

**Not modeled** (confirm with the referee): returning at stoppages for misconducts and delayed-penalty handoffs (shown as notes, not timed), special 3-on-3 overtime strength rules, penalty shots, and league-specific variations.

## Publish on GitHub Pages (about 5 minutes)

1. On github.com: **New repository** → name it `penalty-box` → Public → Create.
2. **Add file → Upload files** → drag in everything from this folder (keep the `js/` and `icons/` folders) → Commit.
3. **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. After a minute the site is live at `https://<your-username>.github.io/penalty-box/`. Share that link with the other volunteers.

Or from a terminal:

```bash
cd penalty-box
git init && git add . && git commit -m "Penalty Box v1"
gh repo create penalty-box --public --source=. --push
gh api repos/{owner}/penalty-box/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

### Shipping an update

Edit the files, bump `CACHE_VERSION` in `sw.js` (e.g. `penaltybox-v3` → `penaltybox-v4`), and push. Updating only `teams.json` or `logos/` does **not** need a version bump. Phones pick up the new version the next time the app is opened with signal (sometimes it takes a second open).

## Development

```bash
npm test                      # rules engine tests (Node 18+, no dependencies)
python3 -m http.server 8000   # then open http://localhost:8000
```

| File | Purpose |
|---|---|
| `js/engine.js` | Pure rules engine: clock math, stacking, PPG release. No DOM. |
| `js/app.js` | UI: forms, board, log, export, storage |
| `js/teams.js` | Team colors (contrast math), logo resizing, team list storage, `teams.json` load/export |
| `teams.json` | Club team list shared with every volunteer (starts empty) |
| `styles.css` | Layout and theme (dark and light follow the phone setting) |
| `sw.js` | Offline cache |
| `tests/engine.test.mjs` | Scenario tests for the engine |

Data is stored per device in `localStorage`. Clearing browser data or starting a **New game** erases the current game, so export first. **New game** keeps period settings and the team list, but resets the two team cards so you can pick the next opponents. Clearing browser data also erases teams saved only on that phone; club teams come back from `teams.json`.
