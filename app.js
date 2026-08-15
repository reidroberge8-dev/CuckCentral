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
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

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
let sortKey = 'customPts';
let sortDir = 'desc';
let searchTerm = '';
let hideDrafted = false;
let showStarredOnly = false;
let pollTimer = null;

document.getElementById('sheet-link').href = SHEET_VIEW_URL;

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

// ---------- roster sidebar collapse (persisted locally per-browser) ----------
const ROSTER_COLLAPSE_KEY = 'ffdb_roster_collapsed';
let rosterCollapsed = false;
try { rosterCollapsed = localStorage.getItem(ROSTER_COLLAPSE_KEY) === '1'; } catch (e) { rosterCollapsed = false; }
function applyRosterCollapsed() {
  const sidebar = document.getElementById('roster-sidebar');
  const btn = document.getElementById('roster-toggle');
  sidebar.classList.toggle('collapsed', rosterCollapsed);
  btn.textContent = rosterCollapsed ? '\u2630' : '\u00d7';
  btn.title = rosterCollapsed ? 'Show roster' : 'Hide roster';
}

// ---------- recent draft activity (in-memory for this session) ----------
// Tracks every drafted-cell coordinate we've already seen so re-polling the
// sheet only surfaces genuinely new picks (by any team, not just ours).
let seenPickKeys = new Set();
let activityLog = []; // { team, name, pos, ts } newest first
const ACTIVITY_MAX = 10;
function renderActivity() {
  const el = document.getElementById('activity-list');
  if (!activityLog.length) {
    el.innerHTML = '<div class="activity-empty">No picks yet.</div>';
    return;
  }
  el.innerHTML = activityLog.map(a => `<div class="activity-item">
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

// Condensed multi-stat summary shown only in the "ALL" position view, where
// showing every individual stat column at once (across every position) is
// too noisy to be useful.
function statLine(p) {
  switch (p.pos) {
    case 'QB':
      return `${Math.round(p.p_yds)} pyd, ${p.p_td} pTD, ${p.intc} INT, ${Math.round(p.ru_yds)} ryd, ${p.ru_td} rTD`;
    case 'RB':
      return `${Math.round(p.ru_yds)} ryd, ${p.ru_td} rTD, ${p.rec} rec, ${Math.round(p.re_yd)} recyd, ${p.re_td} recTD`;
    case 'WR':
    case 'TE':
      return `${p.rec} rec, ${Math.round(p.re_yd)} recyd, ${p.re_td} recTD${p.ru_yds ? `, ${Math.round(p.ru_yds)} ryd` : ''}`;
    default:
      return '';
  }
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
function statColumnsFor(pos) { return STAT_COLUMNS_BY_POS[pos] || ALL_STAT_COLUMNS; }

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
async function fetchSheetCsv() {
  let text;
  try {
    const res = await fetch(`${SHEET_CSV_URL}&_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`gviz status ${res.status}`);
    text = await res.text();
  } catch (e) {
    console.warn('gviz/tq fetch failed, trying export fallback', e);
    const res2 = await fetch(`${SHEET_CSV_FALLBACK}&_=${Date.now()}`, { cache: 'no-store' });
    if (!res2.ok) throw new Error(`export status ${res2.status}`);
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
function getColTeamNames(rows, headerCandidateRow, teamCols) {
  const header = rows[headerCandidateRow] || [];
  const map = {};
  teamCols.forEach(c => {
    // Guard against a header cell that transiently holds more than one line
    // (e.g. an "On the Clock: X" banner overlapping the team-name row for a
    // moment) - only the first line is ever the real team name, so drop
    // anything after a newline before stripping the "on the clock" phrase.
    const firstLine = String(header[c] || '').split('\n')[0];
    const name = firstLine.replace(/on the clock:?/gi, '').trim();
    map[c] = name || `Team ${c}`;
  });
  return map;
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
    const colTeamNames = getColTeamNames(rows, start - 1, teamCols);
    const allPicks = extractAllPicks(rows, start, end, teamCols);
    const newPicks = allPicks.filter(p => !seenPickKeys.has(`${p.row}:${p.col}`));
    newPicks.forEach(p => seenPickKeys.add(`${p.row}:${p.col}`));
    if (newPicks.length) {
      const ts = new Date().toLocaleTimeString();
      const entries = newPicks.map(p => ({
        team: colTeamNames[p.col] || 'Unknown',
        name: p.name,
        pos: p.pos,
        ts,
      }));
      activityLog = [...entries.reverse(), ...activityLog].slice(0, ACTIVITY_MAX);
    }
    renderActivity();

    const myCol = findTeamColumn(rows, start, end, MY_TEAM_NAME);
    if (myCol !== -1) {
      const myPicks = getTeamPicks(rows, start, end, myCol);
      const { starters, bench } = assignRoster(myPicks);
      renderRosterSidebar(starters, bench);
    } else {
      console.warn(`Could not find column for team "${MY_TEAM_NAME}" in sheet header.`);
    }

    const now = new Date();
    statusEl.textContent = `Synced ${now.toLocaleTimeString()} \u2014 ${draftedNames.size} drafted`;
    statusEl.classList.remove('sync-error');
    render();
  } catch (e) {
    console.error('Sheet sync failed', e);
    statusEl.textContent = `Sync failed (${e.message}) \u2014 showing last known data`;
    statusEl.classList.add('sync-error');
  }
}

// ---------- filtering / sorting / rendering ----------
function getFiltered() {
  let list = players;
  if (activePos !== 'ALL') list = list.filter(p => p.pos === activePos);
  if (hideDrafted) list = list.filter(p => !p.drafted);
  if (showStarredOnly) list = list.filter(p => starredNames.has(p._norm));
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
function buildTableHeader() {
  const headerRow = document.getElementById('header-row');
  const cols = statColumnsFor(activePos);
  const baseStart = [
    '<th data-key="star" title="Starred"> </th>',
    '<th data-key="posRank">Pos Rk</th>',
    '<th data-key="name">Player</th>',
    '<th data-key="pos">Pos</th>',
    '<th data-key="team">Team</th>',
    '<th data-key="customPts" class="sort-default">Proj Pts</th>',
  ].join('');
  const statHead = cols
    ? cols.map(c => `<th data-key="${c.key}">${c.label}</th>`).join('')
    : '<th data-key="statline">Key Stats</th>';
  const baseEnd = '<th data-key="status">Status</th>';
  headerRow.innerHTML = baseStart + statHead + baseEnd;

  headerRow.querySelectorAll('th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (key === 'statline' || key === 'star') return; // not real sortable fields
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = (key === 'name' || key === 'pos' || key === 'team') ? 'asc' : 'desc';
      }
      render();
    });
  });
}

function render() {
  const tbody = document.getElementById('table-body');
  const cols = statColumnsFor(activePos);
  // If the active sort column isn't in the current header set (e.g. user
  // sorted by a stat column, then switched back to ALL), fall back to
  // sorting by projected points rather than silently sorting by nothing.
  const validKeys = new Set(['posRank', 'name', 'pos', 'team', 'customPts', 'status',
    ...(cols ? cols.map(c => c.key) : [])]);
  if (!validKeys.has(sortKey)) { sortKey = 'customPts'; sortDir = 'desc'; }

  const list = getFiltered();
  const rows = list.map(p => {
    const draftedCls = p.drafted ? ' drafted' : '';
    const statusHtml = p.drafted
      ? '<span class="drafted-tag">DRAFTED</span>'
      : '<span class="avail-tag">Available</span>';
    const statCellsHtml = cols
      ? cols.map(c => `<td class="stat-cell">${c.fmt(p[c.key])}</td>`).join('')
      : `<td class="stat-line">${statLine(p)}</td>`;
    const isStarred = starredNames.has(p._norm);
    return `<tr class="${draftedCls.trim()}">
      <td class="star-cell"><button class="star-btn${isStarred ? ' starred' : ''}" data-norm="${escapeHtml(p._norm)}" title="${isStarred ? 'Unstar' : 'Star'}">${isStarred ? '\u2605' : '\u2606'}</button></td>
      <td>${p.posRank}</td>
      <td class="name-cell">${escapeHtml(p.name)}</td>
      <td><span class="pos-badge pos-${p.pos}">${p.pos}</span></td>
      <td>${p.team}</td>
      <td>${p.customPts != null ? p.customPts.toFixed(1) : '-'}</td>
      ${statCellsHtml}
      <td>${statusHtml}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows;

  const total = players.length;
  const draftedCount = players.filter(p => p.drafted).length;
  document.getElementById('count-label').textContent =
    `${list.length} shown \u2014 ${draftedCount}/${total} drafted`;

  document.querySelectorAll('#header-row th').forEach(th => {
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
  container.innerHTML = all.map(p => `<button data-pos="${p}" class="${p === activePos ? 'active' : ''}">${p}</button>`).join('');
  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      activePos = btn.dataset.pos;
      container.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      buildTableHeader();
      render();
    });
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
  document.getElementById('show-starred-only').addEventListener('change', (e) => {
    showStarredOnly = e.target.checked;
    render();
  });
  document.getElementById('refresh-btn').addEventListener('click', () => syncDraftBoard(true));

  // Star buttons are rebuilt on every render(), so use event delegation on
  // the (stable) tbody element instead of re-attaching per-row listeners.
  document.getElementById('table-body').addEventListener('click', (e) => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    toggleStar(btn.dataset.norm);
    render();
  });

  document.getElementById('roster-toggle').addEventListener('click', () => {
    rosterCollapsed = !rosterCollapsed;
    try { localStorage.setItem(ROSTER_COLLAPSE_KEY, rosterCollapsed ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    applyRosterCollapsed();
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => syncDraftBoard(false), POLL_MS);
}

// ---------- init ----------
(async function init() {
  buildPosFilters();
  buildTableHeader();
  wireControls();
  applyRosterCollapsed();
  renderActivity();
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
