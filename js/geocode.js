// Store lookups via Esri's public ArcGIS World Geocoder (no key needed). It knows
// most game stores by name; OpenStreetMap-based geocoders mostly don't.

import { slug } from './core.js';

const ENDPOINT = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates';
const PRECISE = new Set(['POI', 'PointAddress', 'StreetAddress', 'Subaddress', 'StreetInt', 'StreetAddressExt', 'DistanceMarker']);
const SOCAL = { lat: 34.0, lon: -117.9 };

const compact = s => slug(s).replace(/-/g, '');

// "9547 Telegraph Rd, Pico Rivera, California, 90660" → "9547 Telegraph Rd, Pico Rivera, CA 90660"
const STATES = { California: 'CA', Nevada: 'NV', Arizona: 'AZ', Oregon: 'OR' };
export function tidyAddress(addr) {
  return String(addr || '').replace(/, ([A-Z][a-z]+(?: [A-Z][a-z]+)?), (\d{5})$/, (all, st, zip) => (STATES[st] ? `, ${STATES[st]} ${zip}` : all))
    .replace(/, ([A-Z][a-z]+(?: [A-Z][a-z]+)?)$/, (all, st) => (STATES[st] ? `, ${STATES[st]}` : all));
}

export async function searchPlaces(query, near = SOCAL) {
  const params = new URLSearchParams({
    SingleLine: query, f: 'json', maxLocations: '6', countryCode: 'USA',
    outFields: 'PlaceName,Place_addr,Type,Addr_type,City',
    location: `${near.lon},${near.lat}`,
  });
  const res = await fetch(`${ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`Lookup failed (${res.status})`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Lookup failed');
  const seen = new Set();
  return (data.candidates || []).map(c => {
    const a = c.attributes || {};
    const precise = PRECISE.has(a.Addr_type);
    return {
      name: a.PlaceName || '',
      address: tidyAddress(a.Place_addr || c.address),
      lat: c.location.y, lon: c.location.x,
      score: c.score, kind: a.Type || a.Addr_type || '', precise,
      city: a.City || '',
    };
  }).filter(c => {
    const id = `${c.name}|${c.address}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function nameMatches(candidate, venueName) {
  const a = compact(candidate), b = compact(venueName);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const words = slug(venueName).split('-').filter(w => w.length > 2 && !['the', 'and', 'games', 'game', 'shop', 'cafe'].includes(w));
  return words.length > 0 && words.filter(w => a.includes(w)).length / words.length >= 0.5;
}

const distanceKm = (a, b) => {
  const rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// Best guess for a store, plus every candidate so the page can offer alternatives.
// A store match only counts if it's in (or right next to) the city the schedule named.
export async function findVenue({ name, city, region }) {
  const query = [name, city, region].filter(Boolean).join(', ');
  const candidates = await searchPlaces(query);
  const center = candidates.find(c => !c.precise && cityMatches(`${c.name} ${c.address}`, city));
  const inCity = c => cityMatches(`${c.address} ${c.city}`, city) || (center && distanceKm(c, center) < 20);
  for (const c of candidates) c.nameMatch = c.precise && nameMatches(c.name, name);

  const precise = candidates.filter(c => c.precise);
  const exact = precise.find(c => c.nameMatch && inCity(c));
  if (exact) return { query, candidates, best: exact, status: 'found', message: '' };

  const elsewhere = precise.find(c => c.nameMatch);
  const nearby = precise.find(inCity);
  if (nearby && !center) {
    return { query, candidates, best: nearby, status: 'found', message: 'The closest match has a different name — make sure it’s the right store.' };
  }
  const area = center || candidates.find(c => !c.precise) || null;
  const message = elsewhere
    ? `There’s a “${elsewhere.name}” in ${elsewhere.city || 'another city'} — pick it from the list if that’s the one.`
    : '';
  if (area) return { query, candidates, best: area, status: 'approx', message };
  if (elsewhere) return { query, candidates, best: null, status: 'notfound', message };
  return { query, candidates, best: null, status: 'notfound', message: '' };
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// True when the address looks like it's in the city the schedule named
// (tolerating small typos such as "Murietta" for Murrieta).
export function cityMatches(address, city) {
  if (!city || !address) return true;
  const want = compact(city);
  if (compact(address).includes(want)) return true;
  if (want.length < 5) return false;
  return String(address).split(',').some(part => {
    const words = slug(part).split('-').filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j <= Math.min(words.length, i + 3); j++) {
        if (levenshtein(words.slice(i, j).join(''), want) <= 2) return true;
      }
    }
    return false;
  });
}
