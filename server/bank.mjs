import { createCipheriv, createDecipheriv, createHash, createPrivateKey, hkdfSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { BANK_SCHEMA } from './schema.mjs';

// Account information only (AIS): this module never calls payment endpoints.
// Other members see private records as monthly totals per owner, type and category.
export function presentTransactions(rows, userId) {
  const groups = new Map(); const result = [];
  for (const { private_owner: owner, ...row } of rows) {
    if (!owner) { result.push(row); continue; }
    if (owner === userId) { result.push({ ...row, privacy: 'mine' }); continue; }
    const key = [owner, row.kind, row.category_id || '', row.date.slice(0, 7)].join(':');
    const group = groups.get(key);
    if (group) { group.amount += row.amount; group.count++; if (row.date > group.date) group.date = row.date; continue; }
    const created = { id: `private:${key}`, kind: row.kind, amount: row.amount, category_id: row.category_id, category: row.category, date: row.date, author: row.author, count: 1, recurring_id: null, bank_account: null, expected: 0, privacy: 'others' };
    groups.set(key, created); result.push(created);
  }
  for (const group of groups.values()) { group.description = `${group.kind === 'expense' ? 'Spese' : 'Entrate'} di ${group.author}`; delete group.count; }
  return result;
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const DAY = 86400000;
const MAX_CONSENT_SECONDS = 180 * 86400;
// Owners present in the app refresh every 5 minutes; without them PSD2 allows
// four unattended reads a day, so other members' accounts wait 6 hours.
const PRESENT_SYNC_MS = 5 * 60000;
const UNATTENDED_SYNC_MS = 6 * 3600000;
// Planned recurring incomes accept a credit within 10 days and 30% of their amount.
const PLANNED_DAYS = 10;
const PLANNED_TOLERANCE = 30;
export const romeToday = (time = Date.now()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date(time));
export function addDays(value, days) {
  const date = new Date(`${value}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

export class BankError extends Error {
  constructor(code, status) { super(`Enable Banking: ${code}`); this.code = code; this.status = status; }
}
const messages = {
  access: 'La banca non ha autorizzato la lettura: il consenso è scaduto o revocato. Ricollega il conto.',
  rate: 'La banca limita gli aggiornamenti: riprova più tardi.',
  request: 'La banca ha rifiutato la richiesta. Riprova o ricollega il conto.',
  unavailable: 'Servizio bancario non raggiungibile. Riprova più tardi.',
};

// Signed amounts in cents from decimal strings, never through floating point.
export function parseAmount(value) {
  const match = /^\s*([+-])?(\d{1,13})(?:\.(\d+))?\s*$/.exec(String(value ?? ''));
  if (!match) return null;
  const decimals = (match[3] || '').padEnd(3, '0');
  const cents = Number(match[2]) * 100 + Number(decimals.slice(0, 2)) + (Number(decimals[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(cents) ? (match[1] === '-' ? -cents : cents) : null;
}
const normalizeIban = value => typeof value === 'string' && /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(value.replace(/\s/g, '').toUpperCase()) ? value.replace(/\s/g, '').toUpperCase() : null;
const ibanHash = value => { const iban = normalizeIban(value); return iban ? sha256(`iban:${iban}`) : null; };
const matchKey = value => String(value || '').toLocaleLowerCase('it').replace(/[0-9]+/g, ' ').replace(/[^\p{L} ]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

const AVAILABLE = ['ITAV', 'CLAV', 'XPCD'];
const BALANCE_ORDER = [...AVAILABLE, 'ITBD', 'CLBD', 'OPBD', 'PRCD', 'INFO'];
export function pickBalance(balances) {
  const rows = (Array.isArray(balances) ? balances : []).filter(b => b?.balance_amount?.currency === 'EUR' && parseAmount(b.balance_amount.amount) !== null);
  const rank = b => { const index = BALANCE_ORDER.indexOf(b.balance_type); return index < 0 ? BALANCE_ORDER.length : index; };
  const best = rows.sort((a, b) => rank(a) - rank(b))[0];
  return best ? { amount: parseAmount(best.balance_amount.amount), kind: AVAILABLE.includes(best.balance_type) ? 'available' : 'booked' } : null;
}

// Converts provider transactions into stable, deduplicable movements. Pending
// entries are skipped: banks assign their final reference once booked.
export function normalizeTransactions(transactions) {
  const seen = new Map();
  return (Array.isArray(transactions) ? transactions : []).flatMap(t => {
    if (!t || (t.status && t.status !== 'BOOK') || t.transaction_amount?.currency !== 'EUR') return [];
    const signed = parseAmount(t.transaction_amount.amount);
    const date = validDate(t.booking_date) || validDate(t.value_date) || validDate(t.transaction_date);
    if (!signed || !date) return [];
    const kind = t.credit_debit_indicator === 'CRDT' ? 'income' : t.credit_debit_indicator === 'DBIT' ? 'expense' : signed < 0 ? 'expense' : 'income';
    const remittance = (Array.isArray(t.remittance_information) ? t.remittance_information.join(' ') : String(t.remittance_information || '')).replace(/\s+/g, ' ').trim();
    const party = (kind === 'expense' ? t.creditor?.name : t.debtor?.name)?.replace(/\s+/g, ' ').trim();
    const counterpartyIban = kind === 'expense' ? t.creditor_account?.iban : t.debtor_account?.iban;
    let externalId = typeof t.entry_reference === 'string' && t.entry_reference.trim() ? `e:${t.entry_reference.trim()}` : typeof t.transaction_id === 'string' && t.transaction_id.trim() ? `t:${t.transaction_id.trim()}` : null;
    if (!externalId) {
      const base = sha256(JSON.stringify([date, kind, Math.abs(signed), remittance, party || '']));
      const count = (seen.get(base) || 0) + 1; seen.set(base, count);
      externalId = `h:${base}:${count}`;
    }
    return [{ externalId: externalId.slice(0, 200), kind, amount: Math.abs(signed), date, description: (party || remittance || (kind === 'expense' ? 'Uscita bancaria' : 'Entrata bancaria')).slice(0, 200), matchKey: matchKey(party || remittance.slice(0, 40)), counterpartyHash: ibanHash(counterpartyIban), text: `${party || ''} ${remittance}` }];
  });
}

// Category positions follow the six family categories created at registration.
const CATEGORY_RULES = [
  [0, /\b(affitto|condominio|canone|bollett\w*|luce|gas|acqua|tari|enel|hera|a2a|iren|acea|edison|sorgenia|plenitude|italgas|engie|telecom|tim|vodafone|windtre|wind|fastweb|iliad|tiscali|sky|ikea|leroy merlin|bricoman)\b/u],
  [1, /\b(supermercat\w*|alimentari|conad|coop|ipercoop|esselunga|lidl|carrefour|eurospin|pam|despar|eurospar|interspar|penny|aldi|famila|crai|sigma|tigre|todis|naturasi|bennet|macelleria|panetteria|panificio|ortofrutta)\b/u],
  [2, /\b(carburant\w*|benzina|eni|q8|tamoil|esso|agip|shell|totalerg|autostrad\w*|telepass|trenitalia|italo|atm|atac|gtt|tper|busitalia|taxi|uber|freenow|easypark|parcheggio|ryanair|easyjet)\b/u],
  [3, /\b(farmaci\w*|parafarmacia|medic\w*|ospedal\w*|asl|ticket|dentist\w*|odontoiatr\w*|clinica|laboratorio analisi|ottica|veterinari\w*|scuola|asilo|mensa)\b/u],
  [4, /\b(netflix|spotify|disney|prime video|dazn|cinema|teatro|ristorante|pizzeria|trattoria|osteria|bar|caffe|pub|mcdonald\w*|burger king|deliveroo|just eat|glovo|steam|playstation|nintendo|palestra|booking|airbnb|hotel)\b/u],
];
export function ruleCategory(value) {
  const textValue = String(value || '').toLocaleLowerCase('it');
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(textValue))?.[0] ?? null;
}

const loopback = url => url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
// HTTPS only; plain HTTP is accepted solely on loopback for local test doubles.
export const safeProviderUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' || loopback(url); } catch { return false; } };
export function enableBankingProvider({ appId = process.env.ENABLE_BANKING_APP_ID, privateKey = process.env.ENABLE_BANKING_PRIVATE_KEY, baseUrl = process.env.ENABLE_BANKING_API_URL || 'https://api.enablebanking.com', fetcher = fetch } = {}) {
  if (!appId || !privateKey) return null;
  if (!safeProviderUrl(baseUrl)) { console.error('Configurazione Enable Banking non valida: indirizzo API non sicuro.'); return null; }
  const pem = privateKey.includes('-----BEGIN') ? privateKey.replaceAll('\\n', '\n') : Buffer.from(privateKey, 'base64').toString('utf8');
  let key;
  try { key = createPrivateKey(pem); }
  catch { console.error('Configurazione Enable Banking non valida: controlla la chiave privata.'); return null; }
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  function token() {
    const iat = Math.floor(Date.now() / 1000);
    const body = `${encode({ typ: 'JWT', alg: 'RS256', kid: appId })}.${encode({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 })}`;
    return `${body}.${sign('sha256', Buffer.from(body), key).toString('base64url')}`;
  }
  // Responses and errors can contain account data: never log their bodies.
  async function call(method, route, { body, query = {}, psu } = {}) {
    const url = new URL(route, baseUrl);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(name, value);
    const headers = { Authorization: `Bearer ${token()}`, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (psu?.ip) headers['Psu-Ip-Address'] = psu.ip;
    if (psu?.userAgent) headers['Psu-User-Agent'] = String(psu.userAgent).slice(0, 300);
    let response;
    try { response = await fetcher(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) }); }
    catch { throw new BankError('unavailable'); }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new BankError(response.status === 429 ? 'rate' : [401, 403].includes(response.status) ? 'access' : [400, 404, 422].includes(response.status) ? 'request' : 'unavailable', response.status);
    }
    return response.status === 204 ? {} : response.json();
  }
  const account = a => {
    const iban = a?.account_id?.iban || a?.all_account_ids?.find(id => id?.scheme_name === 'IBAN')?.identification || null;
    return { uid: String(a?.uid || ''), iban, name: String(a?.name || a?.product || a?.details || 'Conto').slice(0, 120), currency: String(a?.currency || 'EUR').slice(0, 3) };
  };
  return {
    secret: Buffer.from(hkdfSync('sha256', pem, 'family-hub', 'bank-session-v1', 32)),
    async banks(country) {
      const result = await call('GET', '/aspsps', { query: { country } });
      return (result.aspsps || []).filter(b => b?.name && (!Array.isArray(b.psu_types) || b.psu_types.includes('personal')))
        .map(b => ({ name: String(b.name), country: String(b.country || country), maxConsentSeconds: Number(b.maximum_consent_validity) || null }));
    },
    async startAuthorization({ bank, state, redirectUrl, validUntil, psu }) {
      const result = await call('POST', '/auth', { psu, body: { access: { valid_until: validUntil }, aspsp: { name: bank.name, country: bank.country }, state, redirect_url: redirectUrl, psu_type: 'personal' } });
      return String(result.url || '');
    },
    async createSession(code, psu) {
      const result = await call('POST', '/sessions', { psu, body: { code } });
      return { sessionId: String(result.session_id || ''), validUntil: result.access?.valid_until || null, accounts: (result.accounts || []).map(account).filter(a => a.uid) };
    },
    async balances(uid, psu) { return (await call('GET', `/accounts/${encodeURIComponent(uid)}/balances`, { psu })).balances || []; },
    async transactions(uid, dateFrom, psu) {
      const rows = []; let continuation;
      for (let page = 0; page < 30; page++) {
        const result = await call('GET', `/accounts/${encodeURIComponent(uid)}/transactions`, { psu, query: { date_from: dateFrom, continuation_key: continuation } });
        rows.push(...(result.transactions || []));
        continuation = result.continuation_key;
        if (!continuation) break;
      }
      return rows;
    },
    async endSession(sessionId) { await call('DELETE', `/sessions/${encodeURIComponent(sessionId)}`); },
  };
}

export function installBank(app, { db, one, all, run, atomic, fail, getSession }, { provider, redirectUrl, clock = Date.now }) {
  if (!db.cloud) db.exec(BANK_SCHEMA);
  const now = () => new Date(clock()).toISOString();
  const encrypt = value => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', provider.secret, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data].map(part => typeof part === 'string' ? part : part.toString('base64url')).join('.');
  };
  const decrypt = value => {
    const [version, iv, tag, data] = String(value || '').split('.');
    if (version !== 'v1') throw new Error('Formato non supportato.');
    const decipher = createDecipheriv('aes-256-gcm', provider.secret, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  };
  const monthStart = () => `${romeToday(clock()).slice(0, 7)}-01`;
  const psuOf = req => ({ ip: req.ip, userAgent: req.get('user-agent') || '' });
  const requireProvider = () => { if (!provider) fail('Il collegamento bancario non è configurato. Chiedi al gestore di impostare Enable Banking.', 503); };
  let bankCache = null;
  async function banks() {
    requireProvider();
    if (!bankCache || clock() - bankCache.at > 12 * 3600000) {
      try { bankCache = { at: clock(), list: (await provider.banks('IT')).sort((a, b) => a.name.localeCompare(b.name, 'it')) }; }
      catch (error) { if (error instanceof BankError) fail(messages[error.code], 502); throw error; }
    }
    return bankCache.list;
  }
  async function endRemote(secrets) {
    for (const secret of secrets) {
      try { await provider?.endSession(decrypt(secret)); } catch { /* expires on the provider side anyway */ }
    }
  }

  async function guessCategory(hid, movement, categories) {
    const learned = await one(`SELECT t.category_id FROM bank_movements m JOIN transactions t ON t.id = m.transaction_id
      WHERE m.household_id = ? AND m.match_key = ? AND m.kind = 'expense' AND t.category_id IS NOT NULL ORDER BY m.date DESC LIMIT 1`, hid, movement.match_key);
    if (movement.match_key && learned?.category_id) return learned.category_id;
    const position = ruleCategory(`${movement.description} ${movement.match_key}`);
    return position === null ? null : categories[position]?.id || null;
  }
  // Runs inside a transaction. Imports shared accounts only, links movements to
  // equal manual records within three days and skips transfers between shared accounts.
  async function importPending(hid) {
    const shared = new Set((await all('SELECT iban_hash FROM bank_accounts WHERE household_id = ? AND iban_hash IS NOT NULL', hid)).map(r => r.iban_hash));
    // A second linked account can reveal transfers already imported from the first.
    for (const movement of await all("SELECT id, transaction_id, counterparty_hash FROM bank_movements WHERE household_id = ? AND status = 'imported' AND counterparty_hash IS NOT NULL", hid)) {
      if (!shared.has(movement.counterparty_hash)) continue;
      await run("UPDATE bank_movements SET status = 'transfer', transaction_id = NULL WHERE id = ?", movement.id);
      if (movement.transaction_id) await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', movement.transaction_id, hid);
    }
    const rows = await all(`SELECT m.*, c.user_id, a.visibility FROM bank_movements m JOIN bank_accounts a ON a.id = m.account_id JOIN bank_connections c ON c.id = a.connection_id
      WHERE m.household_id = ? AND m.status = 'stored' AND a.import_from IS NOT NULL AND m.date >= a.import_from ORDER BY m.date, m.external_id`, hid);
    if (!rows.length) return;
    const categories = await all('SELECT id FROM categories WHERE household_id = ? ORDER BY position', hid);
    for (const movement of rows) {
      if (movement.counterparty_hash && shared.has(movement.counterparty_hash)) {
        await run("UPDATE bank_movements SET status = 'transfer' WHERE id = ?", movement.id); continue;
      }
      const distanceTo = (value, date) => Math.abs(Date.parse(value) - Date.parse(date));
      // A credited salary replaces its planned recurring income: amount and day
      // become real, the record stays in the planned month and is not duplicated.
      if (movement.kind === 'income') {
        const planned = (await all(`SELECT t.id, t.amount, t.date, r.author_id, o.id AS occurrence_id FROM recurring_occurrences o
          JOIN recurring_rules r ON r.id = o.rule_id JOIN transactions t ON t.id = o.transaction_id
          WHERE r.household_id = ? AND r.kind = 'income' AND o.overridden = 0 AND t.date >= ? AND t.date <= ?
          AND NOT EXISTS (SELECT 1 FROM bank_movements b WHERE b.transaction_id = t.id)`, hid, addDays(movement.date, -PLANNED_DAYS), addDays(movement.date, PLANNED_DAYS)))
          .filter(p => Math.abs(p.amount - movement.amount) * 100 <= p.amount * PLANNED_TOLERANCE);
        const rank = p => [p.author_id === movement.user_id ? 0 : 1, Math.abs(p.amount - movement.amount), distanceTo(p.date, movement.date)];
        const best = planned.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.id.localeCompare(b.id); })[0];
        if (best) {
          await run('UPDATE transactions SET amount = ?, date = ? WHERE id = ? AND household_id = ?', movement.amount, movement.date.slice(0, 7) === best.date.slice(0, 7) ? movement.date : best.date, best.id, hid);
          await run('UPDATE recurring_occurrences SET overridden = 1 WHERE id = ?', best.occurrence_id);
          await run("UPDATE bank_movements SET status = 'matched', transaction_id = ? WHERE id = ?", best.id, movement.id);
          continue;
        }
      }
      const candidates = await all(`SELECT t.id, t.date FROM transactions t WHERE t.household_id = ? AND t.kind = ? AND t.amount = ? AND t.date >= ? AND t.date <= ?
        AND NOT EXISTS (SELECT 1 FROM bank_movements b WHERE b.transaction_id = t.id)`, hid, movement.kind, movement.amount, addDays(movement.date, -3), addDays(movement.date, 3));
      const distance = value => Math.abs(Date.parse(value) - Date.parse(movement.date));
      const match = candidates.sort((a, b) => distance(a.date) - distance(b.date) || a.id.localeCompare(b.id))[0];
      if (match) { await run("UPDATE bank_movements SET status = 'matched', transaction_id = ? WHERE id = ?", match.id, movement.id); continue; }
      const id = randomUUID();
      const category = movement.kind === 'expense' ? await guessCategory(hid, movement, categories) : null;
      await run('INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, hid, movement.kind, movement.amount, category, movement.description, movement.date, movement.user_id, now());
      if (movement.visibility === 'balance') await run('INSERT INTO private_transactions VALUES (?, ?)', id, movement.user_id);
      await run("UPDATE bank_movements SET status = 'imported', transaction_id = ? WHERE id = ?", id, movement.id);
    }
  }

  // Provider calls happen outside the database lock; results are written atomically.
  async function syncConnection(connection, psu) {
    if (Date.parse(connection.valid_until) <= clock()) {
      await run("UPDATE bank_connections SET status = 'expired', last_error = ? WHERE id = ?", 'Il consenso della banca è scaduto. Ricollega il conto.', connection.id);
      return 'expired';
    }
    const accounts = await all('SELECT * FROM bank_accounts WHERE connection_id = ?', connection.id);
    await run('UPDATE bank_connections SET last_attempt_at = ? WHERE id = ?', now(), connection.id);
    const fetched = [];
    try {
      for (const account of accounts) {
        const last = await one('SELECT MAX(date) AS date FROM bank_movements WHERE account_id = ?', account.id);
        const from = last?.date ? addDays(last.date, -10) : addDays(romeToday(clock()), -90);
        fetched.push({ account, balance: pickBalance(await provider.balances(account.provider_uid, psu)), movements: normalizeTransactions(await provider.transactions(account.provider_uid, from, psu)) });
      }
    } catch (error) {
      const code = error instanceof BankError ? error.code : 'unavailable';
      await run('UPDATE bank_connections SET status = ?, last_error = ? WHERE id = ?', code === 'access' ? 'expired' : 'error', messages[code], connection.id);
      return code;
    }
    await atomic(async () => {
      if (!await one('SELECT id FROM bank_connections WHERE id = ?', connection.id)) return;
      for (const { account, balance, movements } of fetched) {
        if (!await one('SELECT id FROM bank_accounts WHERE id = ?', account.id)) continue;
        if (balance) await run('UPDATE bank_accounts SET balance = ?, balance_kind = ?, balance_at = ? WHERE id = ?', balance.amount, balance.kind, now(), account.id);
        for (const m of movements) {
          await run(`INSERT INTO bank_movements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', NULL, ?) ON CONFLICT(account_id, external_id) DO NOTHING`,
            randomUUID(), connection.household_id, account.id, m.externalId, m.kind, m.amount, m.date, m.description, m.matchKey, m.counterpartyHash, now());
        }
      }
      await run("UPDATE bank_connections SET status = 'active', last_sync_at = ?, last_error = NULL WHERE id = ?", now(), connection.id);
      await importPending(connection.household_id);
    });
    return null;
  }

  // The bank redirects the browser here: the single-use state must belong to the
  // signed-in user who started the authorization, otherwise nothing is stored.
  app.get('/api/bank/callback', async (req, res) => {
    const back = result => res.redirect(303, `/?banca=${result}#bank`);
    try {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      if (!provider || !/^[a-f0-9]{64}$/.test(state)) return back('errore');
      const session = await getSession(req);
      const request = await atomic(async () => {
        const row = await one('SELECT * FROM bank_auth_requests WHERE state_hash = ?', sha256(state));
        if (row) await run('DELETE FROM bank_auth_requests WHERE state_hash = ?', sha256(state));
        return row;
      });
      if (!request || request.expires <= clock() || !session || session.id !== request.user_id || session.household_id !== request.household_id) return back('errore');
      if (req.query.error || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 500) return back('annullato');
      const created = await provider.createSession(req.query.code, psuOf(req));
      if (!created.sessionId || !created.accounts.length) { await endRemote(created.sessionId ? [encrypt(created.sessionId)] : []); return back('nessun-conto'); }
      const connectionId = randomUUID();
      const validUntil = Number.isFinite(Date.parse(created.validUntil)) ? new Date(Date.parse(created.validUntil)).toISOString() : new Date(clock() + 90 * DAY).toISOString();
      const replaced = await atomic(async () => {
        await run("INSERT INTO bank_connections VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?)", connectionId, request.household_id, request.user_id, request.aspsp_name, request.aspsp_country, encrypt(created.sessionId), validUntil, now());
        for (const account of created.accounts) {
          const hashValue = ibanHash(account.iban);
          // Renewing a consent keeps the account, its visibility and its history.
          const existing = hashValue && await one(`SELECT a.id FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id
            WHERE a.household_id = ? AND c.user_id = ? AND a.iban_hash = ? AND a.connection_id <> ?`, request.household_id, request.user_id, hashValue, connectionId);
          if (existing) await run('UPDATE bank_accounts SET connection_id = ?, provider_uid = ? WHERE id = ?', connectionId, account.uid, existing.id);
          else await run('INSERT INTO bank_accounts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?) ON CONFLICT(connection_id, provider_uid) DO NOTHING',
            randomUUID(), request.household_id, connectionId, account.uid, account.name, hashValue, normalizeIban(account.iban)?.slice(-4) || null, account.currency,
            request.visibility, monthStart(), now());
        }
        const empty = await all(`SELECT id, session_secret FROM bank_connections c WHERE c.user_id = ? AND c.id <> ? AND NOT EXISTS (SELECT 1 FROM bank_accounts a WHERE a.connection_id = c.id)`, request.user_id, connectionId);
        for (const old of empty) await run('DELETE FROM bank_connections WHERE id = ?', old.id);
        return empty.map(old => old.session_secret).filter(Boolean);
      });
      await endRemote(replaced);
      const connection = await one('SELECT * FROM bank_connections WHERE id = ?', connectionId);
      const error = await syncConnection(connection, psuOf(req));
      return back(error ? 'collegato-errore' : 'collegato');
    } catch (error) {
      if (!(error instanceof BankError)) console.error('Collegamento bancario non riuscito:', error.message);
      if (!res.headersSent) back('errore');
    }
  });

  return {
    configured: !!provider,
    routes() {
      app.get('/api/bank/banks', async (req, res) => { res.json({ banks: (await banks()).map(({ name, country }) => ({ name, country })) }); });
      app.post('/api/bank/connections', async (req, res) => {
        requireProvider();
        if (!['shared', 'balance'].includes(req.body.visibility)) fail('Scegli cosa condividere con la famiglia.');
        const bank = (await banks()).find(b => b.name === req.body.bank);
        if (!bank) fail('Seleziona una banca dall’elenco.');
        const state = randomBytes(32).toString('hex');
        await atomic(async () => {
          await run('DELETE FROM bank_auth_requests WHERE expires <= ?', clock());
          if ((await one('SELECT COUNT(*) AS count FROM bank_auth_requests WHERE user_id = ?', req.user.id)).count >= 5) fail('Hai già alcuni collegamenti in corso. Completa quelli aperti o riprova tra 30 minuti.', 429);
          if ((await one('SELECT COUNT(*) AS count FROM bank_connections WHERE user_id = ?', req.user.id)).count >= 10) fail('Puoi collegare fino a 10 banche per account.');
          await run('INSERT INTO bank_auth_requests VALUES (?, ?, ?, ?, ?, ?, ?)', sha256(state), req.user.id, req.user.household_id, bank.name, bank.country, req.body.visibility, clock() + 30 * 60000);
        });
        const seconds = Math.min(bank.maxConsentSeconds || 90 * 86400, MAX_CONSENT_SECONDS) - 3600;
        let url;
        try { url = await provider.startAuthorization({ bank, state, redirectUrl, validUntil: new Date(clock() + seconds * 1000).toISOString(), psu: psuOf(req) }); }
        catch (error) { await run('DELETE FROM bank_auth_requests WHERE state_hash = ?', sha256(state)); if (error instanceof BankError) fail(messages[error.code], 502); throw error; }
        if (!safeProviderUrl(url)) fail(messages.unavailable, 502);
        res.status(201).json({ url });
      });
      async function ownConnection(id, user) {
        const connection = await one('SELECT * FROM bank_connections WHERE id = ? AND household_id = ? AND user_id = ?', id, user.household_id, user.id);
        if (!connection) fail('Collegamento non trovato.', 404);
        return connection;
      }
      app.post('/api/bank/connections/:id/sync', async (req, res) => {
        requireProvider();
        const connection = await ownConnection(req.params.id, req.user);
        if (connection.last_attempt_at && clock() - Date.parse(connection.last_attempt_at) < PRESENT_SYNC_MS) fail('Conti aggiornati da pochi minuti. Riprova più tardi.', 429);
        const error = await syncConnection(connection, psuOf(req));
        if (error) fail(error === 'expired' ? 'Il consenso della banca è scaduto. Ricollega il conto.' : messages[error], 502);
        res.json({ ok: true });
      });
      // Called by open apps every 5 minutes: the owner's accounts refresh with the
      // owner present; other members' accounts only within the unattended limit.
      app.post('/api/bank/refresh', async (req, res) => {
        if (!provider) return res.json({ synced: 0 });
        let synced = 0;
        for (const connection of await all("SELECT * FROM bank_connections WHERE household_id = ? AND status IN ('active', 'error')", req.user.household_id)) {
          const mine = connection.user_id === req.user.id;
          if (connection.last_attempt_at && clock() - Date.parse(connection.last_attempt_at) < (mine ? PRESENT_SYNC_MS : UNATTENDED_SYNC_MS)) continue;
          if (!await syncConnection(connection, mine ? psuOf(req) : null)) synced++;
        }
        res.json({ synced });
      });
      app.delete('/api/bank/connections/:id', async (req, res) => {
        const connection = await ownConnection(req.params.id, req.user);
        // Imported records stay in Entrate/Uscite; bank copies and balances are removed.
        await atomic(async () => { await run('DELETE FROM bank_connections WHERE id = ? AND user_id = ?', connection.id, req.user.id); });
        await endRemote(connection.session_secret ? [connection.session_secret] : []);
        res.json({ ok: true });
      });
      app.patch('/api/bank/accounts/:id', async (req, res) => {
        if (!['shared', 'balance'].includes(req.body.visibility)) fail('Visibilità non valida.');
        await atomic(async () => {
          const account = await one('SELECT a.* FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id WHERE a.id = ? AND a.household_id = ? AND c.user_id = ?', req.params.id, req.user.household_id, req.user.id);
          if (!account) fail('Conto non trovato.', 404);
          if (account.visibility === req.body.visibility) return;
          await run('UPDATE bank_accounts SET visibility = ?, import_from = ? WHERE id = ?', req.body.visibility, account.import_from || monthStart(), account.id);
          // Records already imported from this account follow the new choice.
          const imported = await all("SELECT transaction_id FROM bank_movements WHERE account_id = ? AND status = 'imported' AND transaction_id IS NOT NULL", account.id);
          for (const { transaction_id: id } of imported) {
            if (req.body.visibility === 'balance') await run('INSERT INTO private_transactions VALUES (?, ?) ON CONFLICT(transaction_id) DO NOTHING', id, req.user.id);
            else await run('DELETE FROM private_transactions WHERE transaction_id = ?', id);
          }
          await importPending(req.user.household_id);
        });
        res.json({ ok: true });
      });
    },
    async state(user, month) {
      const accounts = await all(`SELECT a.id, a.name, a.iban_last4, a.currency, a.visibility, a.balance, a.balance_kind, a.balance_at, a.import_from,
        c.id AS connection_id, c.aspsp_name AS bank, c.status, c.valid_until, c.last_sync_at, c.last_error, c.user_id, u.name AS owner
        FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id JOIN users u ON u.id = c.user_id
        WHERE a.household_id = ? ORDER BY u.name, c.aspsp_name, a.name`, user.household_id);
      const movements = await all(`SELECT m.id, m.account_id, m.kind, m.amount, m.date, m.description, m.status, m.transaction_id FROM bank_movements m
        JOIN bank_accounts a ON a.id = m.account_id JOIN bank_connections c ON c.id = a.connection_id
        WHERE m.household_id = ? AND substr(m.date, 1, 7) = ? AND (a.visibility = 'shared' OR c.user_id = ?) ORDER BY m.date DESC, m.external_id LIMIT 300`, user.household_id, month, user.id);
      return {
        configured: !!provider,
        total: accounts.filter(a => a.currency === 'EUR' && a.balance !== null).reduce((sum, a) => sum + Number(a.balance), 0),
        accounts: accounts.map(({ user_id, last_error, ...a }) => ({ ...a, balance: a.balance === null ? null : Number(a.balance), mine: user_id === user.id, last_error: user_id === user.id ? last_error : null })),
        movements: movements.map(m => ({ ...m, amount: Number(m.amount) })),
      };
    },
    // Unattended runs stay within four reads a day per connection (PSD2).
    async synchronizeAll({ minAgeMs = UNATTENDED_SYNC_MS } = {}) {
      if (!provider) return;
      await run('DELETE FROM bank_auth_requests WHERE expires <= ?', clock());
      for (const connection of await all("SELECT * FROM bank_connections WHERE status IN ('active', 'error')")) {
        if (connection.last_attempt_at && clock() - Date.parse(connection.last_attempt_at) < minAgeMs) continue;
        try { await syncConnection(connection, null); }
        catch (error) { console.error('Aggiornamento bancario non riuscito:', error.message); }
      }
    },
  };
}
