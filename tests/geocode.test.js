import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findVenue, cityMatches } from '../js/geocode.js';

// Minimal stand-in for the ArcGIS response.
const cand = (PlaceName, Place_addr, Addr_type, x, y, City = '') =>
  ({ address: PlaceName || Place_addr, location: { x, y }, score: 90, attributes: { PlaceName, Place_addr, Addr_type, City, Type: '' } });
const withResults = candidates => { globalThis.fetch = async () => ({ ok: true, json: async () => ({ candidates }) }); };

test('tolerates small typos in the city name', () => {
  assert.ok(cityMatches('24620 Jefferson Ave, Ste A, Murrieta, CA 92562', 'Murietta'));
  assert.ok(cityMatches('11304 Santa Monica Blvd, Los Angeles, CA 90025', 'Santa Monica'));
  assert.ok(!cityMatches('5037 Shawline St, San Diego, CA 92111', 'Pasadena'));
});

test('an exact store match in the right city is found', async () => {
  withResults([
    cand('Psycho Turtle Collectibles', '9547 Telegraph Rd, Pico Rivera, California, 90660', 'POI', -118.0994, 33.9545, 'Pico Rivera'),
    cand('Pico Rivera', 'Pico Rivera, California', 'Locality', -118.0794, 33.9995, 'Pico Rivera'),
  ]);
  const r = await findVenue({ name: 'PsychoTurtle', city: 'Pico Rivera', region: 'CA' });
  assert.equal(r.status, 'found');
  assert.equal(r.best.address, '9547 Telegraph Rd, Pico Rivera, CA 90660');
  assert.equal(r.message, '');
});

test('a same-name store in another city is offered, not picked', async () => {
  withResults([
    cand('Pasadena', 'Pasadena, California', 'Locality', -118.14, 34.15, 'Pasadena'),
    cand('Game Empire', '5037 Shawline St, San Diego, California, 92111', 'POI', -117.18, 32.83, 'San Diego'),
  ]);
  const r = await findVenue({ name: 'Game Empire', city: 'Pasadena', region: 'CA' });
  assert.equal(r.status, 'approx');
  assert.equal(r.best.name, 'Pasadena');
  assert.match(r.message, /San Diego/);
});

test('only a city match means city-level location', async () => {
  withResults([cand('Anaheim', 'Anaheim, California', 'Locality', -117.9, 33.84, 'Anaheim')]);
  const r = await findVenue({ name: 'Requiem Cafe', city: 'Anaheim', region: 'CA' });
  assert.equal(r.status, 'approx');
});

test('nothing at all means not found', async () => {
  withResults([]);
  const r = await findVenue({ name: 'Nowhere Games', city: 'Atlantis', region: 'CA' });
  assert.equal(r.status, 'notfound');
});
