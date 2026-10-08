import { createCipheriv, createDecipheriv, createHash, createPrivateKey, hkdfSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { BANK_SCHEMA } from './schema.mjs';

// Account information only (AIS): this module never calls payment endpoints.

// Splits `amount` cents among goals with a monthly plan. Needs (what is still
// missing from each monthly quota) are covered first; when the deposit is short,
// "primary" fills the primary goal before the others, otherwise needs are shared in
// proportion to the monthly quotas. Any excess follows the same rule up to each
// goal's remaining target. Integer cents with largest remainders, never above `room`.
export function splitSavings(amount, goals, strategy) {
  const given = new Map(goals.map(g => [g.id, 0]));
  const add = (goal, value) => given.set(goal.id, given.get(goal.id) + value);
  const needLeft = g => Math.max(0, Math.min(g.need, g.room) - given.get(g.id));
  const roomLeft = g => Math.max(0, g.room - given.get(g.id));
  const spread = (value, list, cap) => {
    let remaining = value;
    for (let active = list.filter(g => cap(g) > 0); remaining > 0 && active.length; active = active.filter(g => cap(g) > 0)) {
      const total = active.reduce((sum, g) => sum + BigInt(g.monthly), 0n);
      const parts = active.map((g, index) => { const share = BigInt(remaining) * BigInt(g.monthly); return { g, index, base: Number(share / total), rest: share % total }; });
      let extra = remaining - parts.reduce((sum, part) => sum + part.base, 0);
      for (const part of [...parts].sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index))) { if (extra <= 0) break; part.base++; extra--; }
      let used = 0;
      for (const part of parts) { const value = Math.min(part.base, cap(part.g)); add(part.g, value); used += value; }
      remaining -= used;
      if (!used) break;
    }
    return remaining;
  };
  const primary = strategy === 'primary' ? goals.find(g => g.primary) : null;
  const others = goals.filter(g => g !== primary);
  let left = amount;
  for (const cap of [needLeft, roomLeft]) {
    if (primary) { const value = Math.min(left, cap(primary)); add(primary, value); left -= value; left = spread(left, others, cap); }
    else left = spread(left, goals, cap);
  }
  return goals.map(g => ({ id: g.id, amount: given.get(g.id) })).filter(part => part.amount > 0);
}
// Other members see private records as monthly totals per owner, type and category.
export function presentTransactions(rows, userId) {
  const groups = new Map(); const result = [];
  for (const { private_owner: owner, ...row } of rows) {
    if (!owner) { result.push(row); continue; }
    if (owner === userId) { result.push({ ...row, privacy: 'mine' }); continue; }
    const key = [owner, row.kind, row.category_id || '', row.date.slice(0, 7)].join(':');
    const group = groups.get(key);
    if (group) { group.amount += row.amount; group.count++; if (row.date > group.date) group.date = row.date; continue; }
    const created = { id: `private:${key}`, kind: row.kind, amount: row.amount, category_id: row.category_id, category: row.category, date: row.date, author: row.author, count: 1, recurring_id: null, bank_account: null, privacy: 'others' };
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
// Planned recurring incomes accept a salary credit within 10 days; unless its payer
// is already known, also within 30% of the planned amount.
const PLANNED_DAYS = 10;
// Position of Risparmio among the six family categories.
const SAVINGS_POSITION = 5;
// History requested from the bank on the first read of an account.
const FETCHED_DAYS = 90;
const PLANNED_TOLERANCE = 30;
// Savings and investment destinations; generic words such as "risparmio" are
// excluded because they also appear in bank names (Cassa di Risparmio).
export const BANK_COUNTRIES = ['IT', 'DE', 'ES', 'FR', 'NL', 'BE', 'AT', 'PT', 'IE', 'LU', 'FI', 'LT'];
const SAVINGS = /\b(trade republic|scalable capital|moneyfarm|directa sim|degiro|raisin|conto arancio|rendimax|illimity|conto deposito|conto risparmio|fondo pensione|previdenza complementare|piano di accumulo|pac|bitpanda|xtb|freedom24|salvadanaio)\b/u;
const SALARY = /\b(stipend\w*|emolument\w*|retribuzion\w*|salari\w*|cedolin\w*|busta paga|mensilit\w*|pension\w*|payroll|salary|wages)\b/u;
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
// Only accounts with an IBAN are linked: cards (no IBAN or type CARD) and loans are skipped.
export const eligibleAccount = account => !!normalizeIban(account?.iban) && !['CARD', 'LOAN'].includes(account?.type);
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
    const salaryHint = kind === 'income' && (t.purpose_code === 'SALA' || SALARY.test(`${party || ''} ${remittance}`.toLocaleLowerCase('it'))) ? 1 : 0;
    const savingsHint = kind === 'expense' && SAVINGS.test(`${party || ''} ${remittance}`.toLocaleLowerCase('it')) ? 1 : 0;
    return [{ externalId: externalId.slice(0, 200), salaryHint, savingsHint, kind, amount: Math.abs(signed), date, description: (party || remittance || (kind === 'expense' ? 'Uscita bancaria' : 'Entrata bancaria')).slice(0, 200), matchKey: matchKey(party || remittance.slice(0, 40)), counterpartyHash: ibanHash(counterpartyIban), text: `${party || ''} ${remittance}` }];
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
    return { uid: String(a?.uid || ''), iban, name: String(a?.name || a?.product || a?.details || 'Conto').slice(0, 120), currency: String(a?.currency || 'EUR').slice(0, 3), type: String(a?.cash_account_type || '') };
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
  // A new link also imports the movements fetched before it (90 days), from the
  // first whole month they cover, so past months can be compared.
  const importStart = createdAt => {
    const first = addDays(romeToday(Date.parse(createdAt)), -FETCHED_DAYS);
    if (first.endsWith('-01')) return first;
    const [year, month] = first.split('-').map(Number);
    return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  };
  const psuOf = req => ({ ip: req.ip, userAgent: req.get('user-agent') || '' });
  const requireProvider = () => { if (!provider) fail('Il collegamento bancario non è configurato. Chiedi al gestore di impostare Enable Banking.', 503); };
  // Banks are listed per country: some, like Trade Republic, are offered only
  // under the country where the provider registered them.
  const bankCache = new Map();
  async function banks(country = 'IT') {
    requireProvider();
    if (!BANK_COUNTRIES.includes(country)) fail('Paese della banca non valido.');
    const cached = bankCache.get(country);
    if (cached && clock() - cached.at < 12 * 3600000) return cached.list;
    try {
      const list = (await provider.banks(country)).sort((a, b) => a.name.localeCompare(b.name, 'it'));
      bankCache.set(country, { at: clock(), list });
      return list;
    } catch (error) { if (error instanceof BankError) fail(messages[error.code], 502); throw error; }
  }
  async function endRemote(secrets) {
    for (const secret of secrets) {
      try { await provider?.endSession(decrypt(secret)); } catch { /* expires on the provider side anyway */ }
    }
  }

  async function guessCategory(hid, movement, categories) {
    const learned = movement.counterparty_hash && await one(`SELECT t.category_id FROM bank_movements m JOIN transactions t ON t.id = m.transaction_id
      WHERE m.household_id = ? AND m.counterparty_hash = ? AND m.kind = 'expense' AND t.category_id IS NOT NULL ORDER BY m.date DESC LIMIT 1`, hid, movement.counterparty_hash)
      || movement.match_key && await one(`SELECT t.category_id FROM bank_movements m JOIN transactions t ON t.id = m.transaction_id
      WHERE m.household_id = ? AND m.match_key = ? AND m.kind = 'expense' AND t.category_id IS NOT NULL ORDER BY m.date DESC LIMIT 1`, hid, movement.match_key);
    if (learned?.category_id) return learned.category_id;
    const position = ruleCategory(`${movement.description} ${movement.match_key}`);
    return position === null ? null : categories[position]?.id || null;
  }
  // Savings transfers are linked to a goal contribution: removing or changing the
  // expense keeps goals.saved and its history consistent in the same transaction.
  async function releaseSavings(transactionId) {
    const links = await all(`SELECT c.id, c.goal_id, c.amount FROM contributions c WHERE c.id IN (SELECT contribution_id FROM savings_allocations WHERE transaction_id = ?)
      OR c.id IN (SELECT contribution_id FROM savings_contributions WHERE transaction_id = ?)`, transactionId, transactionId);
    for (const link of links) {
      await run('DELETE FROM contributions WHERE id = ?', link.id);
      await run('UPDATE goals SET saved = CASE WHEN saved > ? THEN saved - ? ELSE 0 END WHERE id = ?', link.amount, link.amount, link.goal_id);
    }
  }
  // Removes a linked account with its bank copies and, when asked, the records it
  // imported (removed accounts and cards); records only matched to it stay.
  async function dropAccount(accountId, hid, dropImported) {
    if (dropImported) for (const { transaction_id: id } of await all("SELECT transaction_id FROM bank_movements WHERE account_id = ? AND status = 'imported' AND transaction_id IS NOT NULL", accountId)) {
      await releaseSavings(id);
      await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', id, hid);
    }
    await run('DELETE FROM savings_destinations WHERE household_id = ? AND destination_key = ?', hid, `account:${accountId}`);
    await run('DELETE FROM bank_accounts WHERE id = ? AND household_id = ?', accountId, hid);
  }
  // Cards linked before the IBAN rule are removed with what they imported.
  async function purgeCards(hid) {
    for (const { id } of await all('SELECT id FROM bank_accounts WHERE household_id = ? AND iban_hash IS NULL', hid)) await dropAccount(id, hid, true);
  }
  // Goals with a monthly plan and room left, each with what is still missing from
  // this month's quota after the deposits and balance shares of `month`.
  async function plannedGoals(hid, month) {
    const goals = await all(`SELECT g.id, g.target, g.saved, p.monthly, p.is_primary FROM goals g JOIN goal_plans p ON p.goal_id = g.id
      WHERE g.household_id = ? AND p.monthly > 0 AND g.saved < g.target ORDER BY g.created_at, g.id`, hid);
    if (!goals.length) return [];
    const given = new Map((await all(`SELECT c.goal_id, SUM(c.amount) AS total FROM contributions c JOIN goals g ON g.id = c.goal_id WHERE g.household_id = ?
      AND (c.id IN (SELECT s.contribution_id FROM savings_allocations s JOIN transactions t ON t.id = s.transaction_id WHERE substr(t.date, 1, 7) = ?)
      OR c.id IN (SELECT b.contribution_id FROM savings_balance_allocations b WHERE b.month = ?)) GROUP BY c.goal_id`, hid, month, month)).map(r => [r.goal_id, Number(r.total)]));
    return goals.map(g => ({ id: g.id, monthly: Number(g.monthly), primary: !!g.is_primary, room: Number(g.target) - Number(g.saved), need: Math.max(0, Number(g.monthly) - (given.get(g.id) || 0)) }));
  }
  async function savingsStrategy(hid) {
    return (await one('SELECT strategy FROM savings_settings WHERE household_id = ?', hid))?.strategy || 'proportional';
  }
  // A savings deposit is shared among the goals with a monthly plan, considering
  // what earlier deposits of the same month already gave them. Deposits into a
  // linked savings account are covered by its balance (reconcileSavings) instead.
  async function allocateSavings(transactionId, hid) {
    if (await one('SELECT transaction_id FROM savings_allocations WHERE transaction_id = ?', transactionId)) return;
    if (await one(`SELECT m.id FROM bank_movements m JOIN bank_accounts a ON a.household_id = m.household_id AND a.iban_hash = m.counterparty_hash
      WHERE m.transaction_id = ? AND a.savings = 1`, transactionId)) return;
    const record = await one('SELECT amount, date, author_id FROM transactions WHERE id = ? AND household_id = ?', transactionId, hid);
    if (!record) return;
    const goals = await plannedGoals(hid, record.date.slice(0, 7));
    if (!goals.length) return;
    for (const part of splitSavings(Number(record.amount), goals, await savingsStrategy(hid))) {
      const id = randomUUID();
      await run('INSERT INTO contributions VALUES (?, ?, ?, ?, ?)', id, part.id, part.amount, record.author_id, now());
      await run('UPDATE goals SET saved = saved + ? WHERE id = ?', part.amount, part.id);
      await run('INSERT INTO savings_allocations VALUES (?, ?)', transactionId, id);
    }
  }
  // Runs inside a transaction. The balance of the linked savings accounts is all
  // assigned to goals: what their savings do not cover yet is split like a deposit
  // (quotas, priority, targets). When goals hold more than the balance, after a
  // withdrawal or a targeted deposit, automatic shares give back first, newest
  // first and the goal in `keep` last. Manual savings and deposits towards other
  // destinations are never changed; savings beyond every target stay unassigned.
  async function reconcileSavings(hid, keep = null) {
    const accounts = await all(`SELECT a.balance, c.user_id FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id
      WHERE a.household_id = ? AND a.savings = 1 AND a.currency = 'EUR' AND a.balance IS NOT NULL ORDER BY a.balance DESC, a.id`, hid);
    if (!accounts.length) return;
    let gap = Math.max(0, accounts.reduce((sum, a) => sum + Number(a.balance), 0)) - await coveredSavings(hid);
    if (gap > 0) {
      const month = romeToday(clock()).slice(0, 7);
      const goals = await plannedGoals(hid, month);
      for (const part of goals.length ? splitSavings(gap, goals, await savingsStrategy(hid)) : []) {
        const id = randomUUID();
        await run('INSERT INTO contributions VALUES (?, ?, ?, ?, ?)', id, part.id, part.amount, accounts[0].user_id, now());
        await run('UPDATE goals SET saved = saved + ? WHERE id = ?', part.amount, part.id);
        await run('INSERT INTO savings_balance_allocations VALUES (?, ?, ?)', id, hid, month);
      }
      return;
    }
    const shares = await all(`SELECT c.id, c.goal_id, c.amount FROM savings_balance_allocations b JOIN contributions c ON c.id = b.contribution_id
      WHERE b.household_id = ? ORDER BY CASE WHEN c.goal_id = ? THEN 1 ELSE 0 END, c.created_at DESC, c.id DESC`, hid, keep || '');
    for (const share of shares) {
      if (gap >= 0) break;
      const take = Math.min(Number(share.amount), -gap);
      if (take === Number(share.amount)) {
        await run('DELETE FROM savings_balance_allocations WHERE contribution_id = ?', share.id);
        await run('DELETE FROM contributions WHERE id = ?', share.id);
      } else await run('UPDATE contributions SET amount = amount - ? WHERE id = ?', take, share.id);
      await run('UPDATE goals SET saved = CASE WHEN saved > ? THEN saved - ? ELSE 0 END WHERE id = ?', take, take, share.goal_id);
      gap += take;
    }
  }
  // What goals hold of the savings accounts' balance: all their savings except the
  // deposits sent to destinations that are not linked savings accounts.
  async function coveredSavings(hid) {
    const held = await one('SELECT COALESCE(SUM(saved), 0) AS total FROM goals WHERE household_id = ?', hid);
    const elsewhere = await one(`SELECT COALESCE(SUM(c.amount), 0) AS total FROM savings_allocations s JOIN contributions c ON c.id = s.contribution_id
      JOIN transactions t ON t.id = s.transaction_id WHERE t.household_id = ? AND NOT EXISTS (SELECT 1 FROM bank_movements m
      JOIN bank_accounts a ON a.household_id = m.household_id AND a.iban_hash = m.counterparty_hash WHERE m.transaction_id = t.id AND a.savings = 1)`, hid);
    return Number(held.total) - Number(elsewhere.total);
  }
  const savingsCategory = categories => categories[SAVINGS_POSITION]?.id || null;
  // Expenses towards a linked savings account, a known destination, a recognised
  // provider or a payee the family filed under Risparmio are savings.
  async function savingsDestination(hid, movement, target, guessed, categories) {
    const key = target ? `account:${target.id}` : movement.counterparty_hash ? `iban:${movement.counterparty_hash}` : movement.match_key ? `name:${movement.match_key}` : null;
    if (!key) return null;
    const existing = await one('SELECT * FROM savings_destinations WHERE household_id = ? AND destination_key = ?', hid, key);
    if (existing) return existing.enabled ? existing : null;
    if (!target && !movement.savings_hint && !(guessed && guessed === savingsCategory(categories))) return null;
    const created = { id: randomUUID(), enabled: 1 };
    await run('INSERT INTO savings_destinations VALUES (?, ?, ?, ?, NULL, 1, ?)', created.id, hid, key, (target?.name || movement.description).slice(0, 120), now());
    return created;
  }
  // Runs inside a transaction. Links movements to equal manual records within
  // three days, skips transfers between family accounts and files savings.
  async function importPending(hid) {
    const linked = new Map((await all('SELECT id, name, iban_hash, savings FROM bank_accounts WHERE household_id = ? AND iban_hash IS NOT NULL', hid)).map(a => [a.iban_hash, a]));
    // Withdrawals from savings and transfers between current accounts are giroconti;
    // deposits into a savings account are savings expenses.
    const isTransfer = movement => { const target = linked.get(movement.counterparty_hash); return !!target && (movement.kind === 'income' || !target.savings); };
    // A second linked account can reveal transfers already imported from the first.
    for (const movement of await all("SELECT id, kind, transaction_id, counterparty_hash FROM bank_movements WHERE household_id = ? AND status = 'imported' AND counterparty_hash IS NOT NULL", hid)) {
      if (!isTransfer(movement)) continue;
      await run("UPDATE bank_movements SET status = 'transfer', transaction_id = NULL WHERE id = ?", movement.id);
      if (movement.transaction_id) { await releaseSavings(movement.transaction_id); await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', movement.transaction_id, hid); }
    }
    // Accounts linked when imports began with the linking month also take their earlier history.
    for (const account of await all('SELECT id, import_from, created_at FROM bank_accounts WHERE household_id = ? AND import_from IS NOT NULL', hid)) {
      const start = importStart(account.created_at);
      if (account.import_from > start) await run('UPDATE bank_accounts SET import_from = ? WHERE id = ?', start, account.id);
    }
    // Movements inside a savings account (purchases, interest) never enter the budget.
    const rows = await all(`SELECT m.*, c.user_id, a.visibility, a.created_at AS linked_at FROM bank_movements m JOIN bank_accounts a ON a.id = m.account_id JOIN bank_connections c ON c.id = a.connection_id
      WHERE m.household_id = ? AND m.status = 'stored' AND a.savings = 0 AND a.import_from IS NOT NULL AND m.date >= a.import_from ORDER BY m.date, m.external_id`, hid);
    if (!rows.length) return;
    const categories = await all('SELECT id FROM categories WHERE household_id = ? ORDER BY position', hid);
    for (const movement of rows) {
      if (movement.counterparty_hash && isTransfer(movement)) {
        await run("UPDATE bank_movements SET status = 'transfer' WHERE id = ?", movement.id); continue;
      }
      const distanceTo = (value, date) => Math.abs(Date.parse(value) - Date.parse(date));
      // A credited salary silently replaces its planned recurring income: amount
      // and day become real, the record stays in the planned month. Sales, refunds
      // and other one-off credits never qualify: the credit needs a known payer, a
      // salary reason (or SEPA purpose SALA) or the same payer in previous months.
      if (movement.kind === 'income') {
        const payer = movement.counterparty_hash ? `iban:${movement.counterparty_hash}` : movement.match_key ? `name:${movement.match_key}` : null;
        const known = new Set(payer ? (await all('SELECT rule_id FROM salary_payers WHERE payer_key = ?', payer)).map(r => r.rule_id) : []);
        const close = (a, b) => Math.abs(a - b) * 100 <= a * PLANNED_TOLERANCE;
        const history = payer ? await all(`SELECT amount FROM bank_movements WHERE account_id = ? AND kind = 'income' AND id <> ? AND date >= ? AND date <= ? AND ${movement.counterparty_hash ? 'counterparty_hash' : 'match_key'} = ?`,
          movement.account_id, movement.id, addDays(movement.date, -75), addDays(movement.date, -20), movement.counterparty_hash || movement.match_key) : [];
        const salaryLike = !!movement.salary_hint || history.some(h => close(h.amount, movement.amount));
        const planned = (await all(`SELECT t.id, t.amount, t.date, r.id AS rule_id, r.author_id, o.id AS occurrence_id FROM recurring_occurrences o
          JOIN recurring_rules r ON r.id = o.rule_id JOIN transactions t ON t.id = o.transaction_id
          WHERE r.household_id = ? AND r.kind = 'income' AND o.overridden = 0 AND t.date >= ? AND t.date <= ?
          AND NOT EXISTS (SELECT 1 FROM bank_movements b WHERE b.transaction_id = t.id)`, hid, addDays(movement.date, -PLANNED_DAYS), addDays(movement.date, PLANNED_DAYS)))
          .filter(p => known.has(p.rule_id) || (salaryLike && close(p.amount, movement.amount)));
        const rank = p => [known.has(p.rule_id) ? 0 : 1, p.author_id === movement.user_id ? 0 : 1, Math.abs(p.amount - movement.amount), distanceTo(p.date, movement.date)];
        const best = planned.sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3] || a.id.localeCompare(b.id); })[0];
        if (best) {
          await run('UPDATE transactions SET amount = ?, date = ? WHERE id = ? AND household_id = ?', movement.amount, movement.date.slice(0, 7) === best.date.slice(0, 7) ? movement.date : best.date, best.id, hid);
          await run('UPDATE recurring_occurrences SET overridden = 1 WHERE id = ?', best.occurrence_id);
          if (payer) await run('INSERT INTO salary_payers VALUES (?, ?) ON CONFLICT(rule_id) DO UPDATE SET payer_key = excluded.payer_key', best.rule_id, payer);
          await run("UPDATE bank_movements SET status = 'matched', transaction_id = ? WHERE id = ?", best.id, movement.id);
          continue;
        }
      }
      // Planned recurring incomes are matched only by the salary rules above.
      const candidates = await all(`SELECT t.id, t.date FROM transactions t WHERE t.household_id = ? AND t.kind = ? AND t.amount = ? AND t.date >= ? AND t.date <= ?
        AND NOT EXISTS (SELECT 1 FROM bank_movements b WHERE b.transaction_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM recurring_occurrences o JOIN recurring_rules r ON r.id = o.rule_id WHERE o.transaction_id = t.id AND r.kind = 'income')`, hid, movement.kind, movement.amount, addDays(movement.date, -3), addDays(movement.date, 3));
      const distance = value => Math.abs(Date.parse(value) - Date.parse(movement.date));
      const match = candidates.sort((a, b) => distance(a.date) - distance(b.date) || a.id.localeCompare(b.id))[0];
      const guessed = movement.kind === 'expense' ? await guessCategory(hid, movement, categories) : null;
      const savings = movement.kind === 'expense' ? await savingsDestination(hid, movement, movement.counterparty_hash && linked.get(movement.counterparty_hash), guessed, categories) : null;
      let transactionId = match?.id;
      if (match) await run("UPDATE bank_movements SET status = 'matched', transaction_id = ? WHERE id = ?", match.id, movement.id);
      else {
        transactionId = randomUUID();
        await run('INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', transactionId, hid, movement.kind, movement.amount, savings ? savingsCategory(categories) : guessed, movement.description, movement.date, movement.user_id, now());
        if (movement.visibility === 'balance') await run('INSERT INTO private_transactions VALUES (?, ?)', transactionId, movement.user_id);
        await run("UPDATE bank_movements SET status = 'imported', transaction_id = ? WHERE id = ?", transactionId, movement.id);
      }
      // Deposits made before the link are filed under Risparmio but not split again
      // among the goals, whose totals already include what was saved until then.
      const earlier = movement.date < `${romeToday(Date.parse(movement.linked_at)).slice(0, 7)}-01`;
      if (savings && !earlier && (!match || (await one('SELECT category_id FROM transactions WHERE id = ?', transactionId))?.category_id === savingsCategory(categories))) await allocateSavings(transactionId, hid);
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
        const from = last?.date ? addDays(last.date, -10) : addDays(romeToday(clock()), -FETCHED_DAYS);
        fetched.push({ account, balance: pickBalance(await provider.balances(account.provider_uid, psu)), movements: normalizeTransactions(await provider.transactions(account.provider_uid, from, psu)) });
      }
    } catch (error) {
      const code = error instanceof BankError ? error.code : 'unavailable';
      await run('UPDATE bank_connections SET status = ?, last_error = ? WHERE id = ?', code === 'access' ? 'expired' : 'error', messages[code], connection.id);
      return code;
    }
    // Accounts removed while their imports stayed are read once more, so that
    // what they imported can be found and removed; a failed read is not retried.
    const leftovers = [];
    for (const exclusion of await all(`SELECT e.id, e.provider_uid FROM bank_account_exclusions e LEFT JOIN bank_exclusion_cleanups d ON d.exclusion_id = e.id
      WHERE e.connection_id = ? AND e.provider_uid IS NOT NULL AND d.exclusion_id IS NULL`, connection.id)) {
      let movements = [];
      try { movements = normalizeTransactions(await provider.transactions(exclusion.provider_uid, addDays(romeToday(clock()), -90), psu)); }
      catch { movements = []; }
      leftovers.push({ exclusion, movements });
    }
    await atomic(async () => {
      if (!await one('SELECT id FROM bank_connections WHERE id = ?', connection.id)) return;
      for (const { account, balance, movements } of fetched) {
        if (!await one('SELECT id FROM bank_accounts WHERE id = ?', account.id)) continue;
        if (balance) await run('UPDATE bank_accounts SET balance = ?, balance_kind = ?, balance_at = ? WHERE id = ?', balance.amount, balance.kind, now(), account.id);
        for (const m of movements) {
          await run(`INSERT INTO bank_movements (id, household_id, account_id, external_id, kind, amount, date, description, match_key, counterparty_hash, salary_hint, savings_hint, status, transaction_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', NULL, ?) ON CONFLICT(account_id, external_id) DO NOTHING`,
            randomUUID(), connection.household_id, account.id, m.externalId, m.kind, m.amount, m.date, m.description, m.matchKey, m.counterpartyHash, m.salaryHint, m.savingsHint, now());
        }
      }
      for (const { exclusion, movements } of leftovers) {
        if (!await one('SELECT id FROM bank_account_exclusions WHERE id = ?', exclusion.id)) continue;
        for (const m of movements) {
          // Only a record imported from it: same owner, amount, day and bank description, linked to nothing else.
          const record = await one(`SELECT t.id FROM transactions t WHERE t.household_id = ? AND t.author_id = ? AND t.kind = ? AND t.amount = ? AND t.date = ? AND t.description = ?
            AND NOT EXISTS (SELECT 1 FROM bank_movements b WHERE b.transaction_id = t.id) AND NOT EXISTS (SELECT 1 FROM recurring_occurrences o WHERE o.transaction_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM deadline_receipts r WHERE r.transaction_id = t.id) ORDER BY t.created_at, t.id LIMIT 1`,
            connection.household_id, connection.user_id, m.kind, m.amount, m.date, m.description);
          if (!record) continue;
          await releaseSavings(record.id);
          await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', record.id, connection.household_id);
        }
        await run('INSERT INTO bank_exclusion_cleanups VALUES (?, ?, ?) ON CONFLICT(exclusion_id) DO NOTHING', exclusion.id, connection.household_id, now());
      }
      await run("UPDATE bank_connections SET status = 'active', last_sync_at = ?, last_error = NULL WHERE id = ?", now(), connection.id);
      await importPending(connection.household_id);
      await reconcileSavings(connection.household_id);
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
      const eligible = created.accounts.filter(eligibleAccount);
      if (!created.sessionId || !eligible.length) { await endRemote(created.sessionId ? [encrypt(created.sessionId)] : []); return back('nessun-conto'); }
      const connectionId = randomUUID();
      const validUntil = Number.isFinite(Date.parse(created.validUntil)) ? new Date(Date.parse(created.validUntil)).toISOString() : new Date(clock() + 90 * DAY).toISOString();
      const replaced = await atomic(async () => {
        await run("INSERT INTO bank_connections VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, ?)", connectionId, request.household_id, request.user_id, request.aspsp_name, request.aspsp_country, encrypt(created.sessionId), validUntil, now());
        // Cards with an IBAN that were linked earlier leave with their imports.
        for (const card of created.accounts.filter(a => !eligibleAccount(a) && ibanHash(a.iban))) {
          for (const { id } of await all('SELECT a.id FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id WHERE c.user_id = ? AND a.iban_hash = ?', request.user_id, ibanHash(card.iban))) await dropAccount(id, request.household_id, true);
        }
        for (const account of eligible) {
          const hashValue = ibanHash(account.iban);
          // Accounts the owner removed stay hidden in a renewed consent.
          const excluded = await one('SELECT id FROM bank_account_exclusions WHERE user_id = ? AND account_key = ?', request.user_id, hashValue ? `iban:${hashValue}` : `uid:${account.uid}`);
          if (excluded) { await run('UPDATE bank_account_exclusions SET connection_id = ?, provider_uid = ? WHERE id = ?', connectionId, account.uid, excluded.id); continue; }
          // Renewing a consent keeps the account, its visibility and its history.
          const existing = hashValue && await one(`SELECT a.id FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id
            WHERE a.household_id = ? AND c.user_id = ? AND a.iban_hash = ? AND a.connection_id <> ?`, request.household_id, request.user_id, hashValue, connectionId);
          if (existing) await run('UPDATE bank_accounts SET connection_id = ?, provider_uid = ? WHERE id = ?', connectionId, account.uid, existing.id);
          // New accounts are current accounts; their owner marks the savings ones.
          else await run(`INSERT INTO bank_accounts (id, household_id, connection_id, provider_uid, name, iban_hash, iban_last4, currency, visibility, import_from, created_at, savings)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(connection_id, provider_uid) DO NOTHING`,
            randomUUID(), request.household_id, connectionId, account.uid, account.name, hashValue, normalizeIban(account.iban)?.slice(-4) || null, account.currency,
            request.visibility, importStart(now()), now(), 0);
        }
        await purgeCards(request.household_id);
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
    // Ends provider sessions (encrypted secrets) after their links were deleted.
    endSessions: endRemote,
    // Called inside the transaction that deletes or edits a record.
    releaseSavings,
    // After an edit: allocations follow amount, date and category; filing a bank
    // expense in or out of Risparmio teaches whether its payee is a saving.
    async syncSavings(transactionId, hid) {
      await releaseSavings(transactionId);
      const record = await one('SELECT kind, category_id FROM transactions WHERE id = ? AND household_id = ?', transactionId, hid);
      const movement = await one(`SELECT m.*, t.savings AS target_savings, t.id AS target_id FROM bank_movements m
        LEFT JOIN bank_accounts t ON t.household_id = m.household_id AND t.iban_hash = m.counterparty_hash WHERE m.transaction_id = ? AND m.kind = 'expense'`, transactionId);
      if (!record || !movement) return;
      const categories = await all('SELECT id FROM categories WHERE household_id = ? ORDER BY position', hid);
      const saving = record.kind === 'expense' && record.category_id === savingsCategory(categories);
      const key = movement.target_id ? `account:${movement.target_id}` : movement.counterparty_hash ? `iban:${movement.counterparty_hash}` : movement.match_key ? `name:${movement.match_key}` : null;
      if (key && !movement.target_savings) await run(`INSERT INTO savings_destinations VALUES (?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(household_id, destination_key) DO UPDATE SET enabled = excluded.enabled`,
        randomUUID(), hid, key, movement.description.slice(0, 120), saving ? 1 : 0, now());
      if (saving) await allocateSavings(transactionId, hid);
      await reconcileSavings(hid);
    },
    // Called inside the transaction that changes goals, plans or savings.
    reconcileSavings,
    routes() {
      app.get('/api/bank/banks', async (req, res) => { res.json({ banks: (await banks(req.query.country === undefined ? 'IT' : String(req.query.country))).map(({ name, country }) => ({ name, country })) }); });
      app.post('/api/bank/connections', async (req, res) => {
        requireProvider();
        if (!['shared', 'balance'].includes(req.body.visibility)) fail('Scegli cosa condividere con la famiglia.');
        const bank = (await banks(req.body.country === undefined ? 'IT' : String(req.body.country))).find(b => b.name === req.body.bank);
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
        await atomic(() => purgeCards(req.user.household_id));
        let synced = 0;
        for (const connection of await all("SELECT * FROM bank_connections WHERE household_id = ? AND status IN ('active', 'error')", req.user.household_id)) {
          const mine = connection.user_id === req.user.id;
          if (connection.last_attempt_at && clock() - Date.parse(connection.last_attempt_at) < (mine ? PRESENT_SYNC_MS : UNATTENDED_SYNC_MS)) continue;
          if (!await syncConnection(connection, mine ? psuOf(req) : null)) synced++;
        }
        res.json({ synced });
      });
      // One consent can cover several accounts: removing one keeps the bank linked.
      app.delete('/api/bank/accounts/:id', async (req, res) => {
        await atomic(async () => {
          const account = await one('SELECT a.*, c.user_id FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id WHERE a.id = ? AND a.household_id = ? AND c.user_id = ?', req.params.id, req.user.household_id, req.user.id);
          if (!account) fail('Conto non trovato.', 404);
          if ((await one('SELECT COUNT(*) AS count FROM bank_accounts WHERE connection_id = ?', account.connection_id)).count < 2) fail('È l’unico conto di questa banca: per toglierlo usa “Scollega banca”.');
          await run(`INSERT INTO bank_account_exclusions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, account_key) DO UPDATE SET connection_id = excluded.connection_id, provider_uid = excluded.provider_uid, name = excluded.name`,
            randomUUID(), req.user.household_id, req.user.id, account.iban_hash ? `iban:${account.iban_hash}` : `uid:${account.provider_uid}`, account.connection_id, account.provider_uid,
            account.name, account.iban_hash, account.iban_last4, account.currency, now());
          // It disappears with its bank copies, balance and the records it imported;
          // records entered by hand and only matched to it stay.
          await dropAccount(account.id, req.user.household_id, true);
          const exclusion = await one('SELECT id FROM bank_account_exclusions WHERE user_id = ? AND account_key = ?', req.user.id, account.iban_hash ? `iban:${account.iban_hash}` : `uid:${account.provider_uid}`);
          await run('INSERT INTO bank_exclusion_cleanups VALUES (?, ?, ?) ON CONFLICT(exclusion_id) DO NOTHING', exclusion.id, req.user.household_id, now());
        });
        res.json({ ok: true });
      });
      app.delete('/api/bank/connections/:id', async (req, res) => {
        const connection = await ownConnection(req.params.id, req.user);
        // Imported records stay in Entrate/Uscite; bank copies and balances are removed.
        // Unlinking also forgets removed accounts: linking the bank again shows them all.
        await atomic(async () => {
          await run('DELETE FROM bank_account_exclusions WHERE connection_id = ? AND user_id = ?', connection.id, req.user.id);
          await run('DELETE FROM bank_connections WHERE id = ? AND user_id = ?', connection.id, req.user.id);
        });
        await endRemote(connection.session_secret ? [connection.session_secret] : []);
        res.json({ ok: true });
      });
      app.patch('/api/bank/accounts/:id', async (req, res) => {
        const { visibility, savings } = req.body;
        if (visibility !== undefined && !['shared', 'balance'].includes(visibility)) fail('Visibilità non valida.');
        if (savings !== undefined && typeof savings !== 'boolean') fail('Valore non valido.');
        if (visibility === undefined && savings === undefined) fail('Nessuna modifica indicata.');
        await atomic(async () => {
          const account = await one('SELECT a.* FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id WHERE a.id = ? AND a.household_id = ? AND c.user_id = ?', req.params.id, req.user.household_id, req.user.id);
          if (!account) fail('Conto non trovato.', 404);
          const hid = req.user.household_id;
          if (visibility !== undefined && account.visibility !== visibility) {
            await run('UPDATE bank_accounts SET visibility = ?, import_from = ? WHERE id = ?', visibility, account.import_from || monthStart(), account.id);
            // Records already imported from this account follow the new choice.
            const imported = await all("SELECT transaction_id FROM bank_movements WHERE account_id = ? AND status = 'imported' AND transaction_id IS NOT NULL", account.id);
            for (const { transaction_id: id } of imported) {
              if (visibility === 'balance') await run('INSERT INTO private_transactions VALUES (?, ?) ON CONFLICT(transaction_id) DO NOTHING', id, req.user.id);
              else await run('DELETE FROM private_transactions WHERE transaction_id = ?', id);
            }
          }
          if (savings !== undefined && !!account.savings !== savings) {
            await run('UPDATE bank_accounts SET savings = ?, import_from = ? WHERE id = ?', savings ? 1 : 0, account.import_from || monthStart(), account.id);
            await run(`INSERT INTO savings_destinations VALUES (?, ?, ?, ?, NULL, ?, ?) ON CONFLICT(household_id, destination_key) DO UPDATE SET enabled = excluded.enabled`,
              randomUUID(), hid, `account:${account.id}`, account.name, savings ? 1 : 0, now());
            // The account's own movements leave (or re-enter) the budget, and transfers
            // into it become savings again (or giroconti) from the next import.
            const own = await all("SELECT id, transaction_id FROM bank_movements WHERE account_id = ? AND status = 'imported'", account.id);
            for (const movement of savings ? own : []) {
              if (movement.transaction_id) { await releaseSavings(movement.transaction_id); await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', movement.transaction_id, hid); }
              await run("UPDATE bank_movements SET status = 'stored', transaction_id = NULL WHERE id = ?", movement.id);
            }
            if (account.iban_hash) {
              const incoming = await all("SELECT id, status, transaction_id FROM bank_movements WHERE household_id = ? AND counterparty_hash = ? AND kind = 'expense'", hid, account.iban_hash);
              for (const movement of incoming) {
                if (savings && movement.status === 'transfer') await run("UPDATE bank_movements SET status = 'stored' WHERE id = ?", movement.id);
                if (!savings && movement.status === 'imported' && movement.transaction_id) {
                  await releaseSavings(movement.transaction_id); await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', movement.transaction_id, hid);
                  await run("UPDATE bank_movements SET status = 'transfer', transaction_id = NULL WHERE id = ?", movement.id);
                }
              }
            }
          }
          await importPending(hid);
          await reconcileSavings(hid);
        });
        res.json({ ok: true });
      });
      app.put('/api/savings/strategy', async (req, res) => {
        if (!['primary', 'proportional'].includes(req.body.strategy)) fail('Scegli come ripartire il risparmio.');
        await atomic(async () => {
          await run('INSERT INTO savings_settings VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET strategy = excluded.strategy', req.user.household_id, req.body.strategy);
          await reconcileSavings(req.user.household_id);
        });
        res.json({ ok: true });
      });
    },
    // Movements of the selected month (with their category) and every bank expense
    // still to classify, whatever its month. Others' private movements stay hidden.
    async state(user) {
      const accounts = await all(`SELECT a.id, a.name, a.iban_last4, a.currency, a.visibility, a.savings, a.balance, a.balance_kind, a.balance_at, a.import_from,
        c.id AS connection_id, c.aspsp_name AS bank, c.status, c.valid_until, c.last_sync_at, c.last_error, c.user_id, u.name AS owner
        FROM bank_accounts a JOIN bank_connections c ON c.id = a.connection_id JOIN users u ON u.id = c.user_id
        WHERE a.household_id = ? ORDER BY u.name, c.aspsp_name, a.name`, user.household_id);
      const savings = accounts.filter(a => a.currency === 'EUR' && a.balance !== null && a.savings);
      const savingsTotal = savings.reduce((sum, a) => sum + Number(a.balance), 0);
      return {
        configured: !!provider,
        // Current accounts and savings accounts are added up separately.
        total: accounts.filter(a => a.currency === 'EUR' && a.balance !== null && !a.savings).reduce((sum, a) => sum + Number(a.balance), 0),
        savingsTotal,
        accounts: accounts.map(({ user_id, last_error, ...a }) => ({ ...a, savings: !!a.savings, balance: a.balance === null ? null : Number(a.balance), mine: user_id === user.id, last_error: user_id === user.id ? last_error : null })),
        // The owner's links; removed accounts are not shown.
        connections: await all('SELECT id, aspsp_name AS bank, aspsp_country AS country, status, valid_until, last_error FROM bank_connections WHERE household_id = ? AND user_id = ? ORDER BY created_at', user.household_id, user.id),
        savingsStrategy: (await one('SELECT strategy FROM savings_settings WHERE household_id = ?', user.household_id))?.strategy || 'proportional',
        // Balance of the savings accounts that no goal can take (every target reached or no quota).
        savingsUnassigned: savings.length ? Math.max(0, Math.max(0, savingsTotal) - await coveredSavings(user.household_id)) : 0,
      };
    },
    // Unattended runs stay within four reads a day per connection (PSD2).
    async synchronizeAll({ minAgeMs = UNATTENDED_SYNC_MS } = {}) {
      if (!provider) return;
      await run('DELETE FROM bank_auth_requests WHERE expires <= ?', clock());
      for (const { household_id: hid } of await all('SELECT DISTINCT household_id FROM bank_accounts WHERE iban_hash IS NULL')) await atomic(() => purgeCards(hid));
      for (const connection of await all("SELECT * FROM bank_connections WHERE status IN ('active', 'error')")) {
        if (connection.last_attempt_at && clock() - Date.parse(connection.last_attempt_at) < minAgeMs) continue;
        try { await syncConnection(connection, null); }
        catch (error) { console.error('Aggiornamento bancario non riuscito:', error.message); }
      }
    },
  };
}
