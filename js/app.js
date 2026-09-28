import {
  parseSchedule, venuesInSchedule, buildRecords, buildICS, parseICS, diffCalendars,
  applySequences, venuesFromCalendar, describeWhen, mapsUrl, locationText,
} from './core.js';
import { findVenue, searchPlaces, cityMatches } from './geocode.js';
import { publishFiles, repoFromLocation, pagesUrl } from './github.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------------------------------------------------------- browser storage

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};
const K = { settings: 'locals.settings', venues: 'locals.venues', lastCal: 'locals.lastCalendar', draft: 'locals.scheduleDraft', token: 'locals.ghToken' };

const DEFAULTS = { calName: 'Pokémon Locals', eventHours: 3, region: 'CA', includeNotes: true, ghOwner: '', ghRepo: '', ghBranch: 'main' };

function loadSettings() {
  const saved = store.get(K.settings, {});
  const s = { ...DEFAULTS, ...saved };
  const inferred = repoFromLocation();
  if (!s.ghOwner && inferred.ghOwner) s.ghOwner = inferred.ghOwner;
  if (!s.ghRepo && inferred.ghRepo) s.ghRepo = inferred.ghRepo;
  return s;
}

// ---------------------------------------------------------------- state

const state = {
  settings: loadSettings(),
  token: store.get(K.token, ''),
  sources: { repo: new Map(), browser: new Map() }, // saved venues by where they came from
  baselines: [],       // { id, label, cal }
  baselineId: 'none',
  parsed: null,
  rows: new Map(),     // venue key → row (see makeRow)
  keep: new Set(),     // UIDs of removed events the user chose to keep
  records: [],
  diff: null,
  result: null,        // last export
};

// Newest confirmed record per venue across venues.json, this browser and the calendars.
function knownVenues() {
  const all = new Map();
  const consider = v => {
    if (!v?.key || !v.address) return;
    const cur = all.get(v.key);
    if (!cur || (v.confirmedAt || '') > (cur.confirmedAt || '')) all.set(v.key, v);
  };
  for (const b of state.baselines) for (const v of venuesFromCalendar(b.cal).values()) consider(v);
  for (const v of state.sources.repo.values()) consider(v);
  for (const v of state.sources.browser.values()) consider(v);
  return all;
}

// ---------------------------------------------------------------- loading

async function loadRepoVenues() {
  try {
    const res = await fetch('venues.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    for (const [key, v] of Object.entries(data.venues || {})) state.sources.repo.set(key, { ...v, key });
  } catch { /* no venues.json yet */ }
}

function loadBrowserVenues() {
  for (const [key, v] of Object.entries(store.get(K.venues, {}))) state.sources.browser.set(key, { ...v, key });
}

function addBaseline(id, label, text) {
  const cal = parseICS(text);
  if (!cal.events.length && !text.includes('BEGIN:VCALENDAR')) throw new Error('That file doesn’t look like an iCalendar (.ics) file.');
  state.baselines = state.baselines.filter(b => b.id !== id).concat({ id, label, cal });
  return cal;
}

async function loadBaselines() {
  try {
    const res = await fetch('calendar.ics', { cache: 'no-store' });
    if (res.ok) {
      const text = await res.text();
      if (text.includes('BEGIN:VCALENDAR')) addBaseline('repo', 'Published calendar.ics on GitHub', text);
    }
  } catch { /* not published yet */ }
  const last = store.get(K.lastCal, null);
  if (last?.text) {
    try { addBaseline('browser', 'Last export from this browser', last.text); } catch { /* ignore corrupt copy */ }
  }
  state.baselineId = newestBaselineId();
}

function newestBaselineId() {
  let best = null;
  for (const b of state.baselines) {
    const t = b.cal.generated?.getTime() ?? 0;
    if (!best || t > best.t) best = { id: b.id, t };
  }
  return best ? best.id : 'none';
}

const currentBaseline = () => state.baselines.find(b => b.id === state.baselineId) || null;

// ---------------------------------------------------------------- step 1: schedule

function readSchedule() {
  const text = $('#schedule').value;
  store.set(K.draft, text);
  const parsed = parseSchedule(text);
  state.parsed = parsed;
  state.keep.clear();
  state.result = null;

  const total = parsed.events.length + parsed.notes.length;
  const upd = parsed.updated ? ` · schedule updated ${parsed.updated.m}/${parsed.updated.d}/${parsed.updated.y}` : '';
  $('#parse-summary').textContent = total
    ? `Found ${plural(parsed.events.length, 'event')}${parsed.notes.length ? ` and ${plural(parsed.notes.length, 'note')}` : ''} at ${plural(venuesInSchedule(parsed).length, 'store')}${upd}.`
    : 'No events found — paste the schedule above.';

  let notes = '';
  if (parsed.warnings.length) {
    notes += `<div class="notice warn"><strong>${plural(parsed.warnings.length, 'line')} couldn’t be read and will be skipped:</strong><ul>${
      parsed.warnings.map(w => `<li><code>${esc(w.line)}</code> — ${esc(w.reason)}</li>`).join('')}</ul></div>`;
  }
  if (parsed.ignored.length) {
    notes += `<p class="muted small">Ignored headings: ${parsed.ignored.map(l => `“${esc(l.line)}”`).join(', ')}</p>`;
  }
  $('#parse-notes').innerHTML = notes;

  for (const id of ['#step-venues', '#step-diff', '#step-export']) $(id).hidden = !total;
  if (!total) return;

  syncRows();
  renderVenues();
  refresh();
  $('#step-venues').scrollIntoView({ behavior: 'smooth', block: 'start' });
  lookUpNewVenues();
}

// ---------------------------------------------------------------- step 2: venues

function makeRow(v, known) {
  return {
    key: v.key, name: v.name, city: v.city, count: v.count,
    status: known ? 'known' : 'pending',
    chosen: known ? { name: '', address: known.address, lat: known.lat, lon: known.lon } : null,
    savedAddress: known?.address || null,
    candidates: [],
    confirmed: !!known,
    editing: false,
    query: [v.name, v.city, state.settings.region].filter(Boolean).join(', '),
    typed: '',
    message: '',
  };
}

function syncRows() {
  const known = knownVenues();
  const next = new Map();
  for (const v of venuesInSchedule(state.parsed)) {
    const row = state.rows.get(v.key) || makeRow(v, known.get(v.key));
    row.count = v.count;
    next.set(v.key, row);
  }
  state.rows = next;
}

const fallbackChoice = row => ({ name: '', address: [row.city, state.settings.region].filter(Boolean).join(', '), lat: null, lon: null, approximate: true });

async function lookUpNewVenues() {
  const pending = [...state.rows.values()].filter(r => r.status === 'pending');
  const worker = async () => {
    while (pending.length) {
      const row = pending.shift();
      if (row.status !== 'pending') continue;
      row.status = 'searching';
      renderVenueRow(row);
      try {
        const found = await findVenue({ name: row.name, city: row.city, region: state.settings.region });
        row.candidates = found.candidates;
        row.status = found.status;
        row.message = found.message;
        row.chosen = found.status === 'found' ? pick(found.best)
          : found.best ? { ...fallbackChoice(row), lat: found.best.lat, lon: found.best.lon }
          : fallbackChoice(row);
      } catch (err) {
        row.status = 'error';
        row.message = err.message;
        row.chosen = fallbackChoice(row);
      }
      if (state.rows.get(row.key) !== row) continue; // schedule re-read meanwhile
      renderVenueRow(row);
      renderMap();
      refresh();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

const pick = c => ({ name: c.name, address: c.address, lat: c.lat, lon: c.lon });

function statusPill(row) {
  const map = {
    known: ['known', 'Saved'], pending: ['searching', 'Waiting…'], searching: ['searching', 'Looking up…'],
    found: ['found', 'New · match found'], approx: ['approx', 'New · city only'],
    notfound: ['notfound', 'New · not found'], error: ['error', 'Lookup failed'], manual: ['found', 'New · entered by you'],
    changed: ['found', 'Changed'],
  };
  const [cls, label] = map[row.status] || ['', row.status];
  return `<span class="pill ${cls}">${label}</span>`;
}

function venueRowHtml(row) {
  const busy = row.status === 'pending' || row.status === 'searching';
  const c = row.chosen;
  const loc = c ? locationText({ venue: row.name, city: row.city }, c, state.settings.region) : '';
  let html = `<div class="venue-head">${statusPill(row)}<h3>${esc(row.name)} <span class="city">${esc(row.city)}</span></h3><span class="count">${plural(row.count, 'event')}</span></div>`;

  if (busy) return html + '<p class="addr muted">Searching for the store…</p>';

  if (c) {
    html += `<p class="addr">${c.name ? `<span class="place">${esc(c.name)}</span>` : ''}<span>${esc(c.address)}</span>
      <a href="${esc(mapsUrl(loc))}" target="_blank" rel="noopener">Check on Google Maps ↗</a></p>`;
  }
  if (row.status === 'approx' || (c?.approximate && (row.status === 'found' || row.status === 'manual'))) {
    html += `<p class="hint">Only the city was found. That’s fine for the calendar (Google Maps will search “${esc(loc)}”), or search for the exact address below.</p>`;
  }
  if (row.status === 'notfound') html += `<p class="hint">No match. The calendar will use “${esc(loc)}” — or search below.</p>`;
  if (row.status === 'error') html += `<p class="hint bad">${esc(row.message)} — the calendar will use the store name and city, or try searching again.</p>`;
  if (row.status !== 'known' && c && !c.approximate && c.address && !cityMatches(c.address, row.city)) {
    html += `<p class="hint">This address isn’t in ${esc(row.city)} — double-check it’s the right store.</p>`;
  }
  if (row.message && row.status !== 'error') html += `<p class="hint">${esc(row.message)}</p>`;

  const showEditor = row.editing || !['known', 'found'].includes(row.status) || (row.status === 'found' && row.message);
  if (showEditor) {
    if (row.candidates.length > 1 && row.candidates.some(x => x.precise)) {
      const sel = row.candidates.findIndex(x => c && x.address === c.address && x.lat === c.lat);
      html += `<select class="cand" data-act="cand" aria-label="Other matches">
        <option value="-1"${sel < 0 ? ' selected' : ''}>${row.candidates.length} matches — pick another…</option>
        ${row.candidates.map((x, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc([x.name, x.address].filter(Boolean).join(' — '))}${x.precise ? '' : ' (area)'}</option>`).join('')}
      </select>`;
    }
    html += `<div class="search">
      <input type="text" data-act="query" value="${esc(row.typed || row.query)}" aria-label="Search for ${esc(row.name)}" placeholder="Store name or street address">
      <button type="button" class="small" data-act="search">Search</button>
      <button type="button" class="small" data-act="use-typed" title="Use exactly what you typed as the address">Use as typed</button>
    </div>`;
  }
  let tool = '';
  if (row.status === 'known') {
    tool = row.editing
      ? '<button type="button" class="link" data-act="revert">Keep saved address</button>'
      : '<button type="button" class="link" data-act="edit">Change location</button>';
  } else if (!showEditor) {
    tool = '<button type="button" class="link" data-act="edit">Wrong store? Search again</button>';
  }
  html += `<div class="venue-foot"><label class="confirm"><input type="checkbox" data-act="confirm"${row.confirmed ? ' checked' : ''}> Location is correct</label>${tool}</div>`;
  return html;
}

function renderVenueRow(row) {
  let el = document.getElementById(`venue-${cssId(row.key)}`);
  if (!el) {
    el = document.createElement('article');
    el.id = `venue-${cssId(row.key)}`;
    el.dataset.key = row.key;
    $('#venue-list').append(el);
  }
  const busy = row.status === 'pending' || row.status === 'searching';
  el.className = `venue ${row.confirmed ? 'ok' : busy ? '' : 'needs'}`;
  el.innerHTML = venueRowHtml(row);
  renderVenueSummary();
}

const cssId = key => key.replace(/[^a-z0-9-]/gi, '_');

function renderVenues() {
  const list = $('#venue-list');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  // New stores first, so they're what you see.
  const rows = [...state.rows.values()].sort((a, b) => (a.status === 'known') - (b.status === 'known'));
  for (const row of rows) renderVenueRow(row);
  list.scrollTop = scroll;
  renderMap();
}

// Scroll the store list (not the whole page) to a card and flash it.
function revealVenue(key, { page = false } = {}) {
  const card = document.getElementById(`venue-${cssId(key)}`);
  if (!card) return;
  if (page) $('#step-venues').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const list = $('#venue-list');
  list.scrollTo({ top: card.offsetTop - (list.clientHeight - card.offsetHeight) / 2, behavior: 'smooth' });
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
}

// Exact name + city matches with nothing to warn about.
const cleanMatch = row => row.status === 'found' && !row.message && !row.confirmed && row.chosen && cityMatches(row.chosen.address, row.city);

function renderVenueSummary() {
  const rows = [...state.rows.values()];
  const fresh = rows.filter(r => r.status !== 'known').length;
  const open = rows.filter(r => !r.confirmed).length;
  const clean = rows.filter(cleanMatch).length;
  $('#venue-summary').innerHTML = `${plural(rows.length, 'store')} on this schedule · ${fresh ? `${fresh} new` : 'no new stores'}${
    open ? ` · ${open} still to confirm` : ' · all confirmed ✓'}${
    clean > 1 ? ` · <button type="button" class="link" data-act="confirm-clean">Mark the ${clean} exact matches as correct</button>` : ''}`;
}

function confirmCleanMatches() {
  for (const row of state.rows.values()) if (cleanMatch(row)) row.confirmed = true;
  renderVenues();
  renderExport();
}

function onVenueEvent(e) {
  const el = e.target.closest('[data-act]');
  const card = e.target.closest('.venue');
  if (!el || !card) return;
  const row = state.rows.get(card.dataset.key);
  if (!row) return;
  const act = el.dataset.act;
  const type = e.type;

  if (act === 'query' && type === 'input') { row.typed = el.value; return; }
  if (act === 'query' && type === 'keydown') {
    if (e.key === 'Enter') { e.preventDefault(); searchRow(row, el.value); }
    return;
  }
  if (type === 'keydown') return;
  if (act === 'confirm' && type === 'change') {
    row.confirmed = el.checked;
    renderVenueRow(row);
    renderMap();
    renderExport();
    return;
  }
  if (act === 'cand' && type === 'change') {
    const c = row.candidates[+el.value];
    if (!c) return;
    row.chosen = c.precise ? pick(c) : { ...fallbackChoice(row), lat: c.lat, lon: c.lon };
    row.message = '';
    changed(row, { focus: true });
    return;
  }
  if (type !== 'click') return;
  if (act === 'search') searchRow(row, card.querySelector('[data-act="query"]').value);
  if (act === 'use-typed') {
    const text = card.querySelector('[data-act="query"]').value.trim();
    if (!text) return;
    row.chosen = { name: '', address: text, lat: null, lon: null };
    if (row.status !== 'known') row.status = 'manual';
    row.message = 'Using your text as the address (no map pin).';
    changed(row);
  }
  if (act === 'edit') { row.editing = true; renderVenueRow(row); }
  if (act === 'revert') {
    const saved = knownVenues().get(row.key);
    Object.assign(row, makeRow(row, saved), { count: row.count });
    changed(row, { keepConfirmed: true, focus: true });
  }
}

// Anything that changes a row's location needs a fresh confirmation.
// `focus` zooms the map to the row's new spot.
function changed(row, { keepConfirmed = false, focus = false } = {}) {
  if (!keepConfirmed) row.confirmed = false;
  renderVenueRow(row);
  renderMap(focus ? row.key : null);
  refresh();
}

async function searchRow(row, query) {
  query = String(query || '').trim();
  if (!query) return;
  row.typed = query;
  const card = document.getElementById(`venue-${cssId(row.key)}`);
  const btn = card?.querySelector('[data-act="search"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Searching…'; }
  try {
    const found = await searchPlaces(query);
    row.candidates = found;
    row.message = found.length ? '' : `Nothing found for “${query}”.`;
    const best = found.find(c => c.precise) || found[0];
    if (best) {
      row.chosen = best.precise ? pick(best) : { ...fallbackChoice(row), lat: best.lat, lon: best.lon };
      if (row.status !== 'known') row.status = best.precise ? 'found' : 'approx';
    }
  } catch (err) {
    row.message = `${err.message}. Try again, or use “Use as typed”.`;
  }
  changed(row, { focus: true });
}

// ---------------------------------------------------------------- map

let map = null, layer = null, lastPins = '';

// focusKey: zoom in on that store instead of framing them all.
function renderMap(focusKey = null) {
  const el = $('#map');
  if (!window.L) {
    el.innerHTML = '<div class="map-fallback">Map unavailable (couldn’t load the map library). Use the Google Maps links instead.</div>';
    return;
  }
  if (!map) {
    map = L.map(el).setView([34.0, -117.9], 8);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    layer = L.featureGroup().addTo(map);
  }
  layer.clearLayers();
  const styles = getComputedStyle(document.documentElement);
  const ok = styles.getPropertyValue('--ok').trim(), warn = styles.getPropertyValue('--warn').trim();
  let focus = null;
  for (const row of state.rows.values()) {
    const c = row.chosen;
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const marker = L.circleMarker([c.lat, c.lon], {
      radius: c.approximate ? 6 : 8, color: '#fff', weight: 2, fillOpacity: 0.95,
      fillColor: row.confirmed ? ok : warn, dashArray: c.approximate ? '3 3' : null,
    });
    marker.bindTooltip(`${esc(row.name)} (${esc(row.city)})${c.approximate ? ' — city only' : ''}${row.confirmed ? '' : ' — not confirmed yet'}`);
    marker.on('click', () => revealVenue(row.key));
    layer.addLayer(marker);
    if (row.key === focusKey) focus = { marker, zoom: c.approximate ? 12 : 16 };
  }
  // Only re-frame when pins move, so confirming a store doesn't undo your zoom.
  const pins = layer.getLayers().map(m => m.getLatLng().toString()).sort().join('|');
  setTimeout(() => {
    map.invalidateSize();
    if (focus) {
      map.flyTo(focus.marker.getLatLng(), focus.zoom, { duration: 0.8 });
      focus.marker.openTooltip();
    } else if (pins && pins !== lastPins) {
      map.fitBounds(layer.getBounds().pad(0.15), { maxZoom: 13 });
    }
    lastPins = pins;
  }, 0);
}

// ---------------------------------------------------------------- step 3: diff

function chosenVenues() {
  const out = new Map();
  for (const row of state.rows.values()) if (row.chosen) out.set(row.key, row.chosen);
  return out;
}

function refresh() {
  if (!state.parsed) return;
  state.records = buildRecords(state.parsed, chosenVenues(), state.settings);
  const base = currentBaseline();
  state.diff = diffCalendars(base ? base.cal.events : [], state.records);
  renderDiff();
  renderExport();
}

function renderBaselineSelect() {
  const fmt = d => (d ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown date');
  const opts = state.baselines.map(b =>
    `<option value="${b.id}"${b.id === state.baselineId ? ' selected' : ''}>${esc(b.label)} — ${b.cal.generated ? `made ${fmt(b.cal.generated)}` : 'no build date'} · ${plural(b.cal.events.length, 'event')}</option>`);
  opts.push(`<option value="none"${state.baselineId === 'none' ? ' selected' : ''}>Nothing — treat every event as new</option>`);
  $('#baseline-select').innerHTML = opts.join('');
}

const evItem = (r, extra = '') =>
  `<li><time>${esc(describeWhen(r.startCanon, r.endCanon))}</time><span>${esc(r.summary)}</span>${r.location ? `<span class="loc">${esc(r.location)}</span>` : ''}${extra}</li>`;

function deltaHtml({ prev, next, fields }) {
  const out = [];
  if (fields.includes('start') || fields.includes('end')) {
    out.push(`When: <del>${esc(describeWhen(prev.startCanon, prev.endCanon))}</del> → <ins>${esc(describeWhen(next.startCanon, next.endCanon))}</ins>`);
  }
  if (fields.includes('title')) out.push(`Title: <del>${esc(prev.summary)}</del> → <ins>${esc(next.summary)}</ins>`);
  if (fields.includes('location')) out.push(`Location: <del>${esc(prev.location || '(none)')}</del> → <ins>${esc(next.location || '(none)')}</ins>`);
  return out.map(x => `<span class="delta">${x}</span>`).join('');
}

function renderDiff() {
  const d = state.diff;
  const base = currentBaseline();
  let html = `<div class="chips">
    <span class="chip add">+ ${d.added.length} new</span>
    <span class="chip chg">${d.changed.length} changed</span>
    <span class="chip del">− ${d.removed.length} removed</span>
    <span class="chip">${d.unchanged.length} unchanged</span>
    ${d.past.length ? `<span class="chip">${d.past.length} past, kept</span>` : ''}
  </div>`;

  if (!base) html += '<p class="muted">No previous calendar to compare with, so everything below is new.</p>';
  else if (!d.added.length && !d.changed.length && !d.removed.length) html += '<div class="notice ok">No changes — this matches the last calendar.</div>';

  if (d.added.length) html += `<h3>${base ? 'New events' : 'Events'}</h3><ul class="evlist add">${d.added.map(r => evItem(r)).join('')}</ul>`;
  if (d.changed.length) html += `<h3>Changed</h3><ul class="evlist chg">${d.changed.map(c => evItem(c.next, deltaHtml(c))).join('')}</ul>`;
  if (d.removed.length) {
    html += `<h3>No longer on the schedule</h3>
      <p class="muted small">These upcoming events were in the last calendar but aren’t in this schedule. They’ll be left out unless you keep them.</p>
      <ul class="evlist del">${d.removed.map(p => evItem(p,
        `<label class="keep"><input type="checkbox" data-keep="${esc(p.uid)}"${state.keep.has(p.uid) ? ' checked' : ''}> Keep it anyway</label>`)).join('')}</ul>`;
  }
  if (d.unchanged.length) html += `<details class="more"><summary>Unchanged (${d.unchanged.length})</summary><ul class="evlist">${d.unchanged.map(c => evItem(c.next)).join('')}</ul></details>`;
  if (d.past.length) html += `<details class="more"><summary>Past events kept from the last calendar (${d.past.length})</summary><ul class="evlist">${d.past.map(p => evItem(p)).join('')}</ul></details>`;
  $('#diff').innerHTML = html;
}

// ---------------------------------------------------------------- step 4: export

function renderExport() {
  if (!state.parsed || !state.diff) return;
  const rows = [...state.rows.values()];
  const busy = rows.filter(r => r.status === 'pending' || r.status === 'searching').length;
  const open = rows.filter(r => !r.confirmed).length;
  const d = state.diff;
  const kept = d.removed.filter(p => state.keep.has(p.uid)).length;
  const total = state.records.length + d.past.length + kept;
  const s = state.settings;

  let html = '';
  if (state.result) html += resultHtml();

  html += `<p class="export-summary">The calendar will have <strong>${plural(total, 'event')}</strong>: ${d.added.length} new, ${d.changed.length} changed, ${d.unchanged.length} unchanged${d.past.length ? `, ${d.past.length} past` : ''}${kept ? `, ${kept} kept` : ''}${d.removed.length - kept ? ` — ${d.removed.length - kept} removed` : ''}.</p>`;

  if (busy) html += `<div class="notice info">Still looking up ${plural(busy, 'store')}…</div>`;
  else if (open) html += `<div class="notice warn">Confirm ${plural(open, 'more location')} in step 2 before exporting. <button type="button" class="link" data-act="goto-open">Show me</button></div>`;

  const ready = !busy && !open;
  const canPublish = s.ghOwner && s.ghRepo && state.token;
  const pendingChanges = d.added.length || d.changed.length || d.removed.length > kept;
  html += `<div class="actions">
    ${!state.result || pendingChanges ? `<button type="button" class="primary" id="export-btn"${ready ? '' : ' disabled'}>Confirm &amp; download .ics</button>` : ''}
    ${canPublish ? `<button type="button" id="publish-btn"${ready ? '' : ' disabled'}>Also publish to GitHub</button>` : ''}
    <span class="muted small" id="publish-status" role="status"></span>
  </div>`;
  if (!canPublish) html += '<p class="muted small">Want every device to share the same “last calendar” (and a link Google can subscribe to)? Set up <em>Publish to GitHub</em> in Settings.</p>';

  html += howToHtml();
  $('#export').innerHTML = html;
}

function resultHtml() {
  const r = state.result;
  return `<div class="notice ok"><strong>Downloaded ${esc(r.filename)}</strong> — ${plural(r.count, 'event')}. It’s now saved as this browser’s latest calendar, so next week’s changes are compared against it.
    <div class="actions"><a class="button small" href="${r.url}" download="${esc(r.filename)}">Download ${esc(r.filename)} again</a></div></div>`;
}

function howToHtml() {
  const s = state.settings;
  const sub = s.ghOwner && s.ghRepo ? pagesUrl(s, 'calendar.ics') : null;
  const removed = state.diff.removed.filter(p => !state.keep.has(p.uid));
  return `<details class="howto" open><summary>Putting it into Google Calendar</summary>
    <ol class="steps">
      <li>On a computer, open <a href="https://calendar.google.com/calendar/r/settings/export" target="_blank" rel="noopener">Google Calendar → Settings → Import &amp; export</a>.</li>
      <li>Drag the downloaded <code>.ics</code> onto <em>Select file from your computer</em> (or click it and pick the file).</li>
      <li>Under <em>Add to calendar</em>, pick your locals calendar, then <em>Import</em>.</li>
    </ol>
    <p class="small">Every event keeps the same ID from week to week, so importing into the same calendar updates events that moved instead of duplicating them. Google’s import never deletes anything, though${
      removed.length ? ` — delete ${removed.length === 1 ? 'the event' : `the ${removed.length} events`} listed under <em>No longer on the schedule</em> by hand` : ''}. For an exact replacement, delete the locals calendar (Settings → the calendar → <em>Remove calendar</em>), create a fresh one, and import the file into it.</p>
    ${sub ? `<p class="small"><strong>Hands-off option:</strong> after publishing to GitHub, subscribe once in Google Calendar (<em>Other calendars → + → From URL</em>) with this link. Google re-reads it on its own every several hours, removals included:</p>
      <div class="subscribe"><input type="text" readonly value="${esc(sub)}" aria-label="Subscription URL"><button type="button" class="small" data-act="copy-sub">Copy</button></div>` : ''}
  </details>`;
}

function buildCalendar() {
  const d = state.diff;
  applySequences(d);
  const carried = [...d.past, ...d.removed.filter(p => state.keep.has(p.uid))];
  const generatedAt = new Date();
  const text = buildICS({ records: state.records, carried, calName: state.settings.calName, generatedAt, sourceUpdated: state.parsed.updated });
  return { text, generatedAt, count: state.records.length + carried.length };
}

// Confirmed stores become "known", so next week only brand-new ones are looked up.
function saveVenues(at) {
  const saved = store.get(K.venues, {});
  for (const row of state.rows.values()) {
    if (!row.chosen) continue;
    const prev = saved[row.key];
    const same = prev && prev.address === row.chosen.address;
    saved[row.key] = {
      name: row.name, city: row.city, address: row.chosen.address,
      lat: Number.isFinite(row.chosen.lat) ? row.chosen.lat : null,
      lon: Number.isFinite(row.chosen.lon) ? row.chosen.lon : null,
      confirmedAt: same && prev.confirmedAt ? prev.confirmedAt : at,
    };
    state.sources.browser.set(row.key, { ...saved[row.key], key: row.key });
  }
  store.set(K.venues, saved);
}

function venuesJson(at) {
  const all = knownVenues();
  const venues = {};
  for (const [key, v] of [...all.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    venues[key] = { name: v.name, city: v.city, address: v.address, lat: v.lat ?? null, lon: v.lon ?? null, confirmedAt: v.confirmedAt || at };
  }
  return JSON.stringify({ updated: at, venues }, null, 2) + '\n';
}

function afterBuild({ text, generatedAt, count }) {
  const at = generatedAt.toISOString();
  saveVenues(at);
  const filename = `pokemon-locals-${localDate(generatedAt)}.ics`;
  if (state.result?.url) URL.revokeObjectURL(state.result.url);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  state.result = { filename, url, count, text, at };

  const saved = store.set(K.lastCal, { text, savedAt: at });
  if (!saved) console.warn('Could not save the calendar in this browser (storage unavailable).');

  for (const row of state.rows.values()) {
    if (!row.chosen) continue;
    Object.assign(row, { status: 'known', savedAddress: row.chosen.address, editing: false, message: '', confirmed: true });
  }

  // From now on, compare against what was just exported.
  addBaseline('browser', 'Last export from this browser', text);
  state.baselineId = 'browser';
  renderBaselineSelect();
  renderVenues();
  refresh();
}

function download() {
  const built = buildCalendar();
  afterBuild(built);
  const a = document.createElement('a');
  a.href = state.result.url;
  a.download = state.result.filename;
  document.body.append(a);
  a.click();
  a.remove();
  return built;
}

async function publish() {
  const status = () => $('#publish-status');
  const btn = $('#publish-btn');
  if (btn) btn.disabled = true;
  status().textContent = 'Publishing…';
  try {
    if (!state.result) download();
    const { text, at } = state.result;
    await publishFiles(state.settings, state.token, {
      'calendar.ics': text,
      'venues.json': venuesJson(at),
    }, `Update locals calendar (${localDate(new Date(at))})`);
    status().textContent = 'Published ✓ — GitHub Pages updates in a minute or two.';
  } catch (err) {
    status().textContent = `Couldn’t publish: ${err.message}`;
  } finally {
    const b = $('#publish-btn');
    if (b) b.disabled = false;
  }
}

// ---------------------------------------------------------------- settings

function bindSettings() {
  const s = state.settings;
  for (const [k, v] of Object.entries(s)) {
    const el = document.getElementById(`set-${k}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    el.addEventListener('change', () => {
      s[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) || DEFAULTS[k] : el.value.trim();
      store.set(K.settings, s);
      if (k === 'region') for (const row of state.rows.values()) row.query = [row.name, row.city, s.region].filter(Boolean).join(', ');
      refresh();
    });
  }
  const tok = $('#gh-token'), remember = $('#gh-remember');
  tok.value = state.token;
  remember.checked = !!store.get(K.token, '');
  const saveToken = () => {
    state.token = tok.value.trim();
    if (remember.checked && state.token) store.set(K.token, state.token); else store.remove(K.token);
    renderExport();
  };
  tok.addEventListener('change', saveToken);
  remember.addEventListener('change', saveToken);
}

// ---------------------------------------------------------------- files & drag-drop

async function openBaselineFile(file) {
  try {
    const text = await file.text();
    addBaseline('file', `File: ${file.name}`, text);
    state.baselineId = 'file';
    // Stores in the opened calendar count as known too.
    const known = knownVenues();
    for (const row of state.rows.values()) {
      if (row.status === 'known' || row.status === 'searching' || row.confirmed) continue;
      const k = known.get(row.key);
      if (k) Object.assign(row, makeRow(row, k), { count: row.count });
    }
    renderBaselineSelect();
    if (state.parsed) { renderVenues(); refresh(); }
  } catch (err) {
    alert(err.message);
  }
}

function setupDrop() {
  const hint = $('#drop-hint');
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { depth++; hint.hidden = false; } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; hint.hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; hint.hidden = true;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (/\.ics$/i.test(file.name) || file.type === 'text/calendar') {
      await openBaselineFile(file);
      if (!$('#step-diff').hidden) $('#step-diff').scrollIntoView({ behavior: 'smooth' });
    } else {
      $('#schedule').value = await file.text();
      readSchedule();
    }
  });
}

// ---------------------------------------------------------------- start

async function init() {
  bindSettings();
  setupDrop();
  $('#schedule').value = store.get(K.draft, '');
  $('#schedule').addEventListener('input', e => store.set(K.draft, e.target.value));
  $('#schedule').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) readSchedule(); });
  $('#read-btn').addEventListener('click', readSchedule);

  const list = $('#venue-list');
  for (const type of ['click', 'change', 'input', 'keydown']) list.addEventListener(type, onVenueEvent);
  $('#venue-summary').addEventListener('click', e => { if (e.target.dataset.act === 'confirm-clean') confirmCleanMatches(); });

  $('#baseline-select').addEventListener('change', e => { state.baselineId = e.target.value; state.keep.clear(); refresh(); });
  $('#baseline-file').addEventListener('change', e => { const f = e.target.files[0]; if (f) openBaselineFile(f); e.target.value = ''; });
  $('#diff').addEventListener('change', e => {
    const uid = e.target.dataset?.keep;
    if (uid == null) return;
    if (e.target.checked) state.keep.add(uid); else state.keep.delete(uid);
    renderExport();
  });
  $('#export').addEventListener('click', e => {
    if (e.target.id === 'export-btn') download();
    if (e.target.id === 'publish-btn') publish();
    if (e.target.dataset.act === 'copy-sub') {
      const input = e.target.previousElementSibling;
      navigator.clipboard?.writeText(input.value).then(() => { e.target.textContent = 'Copied'; }, () => input.select());
    }
    if (e.target.dataset.act === 'goto-open') {
      const row = [...state.rows.values()].find(r => !r.confirmed);
      if (row) revealVenue(row.key, { page: true });
    }
  });

  await Promise.all([loadRepoVenues(), loadBaselines()]);
  loadBrowserVenues();
  renderBaselineSelect();
}

init();
