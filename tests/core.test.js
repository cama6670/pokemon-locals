import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSchedule, buildRecords, buildICS, parseICS, diffCalendars, applySequences,
  venuesFromCalendar, venuesInSchedule, expandType, foldLine, describeWhen,
} from '../js/core.js';
import { tidyAddress } from '../js/geocode.js';

const SAMPLE = readFileSync(new URL('../sample-schedule.txt', import.meta.url), 'utf8');
const TODAY = new Date('2026-09-27T19:00:00Z');
const SETTINGS = { calName: 'Pokémon Locals', eventHours: 3, region: 'CA', includeNotes: true };

const venuesMap = entries => new Map(entries);
const build = (parsed, venues = new Map(), prev = [], now = TODAY, keep = []) => {
  const records = buildRecords(parsed, venues, SETTINGS);
  const diff = diffCalendars(prev, records, { now });
  applySequences(diff);
  const carried = [...diff.past, ...diff.removed.filter(p => keep.includes(p.uid))];
  const text = buildICS({ records, carried, calName: SETTINGS.calName, generatedAt: now, sourceUpdated: parsed.updated });
  return { records, diff, text };
};

test('reads every event and note in the sample schedule', () => {
  const p = parseSchedule(SAMPLE, { today: TODAY });
  assert.deepEqual(p.updated, { y: 2026, m: 9, d: 27 });
  assert.equal(p.events.length, 25);
  assert.equal(p.notes.length, 1);
  assert.equal(p.warnings.length, 0);
  assert.deepEqual(p.ignored.map(l => l.line), ['This Week!', 'October', 'November']);
  assert.equal(venuesInSchedule(p).length, 14);

  const first = p.events[0];
  assert.equal(first.uid, '20261003-psychoturtle-pico-rivera@pokemon-locals-ical');
  assert.deepEqual([first.y, first.m, first.d, first.hh, first.mm], [2026, 10, 3, 12, 0]);
  assert.equal(first.type, 'League Challenge');

  const rsg = p.events.find(e => e.venue.startsWith('Ready'));
  assert.equal(rsg.venue, 'Ready, Set, Game!');
  assert.equal(rsg.city, 'Menifee');

  const combo = p.events.filter(e => /\+/.test(e.typeRaw)).map(e => e.type);
  assert.deepEqual(combo, ['League Cup + Challenge', 'League Cup + Challenge']);

  const note = p.notes[0];
  assert.equal(note.title, 'Louisville Regionals');
  assert.deepEqual(note.end, { y: 2026, m: 10, d: 11 });

  const uids = new Set([...p.events, ...p.notes].map(e => e.uid));
  assert.equal(uids.size, 26, 'UIDs are unique');
});

test('rolls the year over for January events on a December schedule', () => {
  const p = parseSchedule('Locals Schedule Updated 12/20\n1/3 12:00pm Cup @ Shop (Town)\n12/27 6:30pm Chal @ Shop (Town)', { today: new Date('2026-12-20T20:00:00Z') });
  assert.deepEqual(p.events.map(e => `${e.y}-${e.m}-${e.d}`), ['2026-12-27', '2027-1-3']);
});

test('flags lines it cannot read instead of dropping them silently', () => {
  const p = parseSchedule('10/3 Chal @ PsychoTurtle (Pico Rivera)\n10/4 12:00pm Chal PsychoTurtle\n13/40 1:00pm Cup @ X (Y)\nOctober', { today: TODAY });
  assert.equal(p.events.length, 0);
  assert.equal(p.warnings.length, 3);
  assert.equal(p.ignored.length, 1);
});

test('expands event types', () => {
  assert.equal(expandType('Chal'), 'League Challenge');
  assert.equal(expandType('Cup'), 'League Cup');
  assert.equal(expandType('Cup + Chal'), 'League Cup + Challenge');
  assert.equal(expandType('Prerelease'), 'Prerelease');
});

test('builds a valid calendar with Los Angeles times and locations', () => {
  const p = parseSchedule(SAMPLE, { today: TODAY });
  const venues = venuesMap([['psychoturtle@pico-rivera', { address: '9547 Telegraph Rd, Pico Rivera, CA 90660', lat: 33.954466, lon: -118.09939 }]]);
  const { text, records } = build(p, venues);

  assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(text.endsWith('END:VCALENDAR\r\n'));
  for (const line of text.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, `line too long: ${line}`);
  assert.equal((text.match(/BEGIN:VEVENT/g) || []).length, 26);

  const cal = parseICS(text);
  const ev = cal.events.find(e => e.uid.startsWith('20261003-psychoturtle'));
  assert.equal(ev.summary, 'League Challenge @ PsychoTurtle (Pico Rivera)');
  assert.equal(ev.location, 'PsychoTurtle, 9547 Telegraph Rd, Pico Rivera, CA 90660');
  assert.equal(ev.startCanon, '2026-10-03T19:00:00Z', 'noon PDT is 19:00 UTC');
  assert.equal(ev.endCanon, '2026-10-03T22:00:00Z', '3 hour event');
  assert.deepEqual(ev.geo, { lat: 33.954466, lon: -118.09939 });

  const cup = cal.events.find(e => e.uid.startsWith('20261128-the-collectors-kut'));
  assert.equal(cup.startCanon, '2026-11-28T20:00:00Z', 'noon PST (after DST ends) is 20:00 UTC');
  assert.equal(cup.endCanon, '2026-11-28T23:00:00Z', 'cups are 3 hours too');
  assert.equal(cup.location, "The Collector's Kut, Downey, CA", 'falls back to name + city');

  const note = cal.events.find(e => e.uid.includes('-note-'));
  assert.equal(note.startCanon, '2026-10-10');
  assert.equal(note.endCanon, '2026-10-12', 'all-day end is exclusive');

  for (const r of records.filter(r => r.kind === 'event')) {
    assert.equal(Date.parse(r.endCanon) - Date.parse(r.startCanon), 3 * 3600000, `${r.uid} is 3 hours`);
  }

  // Round trip: every record reads back identically.
  for (const r of records) {
    const back = cal.events.find(e => e.uid === r.uid);
    for (const k of ['summary', 'location', 'startCanon', 'endCanon', 'description']) assert.equal(back[k], r[k], `${r.uid} ${k}`);
  }
});

test('remembers store addresses inside the calendar', () => {
  const p = parseSchedule(SAMPLE, { today: TODAY });
  const venues = venuesMap([['fire-and-dice@northridge', { address: '9036 Tampa Ave, Northridge, CA 91324', lat: 34.2356, lon: -118.5536 }]]);
  const { text } = build(p, venues);
  const known = venuesFromCalendar(parseICS(text));
  assert.deepEqual([...known.keys()], ['fire-and-dice@northridge']);
  assert.equal(known.get('fire-and-dice@northridge').address, '9036 Tampa Ave, Northridge, CA 91324');
  assert.equal(known.get('fire-and-dice@northridge').name, 'Fire & Dice');
});

test('diffs against the last calendar: new, changed, removed, past', () => {
  const week1 = parseSchedule(SAMPLE, { today: TODAY });
  const first = build(week1);
  const prev = parseICS(first.text).events;

  const edited = SAMPLE
    .replace('10/3 12:00pm Chal @ PsychoTurtle', '10/3 1:00pm Chal @ PsychoTurtle')          // time change
    .replace('10/31 1:00pm Chal @ Gameology (Upland)\n', '')                               // cancelled
    .replace('11/28 12:00pm Cup', '11/28 12:00pm Cup @ Gameology (Upland)\n11/28 12:00pm Cup'); // new
  const week2 = parseSchedule(edited, { today: TODAY });
  const { diff, text } = build(week2, new Map(), prev);

  assert.deepEqual(diff.added.map(r => r.uid), ['20261128-gameology-upland@pokemon-locals-ical']);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].next.uid, '20261003-psychoturtle-pico-rivera@pokemon-locals-ical');
  assert.deepEqual(diff.changed[0].fields, ['start', 'end']);
  assert.equal(diff.changed[0].next.sequence, 1, 'changed events get a higher SEQUENCE');
  assert.deepEqual(diff.removed.map(p => p.uid), ['20261031-gameology-upland@pokemon-locals-ical']);
  assert.equal(diff.unchanged.length, 24);
  assert.equal(diff.past.length, 0);
  assert.ok(!text.includes('20261031-gameology-upland'), 'removed event is left out');

  // Two weeks later the 10/3 event has happened and is no longer listed: it's kept as history.
  const later = new Date('2026-10-10T08:00:00Z');
  const week3 = parseSchedule(edited.replace(/^10\/3 .*\n/m, ''), { today: later });
  const third = build(week3, new Map(), parseICS(text).events, later);
  assert.deepEqual(third.diff.past.map(p => p.uid), ['20261003-psychoturtle-pico-rivera@pokemon-locals-ical']);
  assert.equal(third.diff.removed.length, 0);
  assert.ok(third.text.includes('UID:20261003-psychoturtle-pico-rivera'), 'past event carried over');
  assert.equal(parseICS(third.text).events.length, 26);
});

test('an unchanged schedule produces no changes on the second run', () => {
  const p = parseSchedule(SAMPLE, { today: TODAY });
  const first = build(p);
  const second = build(p, new Map(), parseICS(first.text).events);
  assert.equal(second.diff.added.length + second.diff.changed.length + second.diff.removed.length, 0);
});

test('reads calendars exported with UTC times (e.g. from Google)', () => {
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:20261003-psychoturtle-pico-rivera@pokemon-locals-ical\r\nDTSTART:20261003T190000Z\r\nDTEND:20261003T220000Z\r\nSUMMARY:League Challenge @ PsychoTurtle (Pico Rivera)\r\nLOCATION:PsychoTurtle\\, Pico Rivera\\, CA\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const p = parseSchedule('10/3 12:00pm Chal @ PsychoTurtle (Pico Rivera)', { today: TODAY });
  const { diff } = build(p, new Map(), parseICS(ics).events);
  assert.equal(diff.unchanged.length, 1);
});

test('folds long lines without splitting characters', () => {
  const line = `DESCRIPTION:${'Pokémon '.repeat(20)}`;
  const folded = foldLine(line);
  const parts = folded.split('\r\n');
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(new TextEncoder().encode(part).length <= 75);
  assert.equal(parts.map((x, i) => (i ? x.slice(1) : x)).join(''), line);
});

test('formats dates for display', () => {
  assert.equal(describeWhen('2026-10-03T19:00:00Z', '2026-10-03T23:00:00Z'), 'Sat, Oct 3 · 12:00 PM–4:00 PM');
  assert.equal(describeWhen('2026-10-10', '2026-10-12'), 'Sat, Oct 10 – Sun, Oct 11 · all day');
});

test('tidies ArcGIS addresses', () => {
  assert.equal(tidyAddress('9547 Telegraph Rd, Pico Rivera, California, 90660'), '9547 Telegraph Rd, Pico Rivera, CA 90660');
  assert.equal(tidyAddress('Anaheim, California'), 'Anaheim, CA');
});
