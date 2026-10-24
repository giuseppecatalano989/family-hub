import { safeProviderUrl } from './bank.mjs';

// Place suggestions for the calendar's location field. The browser asks the
// backend, which queries Photon (OpenStreetMap data): only the typed text leaves
// the server, never names, accounts or the family. Nothing is stored or logged.

export const PLACES_PER_MINUTE = 30;
const LIMIT = 5; const MAX_LABEL = 120;
const CACHE_MS = 10 * 60000; const CACHE_SIZE = 300;
// Results lean towards Italy at country scale without excluding places abroad.
const BIAS = { lat: '42.5', lon: '12.5', zoom: '6', location_bias_scale: '0.3' };

const clip = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
// A short label to save as the location, and the area to tell similar places apart.
export function presentPlace(properties = {}) {
  const p = Object.fromEntries(['name', 'street', 'housenumber', 'city', 'district', 'county', 'state', 'country'].map(key => [key, clip(properties[key])]));
  const address = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : '';
  const label = [...new Set([p.name, address, p.city].filter(Boolean))];
  const detail = [p.district, p.city, p.county, p.state, p.country].filter((part, i, all) => part && !label.includes(part) && all.indexOf(part) === i);
  let text = '';
  for (const part of label) { const next = text ? `${text}, ${part}` : part; if (next.length <= MAX_LABEL) text = next; }
  return text ? { label: text, detail: detail.join(', ').slice(0, 160) } : null;
}

export function photonPlaces({ baseUrl = process.env.PLACES_API_URL || 'https://photon.komoot.io', fetcher = fetch } = {}) {
  if (baseUrl === 'off') return null;
  if (!safeProviderUrl(baseUrl)) { console.error('Configurazione dei luoghi non valida: indirizzo non sicuro.'); return null; }
  return {
    async search(query) {
      const url = new URL(`${baseUrl.replace(/\/$/, '')}/api`);
      url.search = new URLSearchParams({ q: query, limit: String(LIMIT + 3), ...BIAS }).toString();
      const response = await fetcher(url, { headers: { accept: 'application/json', 'user-agent': 'FamilyHub/0.1 (calendario di famiglia)' }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Object.assign(new Error('Ricerca dei luoghi non riuscita.'), { status: response.status });
      const body = await response.json();
      return (Array.isArray(body?.features) ? body.features : []).map(feature => feature?.properties);
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
    if (query.length < 3 || query.length > MAX_LABEL) return res.json({ places: [] });
    const cached = cache.get(query);
    if (cached && cached.expires > clock()) return res.json({ places: cached.places });
    if (!allow(req.user.household_id)) fail('Troppe ricerche di luoghi. Riprova tra un minuto.', 429);
    let found;
    try { found = await provider.search(query); }
    catch (error) {
      console.error('Ricerca dei luoghi non riuscita:', error.status || error.name);
      fail('Suggerimenti dei luoghi non disponibili. Puoi scrivere il luogo a mano.', 502);
    }
    const places = [];
    for (const place of found.map(presentPlace)) if (place && !places.some(p => p.label === place.label) && places.length < LIMIT) places.push(place);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(query, { places, expires: clock() + CACHE_MS });
    res.json({ places });
  });
}
