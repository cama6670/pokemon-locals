// Pure logic shared by the page and the tests: reading the schedule text,
// building/reading iCalendar files, and diffing against the last calendar.

export const TZID = 'America/Los_Angeles';
export const UID_DOMAIN = 'pokemon-locals-ical';
export const PRODID = '-//pokemon-locals-ical//Locals Calendar Builder//EN';

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function slug(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const venueKey = (name, city) => `${slug(name)}@${slug(city)}`;
const keySlug = key => key.split('@').filter(Boolean).join('-');

const validDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const fullYear = ys => (ys ? (+ys < 100 ? 2000 + +ys : +ys) : null);

// ---------------------------------------------------------------- time zones

export function zonedParts(date, tz = TZID) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = +value;
  return { y: p.year, m: p.month, d: p.day, hh: p.hour % 24, mm: p.minute, ss: p.second };
}

// Wall-clock time in `tz` → the real instant.
export function zonedToUtc({ y, m, d, hh = 0, mm = 0, ss = 0 }, tz = TZID) {
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss);
  const offsetAt = t => {
    const p = zonedParts(new Date(t), tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - t;
  };
  let t = wall - offsetAt(wall);
  const second = wall - offsetAt(t);
  if (second !== t) t = second;
  return new Date(t);
}

const isoZ = date => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoDate = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
const icsDate = ({ y, m, d }) => `${y}${pad(m)}${pad(d)}`;
const icsLocal = p => `${icsDate(p)}T${pad(p.hh)}${pad(p.mm)}00`;
export const icsUtc = date => isoZ(date).replace(/[-:]/g, '');

function shift({ y, m, d, hh = 0, mm = 0 }, minutes) {
  const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes() };
}

// ---------------------------------------------------------------- schedule text

const TYPE_ALIASES = { chal: 'Challenge', chall: 'Challenge', challenge: 'Challenge', challenges: 'Challenge', cup: 'Cup', cups: 'Cup' };

// "Chal" → "League Challenge", "Cup + Chal" → "League Cup + Challenge".
export function expandType(raw) {
  const parts = String(raw).split(/\s*(?:\+|&|\/|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
  const named = parts.map(p => TYPE_ALIASES[p.toLowerCase().replace(/[^a-z]/g, '')] || p);
  const league = named.length && named.every(n => n === 'Challenge' || n === 'Cup');
  return (league ? 'League ' : '') + named.join(' + ');
}

const DATE = String.raw`(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?`;
const UPDATED_RE = /\bupdated\b\D*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i;
// 10/3 12:00pm Chal @ PsychoTurtle (Pico Rivera)
const EVENT_RE = new RegExp(String.raw`^${DATE}\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s+(.+?)\s+@\s+(.+?)\s*(?:\(([^()]*)\))?$`, 'i');
// — 10/10-11 Louisville Regionals —
const NOTE_RE = new RegExp(String.raw`^[—–-]*\s*${DATE}(?:\s*[-–]\s*(?:(\d{1,2})\/)?(\d{1,2}))?\s+(.+?)[\s—–-]*$`);
const STARTS_WITH_TIME = /^\d{1,2}(?::\d{2})?\s*[ap]\.?\s*m\b/i;

// The schedule never says the year, so pick the one closest to the reference date.
function resolveYear(m, d, ref) {
  let best = null;
  for (const y of [ref.y - 1, ref.y, ref.y + 1]) {
    const dist = Math.abs(Date.UTC(y, m - 1, d) - Date.UTC(ref.y, ref.m - 1, ref.d));
    if (!best || dist < best.dist) best = { y, dist };
  }
  return best.y;
}

export function parseSchedule(text, { today = new Date() } = {}) {
  const now = zonedParts(today);
  const lines = String(text || '').split(/\r?\n/);

  let updated = null;
  for (const raw of lines) {
    const m = raw.match(UPDATED_RE);
    if (!m) continue;
    const y = fullYear(m[3]) ?? resolveYear(+m[1], +m[2], now);
    if (validDate(y, +m[1], +m[2])) updated = { y, m: +m[1], d: +m[2] };
    break;
  }
  const ref = updated || now;

  const events = [], notes = [], warnings = [], ignored = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/[\u00a0\u2009\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
    const lineNo = i + 1;
    if (!line || UPDATED_RE.test(line)) return;

    let m = line.match(EVENT_RE);
    if (m) {
      const [, mo, d, ys, h, mi, ap, typeRaw, venue, city = ''] = m;
      const month = +mo, day = +d, hour = +h, mm = mi ? +mi : 0;
      const y = fullYear(ys) ?? resolveYear(month, day, ref);
      if (!validDate(y, month, day) || hour < 1 || hour > 12 || mm > 59) {
        warnings.push({ lineNo, line, reason: 'The date or time isn’t valid' });
        return;
      }
      const hh = (hour % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
      events.push({
        kind: 'event', y, m: month, d: day, hh, mm,
        typeRaw: typeRaw.trim(), type: expandType(typeRaw),
        venue: venue.trim(), city: city.trim(), key: venueKey(venue, city),
        line, lineNo,
      });
      return;
    }

    m = line.match(NOTE_RE);
    if (m) {
      const [, mo, d, ys, endMo, endD, title] = m;
      if (title.includes('@')) { warnings.push({ lineNo, line, reason: 'Missing a start time (like 12:00pm)' }); return; }
      if (STARTS_WITH_TIME.test(title)) { warnings.push({ lineNo, line, reason: 'Missing the “@ Store (City)” part' }); return; }
      const month = +mo, day = +d;
      const y = fullYear(ys) ?? resolveYear(month, day, ref);
      if (!validDate(y, month, day)) { warnings.push({ lineNo, line, reason: 'The date isn’t valid' }); return; }
      let end = { y, m: month, d: day };
      if (endD) {
        const em = endMo ? +endMo : month, ed = +endD;
        let ey = y;
        if (Date.UTC(ey, em - 1, ed) < Date.UTC(y, month - 1, day)) ey += 1;
        if (validDate(ey, em, ed)) end = { y: ey, m: em, d: ed };
      }
      notes.push({ kind: 'note', y, m: month, d: day, end, title: title.trim(), line, lineNo });
      return;
    }

    if (/^\d{1,2}\/\d{1,2}/.test(line) || line.includes('@')) warnings.push({ lineNo, line, reason: 'Couldn’t read this line' });
    else ignored.push({ lineNo, line });
  });

  // UIDs are date + store (not time), so a time change updates the same event
  // instead of looking like one removed and one added.
  events.sort((a, b) => Date.UTC(a.y, a.m - 1, a.d, a.hh, a.mm) - Date.UTC(b.y, b.m - 1, b.d, b.hh, b.mm));
  const seen = new Map();
  const uid = base => {
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return `${n === 1 ? base : `${base}-${n}`}@${UID_DOMAIN}`;
  };
  for (const e of events) e.uid = uid(`${icsDate(e)}-${keySlug(e.key)}`);
  for (const n of notes) n.uid = uid(`${icsDate(n)}-note-${slug(n.title)}`);

  return { updated, events, notes, warnings, ignored };
}

// Unique stores in order of first appearance.
export function venuesInSchedule(parsed) {
  const out = new Map();
  for (const e of parsed.events) {
    const v = out.get(e.key);
    if (v) v.count++;
    else out.set(e.key, { key: e.key, name: e.venue, city: e.city, count: 1 });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- calendar records

export const mapsUrl = query => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

export function locationText(e, venue, region) {
  return venue?.address ? `${e.venue}, ${venue.address}` : [e.venue, e.city, region].filter(Boolean).join(', ');
}

function eventRecord(e, venue, s) {
  const hours = +s.eventHours > 0 ? +s.eventHours : 3;
  const end = shift(e, Math.round(hours * 60));
  const place = `${e.venue}${e.city ? ` (${e.city})` : ''}`;
  const location = locationText(e, venue, s.region);
  const hasGeo = venue && Number.isFinite(venue.lat) && Number.isFinite(venue.lon);
  return {
    uid: e.uid, kind: 'event',
    summary: `${e.type} @ ${place}`,
    location,
    geo: hasGeo ? { lat: venue.lat, lon: venue.lon } : null,
    start: { local: icsLocal(e) }, end: { local: icsLocal(end) },
    startCanon: isoZ(zonedToUtc(e)), endCanon: isoZ(zonedToUtc(end)),
    description: `${e.type} at ${place}\n${mapsUrl(location)}\n\nSchedule line: ${e.line}`,
    x: {
      'X-LOCALS-KIND': 'event', 'X-LOCALS-VENUE': e.venue, 'X-LOCALS-CITY': e.city,
      'X-LOCALS-VENUE-KEY': e.key, 'X-LOCALS-ADDRESS': venue?.address || '', 'X-LOCALS-PLACE': venue?.name || '',
    },
    source: e,
  };
}

function noteRecord(n) {
  const endExclusive = shift(n.end, 24 * 60);
  return {
    uid: n.uid, kind: 'note', summary: n.title, location: '', geo: null,
    start: { date: icsDate(n) }, end: { date: icsDate(endExclusive) },
    startCanon: isoDate(n), endCanon: isoDate(endExclusive),
    description: `Schedule line: ${n.line}`,
    x: { 'X-LOCALS-KIND': 'note' },
    source: n,
  };
}

const byStart = (a, b) => (a.startCanon < b.startCanon ? -1 : a.startCanon > b.startCanon ? 1 : 0);

// venues: Map of venue key → { address, lat, lon }
export function buildRecords(parsed, venues, settings) {
  const recs = parsed.events.map(e => eventRecord(e, venues.get(e.key), settings));
  if (settings.includeNotes) recs.push(...parsed.notes.map(noteRecord));
  return recs.sort(byStart);
}

// ---------------------------------------------------------------- iCalendar writing

const escText = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const encoder = new TextEncoder();

// RFC 5545: lines longer than 75 octets continue on the next line after a space.
export function foldLine(line) {
  if (encoder.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const b = encoder.encode(ch).length;
    if (bytes + b > limit) { out.push(cur); cur = ''; bytes = 0; limit = 74; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', `TZID:${TZID}`, `X-LIC-LOCATION:${TZID}`,
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700', 'TZNAME:PDT',
  'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800', 'TZNAME:PST',
  'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

function eventLines(r, dtstamp) {
  const L = ['BEGIN:VEVENT', `UID:${r.uid}`, `DTSTAMP:${dtstamp}`, `SEQUENCE:${r.sequence || 0}`];
  if (r.start.date) L.push(`DTSTART;VALUE=DATE:${r.start.date}`, `DTEND;VALUE=DATE:${r.end.date}`, 'TRANSP:TRANSPARENT');
  else L.push(`DTSTART;TZID=${TZID}:${r.start.local}`, `DTEND;TZID=${TZID}:${r.end.local}`);
  L.push(`SUMMARY:${escText(r.summary)}`);
  if (r.location) L.push(`LOCATION:${escText(r.location)}`);
  if (r.geo) L.push(`GEO:${r.geo.lat.toFixed(6)};${r.geo.lon.toFixed(6)}`);
  if (r.description) L.push(`DESCRIPTION:${escText(r.description)}`);
  for (const [k, v] of Object.entries(r.x)) if (v) L.push(`${k}:${escText(v)}`);
  L.push('END:VEVENT');
  return L;
}

// records: new events; carried: events from the previous calendar kept verbatim.
export function buildICS({ records, carried = [], calName, generatedAt = new Date(), sourceUpdated = null }) {
  const stamp = icsUtc(generatedAt);
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escText(calName)}`, `X-WR-TIMEZONE:${TZID}`, `X-LOCALS-GENERATED:${stamp}`,
  ];
  if (sourceUpdated) L.push(`X-LOCALS-SOURCE-UPDATED:${isoDate(sourceUpdated)}`);
  L.push(...VTIMEZONE);
  const items = [
    ...records.map(r => ({ canon: r.startCanon, lines: eventLines(r, stamp) })),
    ...carried.map(p => ({ canon: p.startCanon, lines: p.rawLines })),
  ].sort((a, b) => (a.canon < b.canon ? -1 : a.canon > b.canon ? 1 : 0));
  for (const it of items) L.push(...it.lines);
  L.push('END:VCALENDAR');
  return L.map(foldLine).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- iCalendar reading

const unescText = s => String(s ?? '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

function splitOutsideQuotes(s, sep) {
  const out = [];
  let cur = '', q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    if (c === sep && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseProp(line) {
  let q = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ':' && !q) { colon = i; break; }
  }
  if (colon < 0) return null;
  const [name, ...rest] = splitOutsideQuotes(line.slice(0, colon), ';');
  const params = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

// A DTSTART/DTEND property → "YYYY-MM-DD" (all-day) or an ISO UTC instant.
function canonTime(p) {
  if (!p) return '';
  const v = p.value.trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return v;
  const parts = { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: +(m[6] || 0) };
  if (m[7]) return isoZ(new Date(Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss)));
  try { return isoZ(zonedToUtc(parts, p.params.TZID || TZID)); } catch { return isoZ(zonedToUtc(parts, TZID)); }
}

function parseStamp(v) {
  const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

function finishEvent(cur) {
  const P = cur.props;
  const text = n => (P[n] ? unescText(P[n].value) : '');
  const start = canonTime(P.DTSTART);
  const geo = P.GEO ? P.GEO.value.split(/[;,]/).map(Number) : [];
  const uid = text('UID') + (P['RECURRENCE-ID'] ? `#${P['RECURRENCE-ID'].value}` : '');
  return {
    uid, summary: text('SUMMARY'), location: text('LOCATION'), description: text('DESCRIPTION'),
    startCanon: start, endCanon: P.DTEND ? canonTime(P.DTEND) : start,
    sequence: parseInt(P.SEQUENCE?.value, 10) || 0,
    geo: geo.length === 2 && geo.every(Number.isFinite) ? { lat: geo[0], lon: geo[1] } : null,
    x: {
      kind: text('X-LOCALS-KIND'), venue: text('X-LOCALS-VENUE'), city: text('X-LOCALS-CITY'),
      venueKey: text('X-LOCALS-VENUE-KEY'), address: text('X-LOCALS-ADDRESS'), place: text('X-LOCALS-PLACE'),
    },
    rawLines: cur.rawLines,
  };
}

export function parseICS(text) {
  const lines = String(text || '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const calProps = {}, events = [], stack = [];
  let cur = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const p = parseProp(line);
    if (!p) continue;
    if (cur) cur.rawLines.push(line);
    if (p.name === 'BEGIN') {
      const comp = p.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VEVENT') cur = { props: {}, rawLines: [line] };
    } else if (p.name === 'END') {
      if (stack.pop() === 'VEVENT' && cur) { events.push(finishEvent(cur)); cur = null; }
    } else if (stack[stack.length - 1] === 'VEVENT' && cur) {
      if (!(p.name in cur.props)) cur.props[p.name] = p;
    } else if (stack[stack.length - 1] === 'VCALENDAR') {
      calProps[p.name] = p;
    }
  }
  return {
    name: calProps['X-WR-CALNAME'] ? unescText(calProps['X-WR-CALNAME'].value) : '',
    generated: parseStamp(calProps['X-LOCALS-GENERATED']?.value),
    events,
  };
}

// Stores the previous calendar already knows the address of.
export function venuesFromCalendar(cal) {
  const out = new Map();
  const at = cal.generated ? cal.generated.toISOString() : null;
  for (const e of cal.events) {
    const { venueKey: key, address } = e.x;
    if (!key || !address) continue;
    out.set(key, {
      key, name: e.x.venue, city: e.x.city, address, place: e.x.place,
      lat: e.geo?.lat ?? null, lon: e.geo?.lon ?? null, confirmedAt: at,
    });
  }
  return out;
}

// ---------------------------------------------------------------- diff

const FIELDS = [['startCanon', 'start'], ['endCanon', 'end'], ['summary', 'title'], ['location', 'location']];

export function diffCalendars(prevEvents, nextRecords, { now = new Date() } = {}) {
  const prevByUid = new Map(prevEvents.map(e => [e.uid, e]));
  const nextUids = new Set(nextRecords.map(r => r.uid));
  const out = { added: [], changed: [], unchanged: [], removed: [], past: [] };
  for (const next of nextRecords) {
    const prev = prevByUid.get(next.uid);
    if (!prev) { out.added.push(next); continue; }
    const fields = FIELDS.filter(([k]) => prev[k] !== next[k]).map(([, label]) => label);
    (fields.length ? out.changed : out.unchanged).push({ prev, next, fields });
  }
  const today = isoDate(zonedParts(now));
  const nowIso = isoZ(now);
  for (const prev of prevEvents) {
    if (nextUids.has(prev.uid)) continue;
    // An event that already happened simply dropped off the schedule; keep it as history.
    const isPast = prev.startCanon.length === 10 ? prev.startCanon < today : prev.startCanon < nowIso;
    (isPast ? out.past : out.removed).push(prev);
  }
  return out;
}

// Revision numbers: unchanged events keep theirs, changed ones go up by one.
export function applySequences(diff) {
  for (const r of diff.added) r.sequence = 0;
  for (const { prev, next } of diff.unchanged) next.sequence = prev.sequence;
  for (const { prev, next } of diff.changed) next.sequence = prev.sequence + 1;
}

// ---------------------------------------------------------------- display

const fmtDay = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZID, hour: 'numeric', minute: '2-digit' });
const fmtDayLA = new Intl.DateTimeFormat('en-US', { timeZone: TZID, weekday: 'short', month: 'short', day: 'numeric' });

export function describeWhen(startCanon, endCanon) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(startCanon)) {
    const s = new Date(`${startCanon}T00:00:00Z`);
    const last = endCanon ? new Date(Date.parse(`${endCanon}T00:00:00Z`) - 86400000) : s;
    return last > s ? `${fmtDay.format(s)} – ${fmtDay.format(last)} · all day` : `${fmtDay.format(s)} · all day`;
  }
  const s = new Date(startCanon);
  if (Number.isNaN(s.getTime())) return startCanon;
  const e = endCanon ? new Date(endCanon) : null;
  return `${fmtDayLA.format(s)} · ${fmtTime.format(s)}${e && e > s ? `–${fmtTime.format(e)}` : ''}`;
}
