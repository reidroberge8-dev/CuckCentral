/* AR East Fantasy Draft Board — live sync app */

const SHEET_ID = '1fafkiGG5Exs1UOOv17lazFbzf9jRm2j0JDX7IuX8jYw';
const GID = '0';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`;
const SHEET_CSV_FALLBACK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;
const SHEET_VIEW_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${GID}`;
const POLL_MS = 20000;
// Draft grid location is detected dynamically (not hardcoded) because the
// exact row offset in the exported CSV does not reliably match the Sheet UI's
// row numbers (verified: pick rows land at 0-indexed rows 1-16, not 2-17 as a
// literal "C3:N18" reading would suggest). Detecting the pick-number column
// (sequential integers starting at 1 in column B) is robust to sheet edits.

// IDP (DL/LB/DB) are drafted in a separate process, not on this board.
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

// Team we're building the sidebar roster for. Matched against the sheet's
// header row case/punctuation-insensitively, so "Reid/Mike" vs the sheet's
// actual "Reid/MIke" typo still resolves.
const MY_TEAM_NAME = 'Reid/Mike';

// ESPN roster settings for this league (from league scoring/roster config).
// Order matters: exact-position slots are filled before flex slots so the
// best players land in their true slot and flexes get the next-best leftover.
const ROSTER_SLOTS = [
  { key: 'QB',   label: 'QB',    eligible: ['QB'] },
  { key: 'RB1',  label: 'RB',    eligible: ['RB'] },
  { key: 'RB2',  label: 'RB',    eligible: ['RB'] },
  { key: 'WR1',  label: 'WR',    eligible: ['WR'] },
  { key: 'WR2',  label: 'WR',    eligible: ['WR'] },
  { key: 'TE',   label: 'TE',    eligible: ['TE'] },
  { key: 'DST',  label: 'D/ST',  eligible: ['DST'] },
  { key: 'K',    label: 'K',     eligible: ['K'] },
  { key: 'RBWR', label: 'RB/WR', eligible: ['RB', 'WR'] },
  { key: 'WRTE', label: 'WR/TE', eligible: ['WR', 'TE'] },
];
const BENCH_SLOTS = 5; // + 1 IR shown separately, always empty (no IR status data available)

// ESPN's own position labels (as they appear in the sheet's "POS - TEAM(bye)"
// line) collapsed onto the combined IDP categories used in the projections
// dataset (DL = edge + interior, DB = corner + safety).
const POS_ALIAS = {
  DE: 'DL', DT: 'DL', EDGE: 'DL', IDL: 'DL', DL: 'DL',
  CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB', DB: 'DB',
  LB: 'LB', ILB: 'LB', OLB: 'LB', MLB: 'LB',
  QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE',
  DST: 'DST', DEF: 'DST',
  K: 'K', PK: 'K',
};
function mapSheetPos(raw) {
  const key = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  return POS_ALIAS[key] || key;
}
function normalizeTeamLabel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/on the clock:?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

let players = [];          // full player list from players.json
let draftedNames = new Set(); // normalized names currently drafted
let activePos = 'ALL';
let sortKey = 'espnRank';
let sortDir = 'asc';
let searchTerm = '';
let hideDrafted = false;
let showStarredOnly = false;
let showSleepersOnly = false;
let pollTimer = null;

document.getElementById('sheet-link').href = SHEET_VIEW_URL;
document.getElementById('sheet-link-btn').href = SHEET_VIEW_URL;

// ---------- starred players (persisted locally per-browser) ----------
const STAR_STORAGE_KEY = 'ffdb_starred_players';
let starredNames = new Set();
try {
  starredNames = new Set(JSON.parse(localStorage.getItem(STAR_STORAGE_KEY) || '[]'));
} catch (e) {
  starredNames = new Set();
}
function saveStarred() {
  try { localStorage.setItem(STAR_STORAGE_KEY, JSON.stringify([...starredNames])); } catch (e) { /* storage unavailable */ }
}
function toggleStar(norm) {
  if (starredNames.has(norm)) starredNames.delete(norm); else starredNames.add(norm);
  saveStarred();
}

// ---------- sleeper picks (persisted locally per-browser) ----------
const SLEEPER_STORAGE_KEY = 'ffdb_sleeper_players';
let sleeperNames = new Set();
try {
  sleeperNames = new Set(JSON.parse(localStorage.getItem(SLEEPER_STORAGE_KEY) || '[]'));
} catch (e) { sleeperNames = new Set(); }
function saveSleepers() {
  try { localStorage.setItem(SLEEPER_STORAGE_KEY, JSON.stringify([...sleeperNames])); } catch (e) {}
}
function toggleSleeper(norm) {
  if (sleeperNames.has(norm)) sleeperNames.delete(norm); else sleeperNames.add(norm);
  saveSleepers();
}

// ---------- target rounds (persisted locally per-browser) ----------
const TARGET_ROUNDS_KEY = 'ffdb_target_rounds';
let targetRounds = {};
try { targetRounds = JSON.parse(localStorage.getItem(TARGET_ROUNDS_KEY) || '{}'); } catch (e) {}
function saveTargetRounds() {
  try { localStorage.setItem(TARGET_ROUNDS_KEY, JSON.stringify(targetRounds)); } catch (e) {}
}

// ---------- player notes (persisted locally per-browser) ----------
const PLAYER_NOTES_KEY = 'ffdb_player_notes';
let playerNotes = {};
try { playerNotes = JSON.parse(localStorage.getItem(PLAYER_NOTES_KEY) || '{}'); } catch (e) {}
function savePlayerNotes() {
  try { localStorage.setItem(PLAYER_NOTES_KEY, JSON.stringify(playerNotes)); } catch (e) {}
}

// ---------- roster sidebar collapse (persisted locally per-browser) ----------
const ROSTER_COLLAPSE_KEY = 'ffdb_roster_collapsed';
let rosterCollapsed = false;
try { rosterCollapsed = localStorage.getItem(ROSTER_COLLAPSE_KEY) === '1'; } catch (e) { rosterCollapsed = false; }
function applyRosterCollapsed() {
  const sidebar = document.getElementById('roster-sidebar');
  const btn = document.getElementById('panel-toggle-top');
  sidebar.classList.toggle('collapsed', rosterCollapsed);
  btn.textContent = rosterCollapsed ? 'Show side panel' : 'Hide side panel';
  btn.title = rosterCollapsed ? 'Show side panel' : 'Hide side panel';
}

// ---------- recent draft activity (in-memory for this session) ----------
// Tracks every drafted-cell coordinate we've already seen so re-polling the
// sheet only surfaces genuinely new picks (by any team, not just ours).
let seenPickKeys = new Set();
let activityLog = []; // { team, name, pos, ts } newest first
const ACTIVITY_MAX = 10;
let initialSyncDone = false;
// Keys of picks logged during the most recent sync - these get the
// golden-outline/blink "just happened" treatment in renderActivity(), and
// lose it again once the next sync doesn't add anything new for them.
let freshKeys = new Set();
// Tracks whether MY_TEAM_NAME was on the clock as of the last sync, so the
// "your turn" ding only fires once on the transition, not every poll.
let wasMyTurn = false;
// True once the user has clicked the flashing on-clock banner to
// silence the animation for the current turn. Resets to false the next
// time it becomes (or stops being) our turn, so the flash comes back
// fresh on a future pick rather than staying muted forever.
let onClockAcked = false;
// Which team's roster to show / on-clock-watch. 'ALL' = show every team
// (starters-only compact view) and watch MY_TEAM_NAME for the ding.
const WATCH_TEAM_KEY = 'ffdb_watch_team';
let watchTeam = 'ALL';
try { watchTeam = localStorage.getItem(WATCH_TEAM_KEY) || 'ALL'; } catch(e) {}
// Cached sheet parse so the dropdown can re-render rosters without a re-fetch.
let cachedRows = null, cachedStart = -1, cachedEnd = -1;
let cachedTeamCols = [], cachedColTeamNames = {};
// Timestamp (ms) of the last successful sync, so the status line can show
// "Synced Xs ago" - a live-updating relative time is more useful mid-draft
// than a fixed clock reading you have to do the subtraction on yourself.
let lastSyncAt = null;
let lastDraftedCount = 0;

// The header's real height changes now that the on-clock banner can appear
// and disappear (it's empty/hidden between picks). Sticky panels below it
// read this CSS var instead of a value that would go stale the moment that
// banner's visibility changes.
function updateHeaderHeightVar() {
  const header = document.querySelector('header');
  if (!header) return;
  document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
}

// Relative-time formatter for the sync status line, e.g. "3s ago", "2m ago".
function formatAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return `${m}m ago`;
}

// Ticks the "Synced Xs ago" text every few seconds without waiting for the
// next poll, and only while the last sync actually succeeded - a sync error
// message shouldn't get silently overwritten by a stale success timestamp.
function tickSyncStatus() {
  if (lastSyncAt == null) return;
  const statusEl = document.getElementById('sync-status');
  if (statusEl.classList.contains('sync-error')) return;
  statusEl.textContent = `Synced ${formatAgo(lastSyncAt)}`;
}
function renderActivity() {
  const el = document.getElementById('activity-list');
  if (!activityLog.length) {
    el.innerHTML = '<div class="activity-empty">No picks yet.</div>';
    return;
  }
  el.innerHTML = activityLog.map(a => `<div class="activity-item${freshKeys.has(a.key) ? ' activity-fresh' : ''}">
      <span class="activity-team">${escapeHtml(a.team)}</span> drafted ${escapeHtml(a.name)}
      <span class="pos-badge pos-${a.pos}">${a.pos}</span>
      <span class="activity-time">${a.ts}</span>
    </div>`).join('');
}

// ---------- name normalization ----------
function normalizeName(raw) {
  if (!raw) return '';
  let s = raw.toLowerCase();
  s = s.replace(/\./g, '');
  s = s.replace(/'/g, '');
  s = s.replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/g, '');
  s = s.replace(/[^a-z0-9\s]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// ---------- stat formatting ----------
// Yardage stats are rounded to whole numbers; count/rate stats (TD, rec,
// tackles, sacks, INT, FF) keep one decimal since projections are often
// fractional (e.g. a backup DL projected for 0.2 INT on the season).
function fmtYds(v) { return v == null ? '-' : Math.round(v).toString(); }
function fmtStat(v) { return v == null ? '-' : Number(v).toFixed(1); }
function fmtAdp(v) { return v == null ? '-' : Number(v).toFixed(1); }

// Draft Sharks injury risk categories, mapped to badge label + CSS class.
const RISK_BADGE = {
  'Very Low Risk': { label: 'Very Low', cls: 'inj-vlow'  },
  'Low Risk':      { label: 'Low',      cls: 'inj-low'   },
  'Medium Risk':   { label: 'Medium',   cls: 'inj-med'   },
  'High Risk':     { label: 'High',     cls: 'inj-high'  },
  'Very High Risk':{ label: 'Very High',cls: 'inj-vhigh' },
};
function injuryCell(p) {
  const info = RISK_BADGE[p.injuryRisk];
  if (!info) return '<span class="inj-na">-</span>';
  return `<span class="inj-badge ${info.cls}" title="${p.injuryRisk}">${info.label}</span>`;
}

// Per-position sortable stat columns. The ALL tab now shows the union of
// all of these (see ALL_STAT_COLUMNS below) rather than a condensed
// summary line.
const STAT_COLUMNS_BY_POS = {
  QB: [
    { key: 'p_yds', label: 'Pass Yds', fmt: fmtYds },
    { key: 'p_td',  label: 'Pass TD',  fmt: fmtStat },
    { key: 'intc',  label: 'Int',      fmt: fmtStat },
    { key: 'ru_yds', label: 'Rush Yds', fmt: fmtYds },
    { key: 'ru_td', label: 'Rush TD',  fmt: fmtStat },
  ],
  RB: [
    { key: 'ru_yds', label: 'Rush Yds', fmt: fmtYds },
    { key: 'ru_td', label: 'Rush TD',  fmt: fmtStat },
    { key: 'rec',   label: 'Rec',      fmt: fmtStat },
    { key: 're_yd', label: 'Rec Yds',  fmt: fmtYds },
    { key: 're_td', label: 'Rec TD',   fmt: fmtStat },
  ],
  WR: [
    { key: 'rec',   label: 'Rec',      fmt: fmtStat },
    { key: 're_yd', label: 'Rec Yds',  fmt: fmtYds },
    { key: 're_td', label: 'Rec TD',   fmt: fmtStat },
    { key: 'ru_yds', label: 'Rush Yds', fmt: fmtYds },
  ],
  TE: [
    { key: 'rec',   label: 'Rec',      fmt: fmtStat },
    { key: 're_yd', label: 'Rec Yds',  fmt: fmtYds },
    { key: 're_td', label: 'Rec TD',   fmt: fmtStat },
  ],
  // K and D/ST have no real per-game stat lines in this dataset (no Clay
  // projection source covers them - see README) - just rank + estimated
  // Proj Pts, so an empty column list here is intentional, not a gap.
  K: [],
  DST: [],
};
// Full column set for the "ALL" tab: the deduped union of every
// position's individual stat columns (now that IDP is gone, this is only
// 8 columns total, not the 15+ it would have been with tkl/sack/ff mixed
// in, so showing them all at once is no longer too noisy).
const ALL_STAT_COLUMNS = [
  { key: 'p_yds',  label: 'Pass Yds', fmt: fmtYds },
  { key: 'p_td',   label: 'Pass TD',  fmt: fmtStat },
  { key: 'intc',   label: 'Int',      fmt: fmtStat },
  { key: 'ru_yds', label: 'Rush Yds', fmt: fmtYds },
  { key: 'ru_td',  label: 'Rush TD',  fmt: fmtStat },
  { key: 'rec',    label: 'Rec',      fmt: fmtStat },
  { key: 're_yd',  label: 'Rec Yds',  fmt: fmtYds },
  { key: 're_td',  label: 'Rec TD',   fmt: fmtStat },
];
function statColumnsFor(pos) {
  // In starred/sleeper-only views the projected-stats columns are hidden
  // so the board stays compact and focused on the annotation columns.
  if (showStarredOnly || showSleepersOnly) return [];
  return STAT_COLUMNS_BY_POS[pos] || ALL_STAT_COLUMNS;
}

// ---------- data load ----------
async function loadPlayers() {
  const res = await fetch('data/players.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`players.json fetch failed: ${res.status}`);
  const allPlayers = await res.json();
  // IDP (DL/LB/DB) are drafted separately, not on this board.
  players = allPlayers.filter(p => POSITIONS.includes(p.pos));
  players.forEach(p => { p._norm = normalizeName(p.name); });
}

// ---------- sheet sync ----------
// The plain /export?format=csv endpoint is the primary source - it exports
// exactly one CSV row per sheet row. The /gviz/tq endpoint (tried second,
// only as a fallback if export is unreachable) has a real quirk on this
// sheet: because a label cell in column A visually spans the "Standard" and
// "Top Available" header rows, gviz collapses those two sheet rows into one
// CSV row and space-joins every column's two values together wherever both
// happen to be non-empty. On this sheet that corrupts the "On the Clock: X"
// cell specifically (the row directly below it, "Top Available", happens to
// have a real value in that exact column), turning it into "On the Clock: X
// Y" - a second team's name silently glued onto the real one. Every prior
// build/test in this project used export CSV directly, so this bug only
// ever showed up live, never in the test harness, until this was found.
async function fetchSheetCsv() {
  let text;
  try {
    const res = await fetch(`${SHEET_CSV_FALLBACK}&_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`export status ${res.status}`);
    text = await res.text();
  } catch (e) {
    console.warn('export fetch failed, trying gviz fallback', e);
    const res2 = await fetch(`${SHEET_CSV_URL}&_=${Date.now()}`, { cache: 'no-store' });
    if (!res2.ok) throw new Error(`gviz status ${res2.status}`);
    text = await res2.text();
  }
  return text;
}

function findPickRows(rows) {
  // Column B holds the pick number. Find the contiguous run of rows where
  // column B is exactly 1, 2, 3, ... in order — that run is the draft grid,
  // wherever it happens to sit in the sheet.
  let start = -1, end = -1, expect = 1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const val = row && row[1] != null ? String(row[1]).trim() : '';
    const n = Number(val);
    if (val !== '' && Number.isInteger(n) && n === expect) {
      if (start === -1) start = r;
      end = r;
      expect++;
    } else if (start !== -1) {
      break; // sequence ended
    }
  }
  return { start, end };
}

function findTeamColumns(rows, headerCandidateRow) {
  // Team columns are columns C onward (index >= 2) that have a non-empty
  // header value in the row just above the first pick row.
  const header = rows[headerCandidateRow] || [];
  const cols = [];
  for (let c = 2; c < header.length; c++) {
    if (header[c] && String(header[c]).trim() !== '') cols.push(c);
  }
  return cols.length ? cols : Array.from({ length: 12 }, (_, i) => i + 2); // fallback: C-N
}

function extractDraftedFromCsv(rows, start, end, teamCols) {
  const names = new Set();
  for (let r = start; r <= end; r++) {
    const row = rows[r];
    if (!row) continue;
    for (const c of teamCols) {
      const cell = row[c];
      if (!cell) continue;
      const trimmed = String(cell).trim();
      if (!trimmed || /on the clock/i.test(trimmed)) continue;
      // cell format: "Player Name\nPOS - TEAM(bye)"
      const firstLine = trimmed.split('\n')[0].trim();
      if (firstLine) names.add(normalizeName(firstLine));
    }
  }
  return names;
}

// Every filled pick cell across every team, tagged with its grid coordinate
// so the caller can diff against what it's seen before (for the recent
// activity feed) without caring which team drafted what.
function extractAllPicks(rows, start, end, teamCols) {
  const picks = [];
  for (let r = start; r <= end; r++) {
    const row = rows[r];
    if (!row) continue;
    for (const c of teamCols) {
      const parsed = parsePickCell(row[c]);
      if (parsed) picks.push({ row: r, col: c, ...parsed });
    }
  }
  return picks;
}

// Map each team column to its display name, reading the header row just
// above the pick grid (stripping the "On the Clock:" prefix if present).
function getColTeamNames(rows, headerCandidateRow, teamCols, totalRowIdx) {
  const header = rows[headerCandidateRow] || [];
  const totalRow = (totalRowIdx != null && rows[totalRowIdx]) || [];
  const map = {};
  teamCols.forEach(c => {
    // The gviz CSV endpoint (the one that actually works from a browser -
    // the plain export endpoint 307-redirects to a googleusercontent.com
    // URL with no CORS header, so it's silently blocked and this is what's
    // really in use) has a real bug: it collapses the banner row ("On the
    // Clock: X") into the header row directly above the pick grid whenever
    // both are otherwise sparse, gluing the two together into one cell,
    // e.g. "On the Clock: Reid/MIke Devin" for a column really named
    // "Devin". That corruption can't be detected/undone after the fact
    // from the header row alone, because the corrupted text *is* the only
    // header this column appears to have. The "Total" row below the grid
    // is never touched by that merge, so prefer its value - it's always
    // the clean, ground-truth team name - and only fall back to the header
    // row above the grid if the Total row is missing or blank there.
    const totalCell = String(totalRow[c] || '').split('\n')[0].trim();
    if (totalCell) { map[c] = totalCell; return; }
    const firstLine = String(header[c] || '').split('\n')[0];
    const name = firstLine.replace(/on the clock:?/gi, '').trim();
    map[c] = name || `Team ${c}`;
  });
  return map;
}

// Scan every cell in the sheet for one containing "On the Clock: <team>"
// and return just the team name. The banner cell's own row/column position
// isn't fixed (it moves as picks happen), so we search broadly rather than
// assuming a specific row.
function getOnTheClockTeam(rows) {
  for (const row of rows) {
    if (!row) continue;
    for (const cell of row) {
      const text = String(cell || '');
      const match = text.match(/on the clock:?\s*(.+)/i);
      if (match) {
        // Only the first line after the prefix is ever the real team name.
        return match[1].split('\n')[0].trim();
      }
    }
  }
  return '';
}

// Short two-tone "ding" so it's audible without an external sound file.
// Browsers block audio until a user gesture unlocks the shared AudioContext
// (wired once in wireControls), so this is a silent no-op until that happens.
let sharedAudioCtx = null;
function playDing() {
  try {
    if (!sharedAudioCtx) return;
    const ctx = sharedAudioCtx;
    const now = ctx.currentTime;
    // A real bell isn't a pure tone - it's a fundamental plus a few
    // inharmonic overtones, each decaying at a different rate (the higher
    // ones die out fastest). Layering sine partials at bell-like frequency
    // ratios with staggered decay times gives a "ring" character instead of
    // a flat electronic beep.
    const fundamental = 880;
    const partials = [
      { ratio: 1.0, gain: 0.30, decay: 1.4 },
      { ratio: 2.0, gain: 0.16, decay: 1.0 },
      { ratio: 2.4, gain: 0.10, decay: 0.7 },
      { ratio: 3.8, gain: 0.06, decay: 0.4 },
    ];
    partials.forEach(({ ratio, gain: peak, decay }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = fundamental * ratio;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + decay + 0.05);
    });
  } catch (e) { /* audio unavailable - not critical */ }
}

// Parse a single drafted-player cell into {name, pos, teamAbbr, bye}.
// Cell format: "Player Name\nPOS - TEAM(bye)"
function parsePickCell(cell) {
  const trimmed = String(cell || '').trim();
  if (!trimmed || /on the clock/i.test(trimmed)) return null;
  const lines = trimmed.split('\n');
  const name = (lines[0] || '').trim();
  if (!name) return null;
  const meta = (lines[1] || '').trim(); // e.g. "WR - NYG(8)"
  let pos = '', teamAbbr = '', bye = '';
  const dashIdx = meta.indexOf(' - ');
  if (dashIdx !== -1) {
    pos = meta.slice(0, dashIdx).trim();
    const rest = meta.slice(dashIdx + 3).trim(); // "NYG(8)"
    const byeMatch = rest.match(/\((\d+)\)/);
    bye = byeMatch ? byeMatch[1] : '';
    teamAbbr = rest.replace(/\(.*\)/, '').trim();
  }
  return { name, pos: mapSheetPos(pos), teamAbbr, bye };
}

// Locate the column for a given team name. Checks the row just above the
// pick grid (has an "On the Clock:" prefix contaminating one cell) and the
// "Total" summary row just below the grid (clean team names), since either
// can carry the header depending on how the sheet is laid out.
function findTeamColumn(rows, start, end, teamName) {
  const target = normalizeTeamLabel(teamName);
  const candidateRows = [start - 1, end + 1, end + 2, end + 3];
  for (const r of candidateRows) {
    const row = rows[r];
    if (!row) continue;
    for (let c = 2; c < row.length; c++) {
      if (normalizeTeamLabel(row[c]) === target) return c;
    }
  }
  return -1;
}

// Pull every pick made by one team, in draft order.
function getTeamPicks(rows, start, end, col) {
  const picks = [];
  for (let r = start; r <= end; r++) {
    const row = rows[r];
    if (!row) continue;
    const parsed = parsePickCell(row[col]);
    if (parsed) picks.push(parsed);
  }
  return picks;
}

// Attach projection data (customPts, exact pos, stat fields) to a pick by
// matching normalized names against the loaded players.json list.
function enrichPick(pick) {
  const norm = normalizeName(pick.name);
  const match = players.find(p => p._norm === norm);
  if (match) {
    return { name: match.name, pos: match.pos, pts: match.customPts, teamAbbr: match.team, matched: true };
  }
  return { name: pick.name, pos: pick.pos, pts: null, teamAbbr: pick.teamAbbr, matched: false };
}

// Greedy "best available" lineup builder: fills exact-position slots first,
// then flex slots, from the team's drafted pool sorted by projected points.
// This is a projection-based *suggested* optimal lineup, not a read of
// whatever bench/start toggles the owner has actually set in ESPN (the draft
// sheet has no way to know that).
function assignRoster(picks) {
  const pool = picks.map(enrichPick);
  pool.sort((a, b) => (b.pts ?? -1) - (a.pts ?? -1));
  const used = new Set();
  const starters = ROSTER_SLOTS.map(slot => {
    const idx = pool.findIndex((p, i) => !used.has(i) && slot.eligible.includes(p.pos));
    if (idx === -1) return { slot, player: null };
    used.add(idx);
    return { slot, player: pool[idx] };
  });
  const bench = pool.filter((_, i) => !used.has(i));
  return { starters, bench };
}

// Sidebar display order: flexes are shown directly under their related
// position group (RB/WR under the RBs, WR/TE under the WRs) to match ESPN's
// roster layout convention. This is independent of ROSTER_SLOTS fill order
// above, which intentionally fills exact-position slots before flex slots so
// the best players land in their true slot and flexes only get leftovers.
const DISPLAY_ORDER = ['QB', 'RB1', 'RB2', 'RBWR', 'WR1', 'WR2', 'WRTE', 'TE', 'DST', 'K'];

function renderRosterSidebar(starters, bench) {
  const startersTable = document.getElementById('starters-table');
  const benchTable = document.getElementById('bench-table');
  const totalEl = document.getElementById('starters-total');

  const ordered = DISPLAY_ORDER
    .map(key => starters.find(s => s.slot.key === key))
    .filter(Boolean);

  startersTable.innerHTML = ordered.map(({ slot, player }) => {
    const cls = player ? '' : ' empty';
    const name = player ? escapeHtml(player.name) : '\u2014 empty \u2014';
    const pts = player && player.pts != null ? player.pts.toFixed(1) : '';
    return `<tr>
      <td class="slot-label">${slot.label}</td>
      <td class="slot-player${cls}">${name}</td>
      <td class="slot-pts">${pts}</td>
    </tr>`;
  }).join('');

  let sum = 0;
  starters.forEach(({ player }) => { if (player && player.pts != null) sum += player.pts; });
  totalEl.textContent = `Starters: ${sum.toFixed(1)} pts`;

  const benchRows = bench.slice(0, BENCH_SLOTS).map(player => {
    const pts = player.pts != null ? player.pts.toFixed(1) : '';
    return `<tr>
      <td class="slot-label">${player.pos}</td>
      <td class="slot-player">${escapeHtml(player.name)}</td>
      <td class="slot-pts">${pts}</td>
    </tr>`;
  });
  const emptyBenchCount = Math.max(0, BENCH_SLOTS - bench.length);
  for (let i = 0; i < emptyBenchCount; i++) {
    benchRows.push(`<tr><td class="slot-label">BE</td><td class="slot-player empty">\u2014 empty \u2014</td><td class="slot-pts"></td></tr>`);
  }
  benchRows.push(`<tr><td class="slot-label">IR</td><td class="slot-player empty">\u2014 empty \u2014</td><td class="slot-pts"></td></tr>`);
  benchTable.innerHTML = benchRows.join('');
}

// Populate (or refresh) the #team-select dropdown with the actual
// team names read from the sheet. Preserves the current selection.
function buildTeamDropdown(colTeamNames) {
  const sel = document.getElementById('team-select');
  if (!sel) return;
  const names = Object.values(colTeamNames).filter(Boolean).sort();
  // Rebuild options: keep "Show All Teams" first, then sorted team names.
  sel.innerHTML = '<option value="ALL">Show All Teams</option>' +
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  // Re-apply stored selection if the team still exists.
  if (names.some(n => n === watchTeam)) sel.value = watchTeam;
  else sel.value = 'ALL';
}

// Render whichever roster view matches the current watchTeam setting.
function renderSelectedRoster() {
  if (!cachedRows || cachedStart === -1) return;
  const titleEl = document.getElementById('roster-title');
  if (watchTeam === 'ALL') {
    if (titleEl) titleEl.textContent = 'All Rosters';
    renderAllTeamsRoster();
  } else {
    if (titleEl) titleEl.textContent = `${watchTeam} Roster`;
    const col = findTeamColumn(cachedRows, cachedStart, cachedEnd, watchTeam);
    if (col !== -1) {
      const picks = getTeamPicks(cachedRows, cachedStart, cachedEnd, col);
      const { starters, bench } = assignRoster(picks);
      renderRosterSidebar(starters, bench);
    } else {
      document.getElementById('starters-table').innerHTML =
        '<tr><td colspan="3" style="opacity:.5;padding:8px">Team not found in sheet.</td></tr>';
      document.getElementById('bench-table').innerHTML = '';
      document.getElementById('starters-total').textContent = '';
    }
  }
}

// "Show All Teams" view: compact starters-only section per team.
function renderAllTeamsRoster() {
  const startersTable = document.getElementById('starters-table');
  const benchTable    = document.getElementById('bench-table');
  const totalEl       = document.getElementById('starters-total');
  if (totalEl) totalEl.textContent = '';
  if (benchTable) benchTable.innerHTML = '';
  const names = Object.values(cachedColTeamNames).filter(Boolean);
  if (!names.length) {
    startersTable.innerHTML = '<tr><td colspan="3" style="opacity:.5;padding:8px">No teams found.</td></tr>';
    return;
  }
  // Derive pick order (teams that have picked first, by pick count desc).
  const sections = names.map(name => {
    const col = findTeamColumn(cachedRows, cachedStart, cachedEnd, name);
    const picks = col !== -1 ? getTeamPicks(cachedRows, cachedStart, cachedEnd, col) : [];
    const { starters } = assignRoster(picks);
    let sum = 0;
    starters.forEach(({ player }) => { if (player && player.pts != null) sum += player.pts; });
    return { name, starters, pts: sum };
  });
  // Render each team as a labelled block inside the starters table.
  // Use <tbody> groups: one header row + starters rows per team.
  startersTable.innerHTML = sections.map(({ name, starters, pts }) => {
    const ordered = DISPLAY_ORDER
      .map(key => starters.find(s => s.slot.key === key))
      .filter(Boolean);
    const rows = ordered.map(({ slot, player }) => {
      const cls = player ? '' : ' empty';
      const pname = player ? escapeHtml(player.name) : '\u2014';
      const ppts  = player && player.pts != null ? player.pts.toFixed(1) : '';
      return `<tr><td class="slot-label">${slot.label}</td>`
           + `<td class="slot-player${cls}">${pname}</td>`
           + `<td class="slot-pts">${ppts}</td></tr>`;
    }).join('');
    const ptsTxt = pts > 0 ? ` · ${pts.toFixed(1)} pts` : '';
    return `<tbody class="team-section">`
         + `<tr class="team-section-header"><td colspan="3">${escapeHtml(name)}${ptsTxt}</td></tr>`
         + rows
         + `</tbody>`;
  }).join('');
}

async function syncDraftBoard(manual) {
  const statusEl = document.getElementById('sync-status');
  if (manual) statusEl.textContent = 'Refreshing\u2026';
  try {
    const csvText = await fetchSheetCsv();
    const parsed = Papa.parse(csvText, { skipEmptyLines: false });
    const rows = parsed.data;
    const { start, end } = findPickRows(rows);
    if (start === -1) throw new Error('pick grid not found in sheet');
    const teamCols = findTeamColumns(rows, start - 1);

    draftedNames = extractDraftedFromCsv(rows, start, end, teamCols);
    players.forEach(p => { p.drafted = draftedNames.has(p._norm); });

    // Recent activity: diff every filled cell against what we've already
    // seen (by grid coordinate, not name) so this only surfaces picks made
    // since the page loaded, by any team, not just ours.
    const colTeamNames = getColTeamNames(rows, start - 1, teamCols, end + 1);
    const allPicks = extractAllPicks(rows, start, end, teamCols);
    const currentKeys = new Set(allPicks.map(p => `${p.row}:${p.col}`));
    const newPicks = allPicks.filter(p => !seenPickKeys.has(`${p.row}:${p.col}`));
    newPicks.forEach(p => seenPickKeys.add(`${p.row}:${p.col}`));

    // A pick that was previously logged but whose cell is now empty (the
    // sheet owner undid/cleared it) should disappear from the activity feed
    // too - it's no longer true that it happened.
    const removedKeys = [...seenPickKeys].filter(k => !currentKeys.has(k));
    if (removedKeys.length) {
      const removedSet = new Set(removedKeys);
      removedKeys.forEach(k => seenPickKeys.delete(k));
      activityLog = activityLog.filter(a => !removedSet.has(a.key));
    }

    // Every pick is labeled by round number, not a fabricated clock time -
    // the sheet has no per-pick timestamp, and round number is honest and
    // always distinct across rounds.
    const entries = newPicks.map(p => ({
      key: `${p.row}:${p.col}`,
      team: colTeamNames[p.col] || 'Unknown',
      name: p.name,
      pos: p.pos,
      ts: `Round ${p.row - start + 1}`,
    }));
    if (entries.length) {
      activityLog = [...entries.reverse(), ...activityLog].slice(0, ACTIVITY_MAX);
    }
    // Only the single most-recent pick overall gets the "new" golden
    // highlight, never every pick from a multi-pick sync batch (e.g. the
    // first sync after a page load, which can "discover" many picks at
    // once) - activityLog[0] is always that newest entry after the splice
    // above. If this sync didn't add anything new, freshKeys must be empty
    // rather than re-highlighting whatever was already on top - otherwise
    // the highlight would never clear as long as no new pick ever came in.
    freshKeys = entries.length ? new Set([activityLog[0].key]) : new Set();

    // Self-heal: any entry already in the log (including ones logged before
    // a past bug fix, sitting in a browser tab that's never been reloaded)
    // gets its team name re-derived from the current header mapping on
    // every sync, so a stale/incorrect team label can't linger forever.
    activityLog = activityLog.map(a => {
      const col = Number(String(a.key).split(':')[1]);
      const freshTeam = colTeamNames[col];
      return freshTeam ? { ...a, team: freshTeam } : a;
    });

    initialSyncDone = true;
    renderActivity();

    // Cache parsed sheet data so the dropdown can re-render without re-fetching.
    cachedRows = rows; cachedStart = start; cachedEnd = end;
    cachedTeamCols = teamCols; cachedColTeamNames = colTeamNames;
    buildTeamDropdown(colTeamNames);
    renderSelectedRoster();

    // On-the-clock banner: parse the sheet's "On the Clock: X" cell and show
    // it up top. When it's our team, blink continuously with a golden
    // outline and ding once on the moment it becomes our turn (not every
    // poll while it stays our turn).
    let onClockTeam = getOnTheClockTeam(rows);
    const indicator = document.getElementById('on-clock-indicator');
    if (onClockTeam) {
      // Defense in depth: a CSV source glitch (e.g. a merged header row)
      // can glue a second team's name onto the real one, e.g. "Reid/MIke
      // Devin" when only "Reid/MIke" is actually on the clock. If the raw
      // text isn't a known team as-is, try trimming trailing words one at a
      // time until it matches one of this sheet's actual team names, rather
      // than showing (and blinking gold over) a name nobody drafted under.
      const knownTeams = Object.values(colTeamNames);
      const isKnown = (t) => knownTeams.some(k => normalizeTeamLabel(k) === normalizeTeamLabel(t));
      if (!isKnown(onClockTeam)) {
        const words = onClockTeam.split(/\s+/);
        for (let cut = words.length - 1; cut >= 1; cut--) {
          const candidate = words.slice(0, cut).join(' ');
          if (isKnown(candidate)) { onClockTeam = candidate; break; }
        }
      }
      const watchedTeamForClock = watchTeam === 'ALL' ? MY_TEAM_NAME : watchTeam;
    const isMyTurn = normalizeTeamLabel(onClockTeam) === normalizeTeamLabel(watchedTeamForClock);
      indicator.textContent = `On the Clock: ${onClockTeam}`;
      if (isMyTurn && !wasMyTurn) { playDing(); onClockAcked = false; }
      wasMyTurn = isMyTurn;
      // Flash (my-turn) until the user clicks it to ack (my-turn-ack) -
      // ack is cleared above whenever a *new* turn of ours starts, so a
      // stale click from a previous pick never suppresses a fresh one.
      indicator.classList.toggle('my-turn', isMyTurn && !onClockAcked);
      indicator.classList.toggle('my-turn-ack', isMyTurn && onClockAcked);
      indicator.onclick = () => {
        if (!indicator.classList.contains('my-turn')) return;
        onClockAcked = true;
        indicator.classList.remove('my-turn');
        indicator.classList.add('my-turn-ack');
      };
    } else {
      indicator.textContent = '';
      indicator.classList.remove('my-turn', 'my-turn-ack');
      indicator.onclick = null;
      wasMyTurn = false;
      onClockAcked = false;
    }

    lastSyncAt = Date.now();
    lastDraftedCount = draftedNames.size;
    statusEl.classList.remove('sync-error');
    tickSyncStatus();
    render();
    updateHeaderHeightVar();
  } catch (e) {
    console.error('Sheet sync failed', e);
    statusEl.textContent = `Sync failed (${e.message}) \u2014 showing last known data`;
    statusEl.classList.add('sync-error');
  }
}

// ---------- filtering / sorting / rendering ----------
function getFiltered() {
  let list = players;
  if (activePos === 'ALL') {
    // K and D/ST are deliberately excluded from the combined "ALL" view -
    // they're a different kind of ranking (ADP-based estimate, no real
    // stat line) and would just clutter the main skill-position board.
    // They're only ever shown when their own filter button is active.
    list = list.filter(p => p.pos !== 'K' && p.pos !== 'DST');
  } else {
    list = list.filter(p => p.pos === activePos);
  }
  if (hideDrafted) list = list.filter(p => !p.drafted);
  if (showStarredOnly) list = list.filter(p => starredNames.has(p._norm));
  if (showSleepersOnly) list = list.filter(p => sleeperNames.has(p._norm));
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(t) || p.team.toLowerCase().includes(t));
  }
  const dir = sortDir === 'asc' ? 1 : -1;
  list = list.slice().sort((a, b) => {
    let av = a[sortKey], bv = b[sortKey];
    if (sortKey === 'name' || sortKey === 'pos' || sortKey === 'team') {
      av = (av || '').toLowerCase(); bv = (bv || '').toLowerCase();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    }
    if (sortKey === 'targetRound') {
      // Missing target round always sorts last.
      const atr = targetRounds[a._norm] ? Number(targetRounds[a._norm]) : null;
      const btr = targetRounds[b._norm] ? Number(targetRounds[b._norm]) : null;
      if (atr == null && btr == null) return 0;
      if (atr == null) return 1;
      if (btr == null) return -1;
      return (atr - btr) * dir;
    }
    if (sortKey === 'adp' || sortKey === 'espnRank') {
      // Missing value always sorts last, regardless of asc/desc.
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    }
    av = av == null ? -Infinity : av;
    bv = bv == null ? -Infinity : bv;
    return (av - bv) * dir;
  });
  return list;
}

// Builds the header row to match the current position filter: base columns
// are always present, then that position's individual sortable stat
// columns (or the ALL_STAT_COLUMNS union when no position filter is
// active), then Status.
// Base (non-stat) column definitions shared by every position, in order.
// rowspan is 2 whenever a stat-group label row is present above the real
// stat columns, so these cells visually span both header rows.
const BASE_START_COLS = [
  { key: 'star', label: ' ', title: 'Starred' },
  { key: 'sleeper', label: ' ', title: 'Sleeper pick' },
  { key: 'espnRank', label: 'ESPN Rk', title: 'ESPN Non-PPR Top 300 overall ranking (Aug 2026). Players outside the top 300 show —.', sortDefault: true },
  { key: 'targetRound', label: 'Tgt Rd', title: 'Your target draft round (saved in browser)' },
  { key: 'posRank', label: 'Pos Rk' },
  { key: 'name', label: 'Player' },
  { key: 'pos', label: 'Pos' },
  { key: 'team', label: 'Team' },
  { key: 'injuryRisk', label: 'Inj Risk', title: 'Injury risk category (Draft Sharks)' },
  { key: 'adp', label: 'ADP', title: 'Average Draft Position, 12-team non-PPR mocks (FantasyFootballCalculator.com)' },
  { key: 'customPts', label: 'Proj Pts' },
];
const BASE_END_COL = { key: 'status', label: 'Status' };
const BASE_NOTES_COL = { key: 'notes', label: 'Notes', title: 'Personal notes (saved in browser)' };

function headerCellHtml(col, rowspan) {
  const attrs = [`data-key="${col.key}"`];
  if (rowspan === 2) attrs.push('rowspan="2"');
  if (col.title) attrs.push(`title="${col.title}"`);
  if (col.sortDefault) attrs.push('class="sort-default"');
  return `<th ${attrs.join(' ')}>${col.label}</th>`;
}

function attachHeaderSortHandlers(row) {
  row.querySelectorAll('th[data-key]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (key === 'star' || key === 'sleeper' || key === 'notes' || key === 'injuryRisk') return; // not real sortable fields
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = (key === 'name' || key === 'pos' || key === 'team' || key === 'adp') ? 'asc' : 'desc';
      }
      render();
    });
  });
}

// Two header rows: #header-group-row carries the "2026 Projections - Mike
// Clay ESPN" label spanning just the real stat columns (when a position
// has any - K/DST don't, see STAT_COLUMNS_BY_POS), and #header-row carries
// the actual stat column headers underneath it. The base/status columns
// use rowspan="2" to span both rows so they don't need a duplicate cell.
// When there are no stat columns (K/DST), everything collapses back to a
// single row and the group row is hidden.
function buildTableHeader() {
  const groupRow = document.getElementById('header-group-row');
  const headerRow = document.getElementById('header-row');
  const cols = statColumnsFor(activePos);
  const hasStats = cols.length > 0;

  if (hasStats) {
    const baseStart = BASE_START_COLS.map(c => headerCellHtml(c, 2)).join('');
    const statLabel = `<th colspan="${cols.length}" class="stat-group-label">2026 Projections &ndash; Mike Clay ESPN</th>`;
    const baseEnd = headerCellHtml(BASE_END_COL, 2);
    const notesHeader = headerCellHtml(BASE_NOTES_COL, 2);
    groupRow.innerHTML = baseStart + statLabel + notesHeader + baseEnd;
    groupRow.style.display = '';
    headerRow.innerHTML = cols.map(c => `<th data-key="${c.key}">${c.label}</th>`).join('');
  } else {
    groupRow.innerHTML = '';
    groupRow.style.display = 'none';
    const baseStart = BASE_START_COLS.map(c => headerCellHtml(c, 1)).join('');
    const baseEnd = headerCellHtml(BASE_END_COL, 1);
    const notesHeader2 = headerCellHtml(BASE_NOTES_COL, 1);
    headerRow.innerHTML = baseStart + notesHeader2 + baseEnd;
  }

  attachHeaderSortHandlers(groupRow);
  attachHeaderSortHandlers(headerRow);
}

function render() {
  // Don't clobber inputs the user is actively typing in (notes/tgt-input).
  if (document.activeElement && document.activeElement.closest &&
      document.activeElement.closest('#table-body')) return;
  const tbody = document.getElementById('table-body');
  const cols = statColumnsFor(activePos);
  // If the active sort column isn't in the current header set (e.g. user
  // sorted by a stat column, then switched back to ALL), fall back to
  // sorting by projected points rather than silently sorting by nothing.
  const validKeys = new Set(['star', 'sleeper', 'posRank', 'name', 'pos', 'team', 'customPts', 'status', 'adp', 'espnRank', 'injuryRisk', 'targetRound', 'notes',
    ...cols.map(c => c.key)]);
  if (!validKeys.has(sortKey)) { sortKey = 'espnRank'; sortDir = 'asc'; }

  const list = getFiltered();
  const rows = list.map(p => {
    const draftedCls = p.drafted ? ' drafted' : '';
    const statusHtml = p.drafted
      ? '<span class="drafted-tag">DRAFTED</span>'
      : '<span class="avail-tag">Available</span>';
    const statCellsHtml = cols.map(c => `<td class="stat-cell">${c.fmt(p[c.key])}</td>`).join('');
    const isStarred = starredNames.has(p._norm);
    const isSleeper = sleeperNames.has(p._norm);
    const tgtRnd = targetRounds[p._norm] || '';
    const tgtBadge = tgtRnd ? `<span class="tgt-badge">R${tgtRnd}</span>` : '';
    const notesVal = escapeHtml(playerNotes[p._norm] || '');
    return `<tr class="${draftedCls.trim()}">
      <td class="star-cell"><button class="star-btn${isStarred ? ' starred' : ''}" data-norm="${escapeHtml(p._norm)}" title="${isStarred ? 'Unstar' : 'Star'}">${isStarred ? '\u2605' : '\u2606'}${tgtBadge}</button></td>
      <td class="sleeper-cell"><button class="sleeper-btn${isSleeper ? ' sleepered' : ''}" data-norm="${escapeHtml(p._norm)}" title="${isSleeper ? 'Remove sleeper' : 'Mark as sleeper'}">\uD83D\uDCA4${tgtBadge}</button></td>
      <td>${p.espnRank != null ? p.espnRank : '—'}</td>
      <td class="tgt-cell"><input class="tgt-input" type="number" min="1" max="20" placeholder="—" data-norm="${escapeHtml(p._norm)}" value="${tgtRnd}" title="Target draft round"></td>
      <td>${p.posRank}</td>
      <td class="name-cell">${escapeHtml(p.name)}</td>
      <td><span class="pos-badge pos-${p.pos}">${p.pos}</span></td>
      <td>${p.team}</td>
      <td>${injuryCell(p)}</td>
      <td>${fmtAdp(p.adp)}</td>
      <td>${p.customPts != null ? p.customPts.toFixed(1) : '-'}</td>
      ${statCellsHtml}
      <td class="notes-cell"><input class="notes-input" type="text" placeholder="Notes…" data-norm="${escapeHtml(p._norm)}" value="${notesVal}" title="Personal notes"></td>
      <td>${statusHtml}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows;

  const total = players.length;
  const draftedCount = players.filter(p => p.drafted).length;
  document.getElementById('count-label').textContent =
    `${list.length} shown \u2014 ${draftedCount}/${total} drafted`;

  document.querySelectorAll('#header-row th, #header-group-row th').forEach(th => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.key === sortKey) th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- controls wiring ----------
function buildPosFilters() {
  const container = document.getElementById('pos-filters');
  const all = ['ALL', ...POSITIONS];
  const posButtons = all.map(p => `<button data-pos="${p}" class="${p === activePos ? 'active' : ''}">${p}</button>`).join('');
  const starButton = `<button id="star-filter-btn" class="star-filter-btn${showStarredOnly ? ' active' : ''}" title="Show starred players only">\u2605 Starred</button>`;
  const sleeperButton = `<button id="sleeper-filter-btn" class="sleeper-filter-btn${showSleepersOnly ? ' active' : ''}" title="Show sleeper picks only">\uD83D\uDCA4 Sleepers</button>`;
  container.innerHTML = posButtons + starButton + sleeperButton;
  container.querySelectorAll('button[data-pos]').forEach(btn => {
    btn.addEventListener('click', () => {
      activePos = btn.dataset.pos;
      container.querySelectorAll('button[data-pos]').forEach(b => b.classList.toggle('active', b === btn));
      buildTableHeader();
      render();
    });
  });
  document.getElementById('star-filter-btn').addEventListener('click', (e) => {
    showStarredOnly = !showStarredOnly;
    e.target.classList.toggle('active', showStarredOnly);
    buildTableHeader();
    render();
  });
  document.getElementById('sleeper-filter-btn').addEventListener('click', (e) => {
    showSleepersOnly = !showSleepersOnly;
    e.target.classList.toggle('active', showSleepersOnly);
    buildTableHeader();
    render();
  });
}

function wireControls() {
  document.getElementById('search').addEventListener('input', (e) => {
    searchTerm = e.target.value;
    render();
  });
  document.getElementById('hide-drafted').addEventListener('change', (e) => {
    hideDrafted = e.target.checked;
    render();
  });
  document.getElementById('refresh-btn').addEventListener('click', () => syncDraftBoard(true));

  // Star buttons are rebuilt on every render(), so use event delegation on
  // the (stable) tbody element instead of re-attaching per-row listeners.
  document.getElementById('table-body').addEventListener('click', (e) => {
    const starBtn = e.target.closest('.star-btn');
    if (starBtn) { toggleStar(starBtn.dataset.norm); render(); return; }
    const sleeperBtn = e.target.closest('.sleeper-btn');
    if (sleeperBtn) { toggleSleeper(sleeperBtn.dataset.norm); render(); return; }
  });
  // Input delegation for target round and notes.
  document.getElementById('table-body').addEventListener('input', (e) => {
    const tgtInput = e.target.closest('.tgt-input');
    if (tgtInput) {
      const v = tgtInput.value.trim();
      if (v) targetRounds[tgtInput.dataset.norm] = Number(v);
      else delete targetRounds[tgtInput.dataset.norm];
      saveTargetRounds();
      return;
    }
    const notesInput = e.target.closest('.notes-input');
    if (notesInput) {
      const v = notesInput.value;
      if (v) playerNotes[notesInput.dataset.norm] = v;
      else delete playerNotes[notesInput.dataset.norm];
      savePlayerNotes();
      return;
    }
  });

  document.getElementById('team-select').addEventListener('change', (e) => {
    watchTeam = e.target.value;
    try { localStorage.setItem(WATCH_TEAM_KEY, watchTeam); } catch(_) {}
    // Reset on-clock state so the new team's turn evaluates fresh next poll.
    wasMyTurn = false; onClockAcked = false;
    renderSelectedRoster();
  });

  document.getElementById('panel-toggle-top').addEventListener('click', () => {
    rosterCollapsed = !rosterCollapsed;
    try { localStorage.setItem(ROSTER_COLLAPSE_KEY, rosterCollapsed ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    applyRosterCollapsed();
  });

  // Browsers block audio playback until the page has seen a user gesture.
  // Unlock the shared AudioContext on the first click anywhere, so the
  // on-the-clock ding actually plays once your turn comes up later.
  document.addEventListener('click', function unlockAudio() {
    if (!sharedAudioCtx && typeof AudioContext !== 'undefined') {
      try { sharedAudioCtx = new AudioContext(); } catch (e) { /* audio unavailable */ }
    } else if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume();
    }
  }, { once: false });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => syncDraftBoard(false), POLL_MS);
}

// Placeholder rows shown between "Loading draft board..." appearing and the
// first real render, so the page doesn't sit on a blank table for the
// second or so it takes to fetch players.json + the sheet.
function renderTableSkeleton() {
  const tbody = document.getElementById('table-body');
  const cols = statColumnsFor(activePos);
  const colCount = BASE_START_COLS.length + cols.length + 2; // +1 for Status, +1 for Notes
  const rowsHtml = Array.from({ length: 10 }, () =>
    `<tr class="skeleton-row">${'<td><div class="skeleton-bar"></div></td>'.repeat(colCount)}</tr>`
  ).join('');
  tbody.innerHTML = rowsHtml;
}

// ---------- init ----------
(async function init() {
  buildPosFilters();
  buildTableHeader();
  wireControls();
  applyRosterCollapsed();
  renderActivity();
  renderTableSkeleton();
  updateHeaderHeightVar();
  window.addEventListener('resize', updateHeaderHeightVar);
  setInterval(tickSyncStatus, 5000);
  try {
    await loadPlayers();
    render();
    await syncDraftBoard(false);
    startPolling();
  } catch (e) {
    console.error('Init failed', e);
    document.getElementById('sync-status').textContent = `Load failed: ${e.message}`;
  }
})();
