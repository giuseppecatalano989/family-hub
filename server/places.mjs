import { safeProviderUrl } from './bank.mjs';

// Only the typed location reaches Google, through the backend. Never log queries,
// API keys or provider responses, and do not cache autocomplete predictions.
export const PLACES_PER_MINUTE = 30;
const LIMIT = 5; const MAX_LABEL = 120;
const clip = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

export function presentPlace(prediction = {}) {
  const label = clip(prediction?.text?.text);
  const detail = clip(prediction?.structuredFormat?.secondaryText?.text);
  return label ? { label: label.slice(0, MAX_LABEL), detail: detail.slice(0, 160) } : null;
}

export function googlePlaces({ apiKey = process.env.GOOGLE_PLACES_API_KEY, baseUrl = process.env.PLACES_API_URL || 'https://places.googleapis.com', fetcher = fetch } = {}) {
  if (baseUrl === 'off' || !apiKey) return null;
  // HTTP is permitted only on loopback, for the local test double.
  if (!safeProviderUrl(baseUrl)) { console.error('Configurazione dei luoghi non valida: indirizzo non sicuro.'); return null; }
  const origin = new URL(baseUrl);
  if (origin.origin !== 'https://places.googleapis.com' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
    console.error('Configurazione dei luoghi non valida: destinazione non consentita.'); return null;
  }
  return {
    async search(query) {
      const response = await fetcher(new URL('/v1/places:autocomplete', origin), {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat' },
        body: JSON.stringify({ input: query, languageCode: 'it', regionCode: 'it', includeQueryPredictions: false }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw Object.assign(new Error('Ricerca dei luoghi non riuscita.'), { status: response.status });
      const body = await response.json();
      return (Array.isArray(body?.suggestions) ? body.suggestions : []).map(item => item?.placePrediction);
    },
  };
}

export function installPlaces(app, { fail }, { provider, clock = Date.now } = {}) {
  const usage = new Map();
  function allow(hid) {
    const minute = Math.floor(clock() / 60000); const used = usage.get(hid);
    const count = used?.minute === minute ? used.count : 0;
    if (count >= PLACES_PER_MINUTE) return false;
    if (usage.size > 1000) usage.clear();
    usage.set(hid, { minute, count: count + 1 });
    return true;
  }
  app.get('/api/places', (req, res, next) => { req.leaveQueue?.(); next(); }, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const query = clip(req.query.q);
    if (!query.length || query.length > MAX_LABEL) return res.json({ places: [] });
    if (!provider) fail('I suggerimenti dei luoghi non sono disponibili.', 503);
    if (!allow(req.user.household_id)) fail('Troppe ricerche di luoghi. Riprova tra un minuto.', 429);
    let found;
    try { found = await provider.search(query); }
    catch (error) {
      console.error('Ricerca dei luoghi non riuscita:', error.status || error.name);
      fail('Suggerimenti dei luoghi non disponibili. Puoi scrivere il luogo a mano.', 502);
    }
    const places = [];
    for (const place of found.map(presentPlace)) if (place && !places.some(p => p.label === place.label) && places.length < LIMIT) places.push(place);
    res.json({ places });
  });
}
