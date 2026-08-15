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

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB'];

let players = [];          // full player list from players.json
let draftedNames = new Set(); // normalized names currently drafted
let activePos = 'ALL';
let sortKey = 'customPts';
let sortDir = 'desc';
let searchTerm = '';
let hideDrafted = false;
let pollTimer = null;

document.getElementById('sheet-link').href = SHEET_VIEW_URL;

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

// ---------- stat line formatting ----------
function statLine(p) {
  switch (p.pos) {
    case 'QB':
      return `${Math.round(p.p_yds)} pyd, ${p.p_td} pTD, ${p.intc} INT, ${Math.round(p.ru_yds)} ryd, ${p.ru_td} rTD`;
    case 'RB':
      return `${Math.round(p.ru_yds)} ryd, ${p.ru_td} rTD, ${p.rec} rec, ${Math.round(p.re_yd)} recyd, ${p.re_td} recTD`;
    case 'WR':
    case 'TE':
      return `${p.rec} rec, ${Math.round(p.re_yd)} recyd, ${p.re_td} recTD${p.ru_yds ? `, ${Math.round(p.ru_yds)} ryd` : ''}`;
    case 'DL':
    case 'LB':
    case 'DB':
      return `${p.tkl} tkl, ${p.sack} sk, ${p.intc} INT, ${p.ff} FF`;
    default:
      return '';
  }
}

// ---------- data load ----------
async function loadPlayers() {
  const res = await fetch('data/players.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`players.json fetch failed: ${res.status}`);
  players = await res.json();
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

function extractDraftedFromCsv(csvText) {
  const parsed = Papa.parse(csvText, { skipEmptyLines: false });
  const rows = parsed.data;
  const { start, end } = findPickRows(rows);
  const names = new Set();
  if (start === -1) {
    console.warn('Could not locate pick-number sequence in sheet; no drafted names extracted.');
    return names;
  }
  const teamCols = findTeamColumns(rows, start - 1);
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

async function syncDraftBoard(manual) {
  const statusEl = document.getElementById('sync-status');
  if (manual) statusEl.textContent = 'Refreshing\u2026';
  try {
    const csvText = await fetchSheetCsv();
    draftedNames = extractDraftedFromCsv(csvText);
    players.forEach(p => { p.drafted = draftedNames.has(p._norm); });
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

function render() {
  const tbody = document.getElementById('table-body');
  const list = getFiltered();
  const rows = list.map(p => {
    const draftedCls = p.drafted ? ' drafted' : '';
    const statusHtml = p.drafted
      ? '<span class="drafted-tag">DRAFTED</span>'
      : '<span class="avail-tag">Available</span>';
    return `<tr class="${draftedCls.trim()}">
      <td>${p.posRank}</td>
      <td class="name-cell">${escapeHtml(p.name)}</td>
      <td><span class="pos-badge pos-${p.pos}">${p.pos}</span></td>
      <td>${p.team}</td>
      <td>${p.customPts != null ? p.customPts.toFixed(1) : '-'}</td>
      <td class="stat-line">${statLine(p)}</td>
      <td>${statusHtml}</td>
    </tr>`;
  }).join('');
  tbody.innerHTML = rows;

  const total = players.length;
  const draftedCount = players.filter(p => p.drafted).length;
  document.getElementById('count-label').textContent =
    `${list.length} shown \u2014 ${draftedCount}/${total} drafted`;

  document.querySelectorAll('#player-table thead th').forEach(th => {
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
  document.getElementById('refresh-btn').addEventListener('click', () => syncDraftBoard(true));
  document.querySelectorAll('#player-table thead th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
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

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => syncDraftBoard(false), POLL_MS);
}

// ---------- init ----------
(async function init() {
  buildPosFilters();
  wireControls();
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
