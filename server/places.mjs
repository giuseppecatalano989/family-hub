import { safeProviderUrl } from './bank.mjs';

// Place suggestions for the calendar's location field. The browser asks the
// backend, which queries Google Places when GOOGLE_PLACES_API_KEY is set, or
// Photon (OpenStreetMap data) otherwise. Only the typed text and, if the member
// allows it, the device's position rounded to about 100 m leave the server:
// never names, accounts or the family. Nothing is stored or logged.

export const PLACES_PER_MINUTE = 60;
const LIMIT = 5; const MAX_LABEL = 120;
const CACHE_MS = 10 * 60000; const CACHE_SIZE = 500;
// Without a position, results lean towards Italy at country scale without excluding places abroad.
const ITALY = { lat: '42.5', lon: '12.5', zoom: '6', location_bias_scale: '0.3' };
const NEAR_RADIUS = 50000;

const clip = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
// Joins parts with commas while they fit the 120 characters of the location.
function fit(parts) {
  let text = '';
  for (const part of parts) { const next = text ? `${text}, ${part}` : part; if (next.length <= MAX_LABEL) text = next; }
  return text;
}
// Metres between two points.
export function distance(a, b) {
  const rad = Math.PI / 180; const dLat = (b.lat - a.lat) * rad; const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(12742000 * Math.asin(Math.sqrt(h)));
}
// The position the browser sent, rounded to about 100 m; anything else is ignored.
export function position(lat, lon) {
  const read = (value, max) => { const n = typeof value === 'string' && /^-?\d{1,3}(\.\d+)?$/.test(value) ? Number(value) : NaN; return Math.abs(n) <= max ? Math.round(n * 1000) / 1000 : null; };
  const near = { lat: read(lat, 90), lon: read(lon, 180) };
  return near.lat === null || near.lon === null ? null : near;
}

// A Photon result: a short label to save, and the area that tells similar places apart.
export function presentPlace(properties = {}) {
  const p = Object.fromEntries(['name', 'street', 'housenumber', 'city', 'district', 'county', 'state', 'country'].map(key => [key, clip(properties[key])]));
  const address = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : '';
  const parts = [...new Set([p.name, address, p.city].filter(Boolean))];
  const detail = [p.district, p.city, p.county, p.state, p.country].filter((part, i, all) => part && !parts.includes(part) && all.indexOf(part) === i);
  const label = fit(parts);
  return label ? { label, name: label, detail: detail.join(', ').slice(0, 160) } : null;
}
// A Google prediction: the name in bold, the address below, the whole text saved
// (without the country for places in Italy).
export function presentPrediction(prediction = {}) {
  const name = clip(prediction.structuredFormat?.mainText?.text) || clip(prediction.text?.text);
  const detail = clip(prediction.structuredFormat?.secondaryText?.text);
  const label = fit(clip(prediction.text?.text || [name, detail].filter(Boolean).join(', ')).replace(/, Italia$/, '').split(', ').filter(Boolean));
  if (!label || !name) return null;
  return { label, name: name.slice(0, MAX_LABEL), detail: detail.replace(/, Italia$/, '').slice(0, 160), ...(Number.isFinite(prediction.distanceMeters) ? { distance: prediction.distanceMeters } : {}) };
}

const AGENT = 'FamilyHub/0.1 (calendario di famiglia)';
export function photonPlaces({ baseUrl = process.env.PLACES_API_URL || 'https://photon.komoot.io', fetcher = fetch } = {}) {
  if (baseUrl === 'off') return null;
  if (!safeProviderUrl(baseUrl)) { console.error('Configurazione dei luoghi non valida: indirizzo non sicuro.'); return null; }
  return {
    source: 'osm',
    async search(query, near) {
      const ask = params => {
        const url = new URL(`${baseUrl.replace(/\/$/, '')}/api`);
        url.search = new URLSearchParams({ q: query, limit: String(LIMIT + 3), ...params }).toString();
        return fetcher(url, { headers: { accept: 'application/json', 'user-agent': AGENT }, signal: AbortSignal.timeout(5000) });
      };
      // An instance that does not accept the bias still answers the plain search.
      let response = await ask(near ? { lat: String(near.lat), lon: String(near.lon), zoom: '12', location_bias_scale: '0.1' } : ITALY);
      if (response.status === 400) response = await ask({});
      if (!response.ok) throw Object.assign(new Error('Ricerca dei luoghi non riuscita.'), { status: response.status });
      const body = await response.json();
      return (Array.isArray(body?.features) ? body.features : []).flatMap(feature => {
        const place = presentPlace(feature?.properties);
        const [lon, lat] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
        if (!place) return [];
        return [near && Number.isFinite(lat) && Number.isFinite(lon) ? { ...place, distance: distance(near, { lat, lon }) } : place];
      });
    },
  };
}

// Google Places Autocomplete (New): shops and businesses as on Google Maps. The
// key stays on the backend, without the VITE_ prefix.
export function googlePlaces({ apiKey = process.env.GOOGLE_PLACES_API_KEY, fetcher = fetch } = {}) {
  if (!apiKey) return null;
  return {
    source: 'google',
    async search(query, near) {
      const center = near && { latitude: near.lat, longitude: near.lon };
      const response = await fetcher('https://places.googleapis.com/v1/places:autocomplete', {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ input: query, languageCode: 'it', regionCode: 'it', includeQueryPredictions: false, ...(center ? { locationBias: { circle: { center, radius: NEAR_RADIUS } }, origin: center } : {}) }),
      });
      if (!response.ok) throw Object.assign(new Error('Ricerca dei luoghi non riuscita.'), { status: response.status });
      const body = await response.json();
      return (Array.isArray(body?.suggestions) ? body.suggestions : []).map(s => presentPrediction(s?.placePrediction)).filter(Boolean);
    },
  };
}

export function installPlaces(app, { fail }, { provider, clock = Date.now } = {}) {
  const cache = new Map(); const usage = new Map();
  function allow(hid) {
    const minute = Math.floor(clock() / 60000); const used = usage.get(hid);
    const count = used?.minute === minute ? used.count : 0;
    if (count >= PLACES_PER_MINUTE) return false;
    if (usage.size > 1000) usage.clear();
    usage.set(hid, { minute, count: count + 1 });
    return true;
  }
  // The outside service may be slow: the request leaves the shared queue first.
  app.get('/api/places', (req, res, next) => { req.leaveQueue?.(); next(); }, async (req, res) => {
    if (!provider) fail('I suggerimenti dei luoghi non sono disponibili.', 503);
    const query = clip(req.query.q).toLocaleLowerCase('it');
    const near = position(req.query.lat, req.query.lon);
    if (!query || query.length > MAX_LABEL) return res.json({ places: [], source: provider.source });
    const key = near ? `${query}|${near.lat},${near.lon}` : query;
    const cached = cache.get(key);
    if (cached && cached.expires > clock()) return res.json({ places: cached.places, source: provider.source });
    if (!allow(req.user.household_id)) fail('Troppe ricerche di luoghi. Riprova tra un minuto.', 429);
    let found;
    try { found = await provider.search(query, near); }
    catch (error) {
      console.error('Ricerca dei luoghi non riuscita:', error.status || error.name);
      fail('Suggerimenti dei luoghi non disponibili. Puoi scrivere il luogo a mano.', 502);
    }
    const unique = [];
    for (const place of found) if (place && !unique.some(p => p.label === place.label)) unique.push(place);
    // The nearest first, among the places that match; those without a distance keep their order after them.
    const places = unique.slice(0, LIMIT + 3).map((place, i) => ({ place, i }))
      .sort((a, b) => (a.place.distance ?? Infinity) - (b.place.distance ?? Infinity) || a.i - b.i)
      .slice(0, LIMIT).map(({ place }) => place);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(key, { places, expires: clock() + CACHE_MS });
    res.json({ places, source: provider.source });
  });
}
