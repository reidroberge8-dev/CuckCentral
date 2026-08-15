# 2026 Fantasy Draft Board (live-synced)

Static site: open `index.html` in a browser, or host it (GitHub Pages, Netlify, etc).

## What it does
- Loads `data/players.json` — 816 players (QB/RB/WR/TE/DL/LB/DB) projected with your
  league's custom scoring, ranked by position.
- Polls the Google Sheet draft board every 20 seconds (and on manual "Refresh")
  and marks any player already picked as "DRAFTED" (dimmed row, strikethrough name).
- Sortable/searchable table, position filter chips, "hide drafted" toggle.
- Left sidebar: a live "Reid/Mike Roster" panel showing every player your team
  (Reid/Mike) has drafted, auto-slotted into your actual ESPN roster shape —
  QB, 2 RB, 2 WR, TE, DL, LB, DB, D/ST, K, plus RB/WR and WR/TE flex, then
  5 bench slots + 1 IR slot. Empty slots show "— empty —". This is a
  *best-lineup suggestion* based on projected points, not a read of manual
  bench/start decisions (the draft sheet has no way to know those).

## Deploying to GitHub Pages
1. Create a new repo (e.g. `ff-draft-board-2026`) on github.com, public visibility.
2. Upload these 4 items via the web UI "Add file > Upload files":
   `index.html`, `style.css`, `app.js`, and the `data/` folder (with `players.json` inside).
3. Repo Settings > Pages > Deploy from branch > `main` / root. Wait ~1 min, then the
   site is live at `https://<your-username>.github.io/ff-draft-board-2026/`.
4. Share that URL with your league.

No build step, no server, no git needed locally — the browser does everything,
including the live poll against the Google Sheet's public CSV export.

## How live sync works (and its one real limitation)
The Google Sheet must stay shared as "Anyone with the link can view" (already the
case). The site polls this public export URL — no login required:
`https://docs.google.com/spreadsheets/d/1fafkiGG5Exs1UOOv17lazFbzf9jRm2j0JDX7IuX8jYw/gviz/tq?tqx=out:csv&gid=0`

I confirmed Google's server sends CORS headers that allow any origin to fetch this
URL from a browser, so this will work once hosted anywhere (tested against curl
with a GitHub Pages Origin header — got back a matching
`Access-Control-Allow-Origin`).

The site finds the draft picks by scanning for the "1, 2, 3..." pick-number
sequence in column B, rather than a hardcoded row range — this is intentional so a
sheet insert/delete row doesn't quietly break the sync.

## Known projection-math limitation
Custom fantasy points are computed from Mike Clay's 2026 ESPN season-total
projections. They do NOT include 40+/50+ yard TD bonuses or 100/200/300/400-yard
game bonuses, since those only exist in game-log data, not season totals. Treat
"Proj Pts" as very close but not exact for players who rack up long TDs or huge
single games.

## Roster sidebar details
- Team match: the sidebar looks for a column header matching "Reid/Mike"
  (case/typo tolerant — matches the sheet's actual "Reid/MIke" spelling too).
  If your team name in the sheet ever changes, update `MY_TEAM_NAME` at the
  top of `app.js` to match.
- IDP slot mapping: the sheet's specific position labels (DE, DT, CB, S, etc.)
  are collapsed onto the combined DL / DB categories used in the projections
  data, matching how the league's DL and DB slots work (one combined slot
  each, no sub-position limit).
- K and D/ST aren't in the Clay projection set (it only covers offensive
  skill positions and IDP), so if you draft a kicker or defense they'll show
  up in the roster with a blank points column — that's expected, not a bug.

## Files
- `index.html` / `style.css` / `app.js` — the site
- `data/players.json` — the 816-player projection dataset (custom-scored, ranked)
<!-- token-auth push test Sat Aug 15 19:37:50 UTC 2026 -->
