/* Beautiful Dogs War Room 2026 — player pool / rankings cheat sheet.
   The draft itself happens live in ESPN's own draft room now, so this page
   is a standalone reference tool only: rankings, ADP, injury risk, and your
   own star/sleeper/target-round/notes annotations. There is no live pick
   sync — an earlier version of this app polled a Google Sheet to track a
   different (previous) league's draft in real time; that entire mechanism
   (link, background polling, on-clock banner, activity feed, per-team
   roster sidebar, "drafted" status) was removed 9/8/2026 when this became
   a fresh 8-team league drafting on ESPN. See the CuckCentral README in
   Aki's memory for the removed feature's history if it's ever needed again. */

// IDP (DL/LB/DB) are drafted in a separate process, not on this board.
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

let players = [];          // full player list from players.json
let activePos = 'ALL';
let sortKey = 'espnRank';
let sortDir = 'asc';
let searchTerm = '';
let showWatchlistOnly = false;

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

// The header's height can still vary (title wraps at narrow widths), and
// .controls reads this CSS var for its sticky top offset.
function updateHeaderHeightVar() {
  const header = document.querySelector('header');
  if (!header) return;
  document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
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
// position's individual stat columns.
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
  if (showWatchlistOnly) return [];
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
  if (showWatchlistOnly) list = list.filter(p => starredNames.has(p._norm) || sleeperNames.has(p._norm));
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
// active), then Notes.
// Base (non-stat) column definitions shared by every position, in order.
// rowspan is 2 whenever a stat-group label row is present above the real
// stat columns, so these cells visually span both header rows.
const BASE_START_COLS = [
  { key: 'star', label: ' ', title: 'Starred' },
  { key: 'sleeper', label: ' ', title: 'Sleeper pick' },
  { key: 'espnRank', label: 'ESPN Rk', title: 'ESPN Non-PPR Top 300 overall ranking. Players outside the top 300 show —.', sortDefault: true },
  { key: 'targetRound', label: 'Tgt Rd', title: 'Your target draft round (saved in browser)' },
  { key: 'posRank', label: 'Pos Rk' },
  { key: 'name', label: 'Player' },
  { key: 'pos', label: 'Pos' },
  { key: 'team', label: 'Team' },
  { key: 'injuryRisk', label: 'Inj Risk', title: 'Injury risk category (Draft Sharks)' },
  { key: 'adp', label: 'ADP', title: 'Average Draft Position, 12-team non-PPR mocks (FantasyFootballCalculator.com)' },
  { key: 'customPts', label: 'Proj Pts' },
];
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
// the actual stat column headers underneath it. The base columns use
// rowspan="2" to span both rows so they don't need a duplicate cell. When
// there are no stat columns (K/DST), everything collapses back to a single
// row and the group row is hidden.
function buildTableHeader() {
  const groupRow = document.getElementById('header-group-row');
  const headerRow = document.getElementById('header-row');
  const cols = statColumnsFor(activePos);
  const hasStats = cols.length > 0;

  if (hasStats) {
    const baseStart = BASE_START_COLS.map(c => headerCellHtml(c, 2)).join('');
    const statLabel = `<th colspan="${cols.length}" class="stat-group-label">2026 Projections &ndash; Mike Clay ESPN</th>`;
    const notesHeader = headerCellHtml(BASE_NOTES_COL, 2);
    groupRow.innerHTML = baseStart + statLabel + notesHeader;
    groupRow.style.display = '';
    headerRow.innerHTML = cols.map(c => `<th data-key="${c.key}">${c.label}</th>`).join('');
  } else {
    groupRow.innerHTML = '';
    groupRow.style.display = 'none';
    const baseStart = BASE_START_COLS.map(c => headerCellHtml(c, 1)).join('');
    const notesHeader2 = headerCellHtml(BASE_NOTES_COL, 1);
    headerRow.innerHTML = baseStart + notesHeader2;
  }

  attachHeaderSortHandlers(groupRow);
  attachHeaderSortHandlers(headerRow);
}

function render() {
  // Don't clobber inputs the user is actively typing in (notes/tgt-input).
  // Only skip render when an INPUT/TEXTAREA has focus — not buttons.
  const _ae = document.activeElement;
  if (_ae && _ae.closest && _ae.closest('#table-body') &&
      (_ae.tagName === 'INPUT' || _ae.tagName === 'TEXTAREA')) return;
  const tbody = document.getElementById('table-body');
  const cols = statColumnsFor(activePos);
  // If the active sort column isn't in the current header set (e.g. user
  // sorted by a stat column, then switched back to ALL), fall back to
  // sorting by ESPN rank rather than silently sorting by nothing.
  const validKeys = new Set(['star', 'sleeper', 'posRank', 'name', 'pos', 'team', 'customPts', 'adp', 'espnRank', 'injuryRisk', 'targetRound', 'notes',
    ...cols.map(c => c.key)]);
  if (!validKeys.has(sortKey)) { sortKey = 'espnRank'; sortDir = 'asc'; }

  const list = getFiltered();
  const rows = list.map(p => {
    const statCellsHtml = cols.map(c => `<td class="stat-cell">${c.fmt(p[c.key])}</td>`).join('');
    const isStarred = starredNames.has(p._norm);
    const isSleeper = sleeperNames.has(p._norm);
    const tgtRnd = targetRounds[p._norm] || '';
    const tgtBadge = tgtRnd ? `<span class="tgt-badge">R${tgtRnd}</span>` : '';
    const notesVal = escapeHtml(playerNotes[p._norm] || '');
    return `<tr>
      <td class="star-cell"><button class="star-btn${isStarred ? ' starred' : ''}" data-norm="${escapeHtml(p._norm)}" title="${isStarred ? 'Unstar' : 'Star'}">${isStarred ? '\u2605' : '\u2606'}${tgtBadge}</button></td>
      <td class="sleeper-cell"><button class="sleeper-btn${isSleeper ? ' sleepered' : ''}" data-norm="${escapeHtml(p._norm)}" title="${isSleeper ? 'Remove sleeper' : 'Mark as sleeper'}">\uD83D\uDCA4${tgtBadge}</button></td>
      <td class="espn-rk-cell">${p.espnRank != null ? p.espnRank : '—'}</td>
      <td class="tgt-cell"><input class="tgt-input${tgtRnd ? ' has-value' : ''}" type="number" min="1" max="20" placeholder="—" data-norm="${escapeHtml(p._norm)}" value="${tgtRnd}" title="Target draft round"></td>
      <td>${p.posRank}</td>
      <td class="name-cell">${escapeHtml(p.name)}</td>
      <td><span class="pos-badge pos-${p.pos}">${p.pos}</span></td>
      <td>${p.team}</td>
      <td>${injuryCell(p)}</td>
      <td>${fmtAdp(p.adp)}</td>
      <td>${p.customPts != null ? p.customPts.toFixed(1) : '-'}</td>
      ${statCellsHtml}
      <td class="notes-cell"><input class="notes-input" type="text" placeholder="Notes…" data-norm="${escapeHtml(p._norm)}" value="${notesVal}" title="Personal notes"></td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows;

  const total = players.length;
  document.getElementById('count-label').textContent = `${list.length} shown / ${total} total`;

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
  const watchlistButton = `<button id="watchlist-filter-btn" class="star-filter-btn${showWatchlistOnly ? ' active' : ''}" title="Show starred and sleeper players">\u2605/\uD83D\uDCA4 Watchlist</button>`;
  container.innerHTML = posButtons + watchlistButton;
  container.querySelectorAll('button[data-pos]').forEach(btn => {
    btn.addEventListener('click', () => {
      activePos = btn.dataset.pos;
      container.querySelectorAll('button[data-pos]').forEach(b => b.classList.toggle('active', b === btn));
      buildTableHeader();
      render();
    });
  });
  document.getElementById('watchlist-filter-btn').addEventListener('click', (e) => {
    showWatchlistOnly = !showWatchlistOnly;
    e.target.classList.toggle('active', showWatchlistOnly);
    buildTableHeader();
    render();
  });
}

function wireControls() {
  document.getElementById('search').addEventListener('input', (e) => {
    searchTerm = e.target.value;
    render();
  });

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
      tgtInput.classList.toggle('has-value', !!v);
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
}

// Placeholder rows shown between page load and the first real render, so
// the page doesn't sit on a blank table for the second or so it takes to
// fetch players.json.
function renderTableSkeleton() {
  const tbody = document.getElementById('table-body');
  const cols = statColumnsFor(activePos);
  const colCount = BASE_START_COLS.length + cols.length + 1; // +1 for Notes
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
  renderTableSkeleton();
  updateHeaderHeightVar();
  window.addEventListener('resize', updateHeaderHeightVar);
  try {
    await loadPlayers();
    render();
  } catch (e) {
    console.error('Init failed', e);
    document.getElementById('count-label').textContent = `Load failed: ${e.message}`;
  }
})();
