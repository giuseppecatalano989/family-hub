import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { ADVISOR_SCHEMA } from './schema.mjs';
import { addDays, romeToday, safeProviderUrl } from './bank.mjs';
import { allocateBudget } from './notifications.mjs';
import { occurrenceDate } from './deadlines.mjs';
import { mondayOf } from './workflows.mjs';

// Budget advice. The server computes every figure in cents (pace, projections,
// subscriptions, deadlines); Claude only reads those figures and writes the
// advice. Private records of "balance" accounts are sent as category totals only,
// and descriptions lose IBANs and long codes before leaving the server.

export const DEFAULT_ADVISOR_MODEL = 'claude-opus-5-5';
const SAVINGS_POSITION = 5; const MONTHLY_DAYS = 7; const RUNNING_LIMIT = 10 * 60000; const RETRY_GAP = 6 * 3600000;
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
export const monthName = month => `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;
export function shiftMonth(month, delta) {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}
const daysIn = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
const sum = list => list.reduce((total, row) => total + Number(row.amount), 0);
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 2)]; };

// Removes what identifies accounts or people's documents: IBANs, card and
// reference numbers, email addresses.
export function scrub(description) {
  return String(description).replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi, '[IBAN]').replace(/\b[A-Z]{2}\d{2}(?: [A-Z0-9]{4}){3,7}(?: [A-Z0-9]{1,3})?\b/gi, '[IBAN]').replace(/\S+@\S+\.\S+/g, '[email]')
    .replace(/\d[\d\s./-]{4,}\d/g, '…').replace(/\s+/g, ' ').trim().slice(0, 80);
}
// The same shop or service across months, without dates, codes and payment words.
export function merchantKey(description) {
  return String(description).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(pagamento|pagam|pag|pos|carta|card|addebito|addebitato|sdd|bonifico|a favore di|favore|presso|acquisto|operazione|del|dei|il|la|con|di|da|nr|n|ord|ordinante|beneficiario|vs|rif)\b/g, ' ')
    .replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(word => word.length > 1).slice(0, 3).join(' ');
}

// Every figure the advice relies on, from the family's records. Pure, so it is
// tested without a database or a model.
export function analyze({ kind, today, month, categories, limits, base, rows, deadlines = [], handled = [], goals = [] }) {
  const current = today.slice(0, 7); const days = daysIn(month);
  const open = month === current;
  const elapsed = month < current ? days : month > current ? 0 : Number(today.slice(8, 10));
  const savingsId = categories[5]?.id;
  const expenses = rows.filter(r => r.kind === 'expense');
  const inMonth = expenses.filter(r => r.date.startsWith(month));
  const shared = expenses.filter(r => !Number(r.private));
  const done = new Set(handled.map(h => `${h.deadline_id}:${h.month}`));
  const upcoming = [];
  for (let offset = 0; offset < 4; offset++) {
    const period = shiftMonth(current, offset);
    for (const deadline of deadlines) {
      const due = occurrenceDate(deadline, period);
      if (!due || done.has(`${deadline.id}:${period}`) || (period === current && due < addDays(today, -31))) continue;
      upcoming.push({ name: deadline.name, date: due, amount: Number(deadline.amount), categoryId: deadline.category_id });
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  const byCategory = categories.map((c, index) => {
    const list = inMonth.filter(r => r.category_id === c.id);
    const spent = sum(list);
    const fixed = sum(list.filter(r => Number(r.recurring) || Number(r.scheduled) || r.date > today));
    const due = open ? sum(upcoming.filter(u => u.categoryId === c.id && u.date.startsWith(month))) : 0;
    // Variable spending continues at the pace of the elapsed days; recurring
    // costs and deadlines count once, for what they are.
    const projected = open && elapsed < days ? fixed + due + Math.round((spent - fixed) * days / Math.max(elapsed, 1)) : spent;
    const previous = [1, 2, 3].map(step => sum(expenses.filter(r => r.category_id === c.id && r.date.startsWith(shiftMonth(month, -step)))));
    return { id: c.id, name: c.name, percentage: c.percentage, savings: index === 5, limit: limits[c.id] ?? 0, spent, fixed, projected, previous };
  });
  const daysLeft = open ? days - elapsed + 1 : 0;
  const alerts = byCategory.filter(c => !c.savings && base > 0 && (c.spent > c.limit || (open && c.projected > c.limit)))
    .map(c => ({ categoryId: c.id, name: c.name, spent: c.spent, limit: c.limit, projected: c.projected, status: c.spent > c.limit ? 'over' : 'risk',
      perDay: c.spent < c.limit && daysLeft ? Math.floor((c.limit - c.spent) / daysLeft) : 0 }))
    .sort((a, b) => (b.projected - b.limit) - (a.projected - a.limit));

  // Repeated payments to the same service: three months or more, about once a
  // month, similar amounts. Recurring rules and savings transfers are known already.
  const candidates = shared.filter(r => !Number(r.recurring) && r.category_id !== savingsId && r.date <= `${month}-31`);
  const groups = new Map();
  for (const row of candidates) { const key = merchantKey(row.description); if (key) groups.set(key, [...(groups.get(key) || []), row]); }
  const subscriptions = [];
  for (const [key, list] of groups) {
    const months = [...new Set(list.map(r => r.date.slice(0, 7)))].sort();
    const amounts = list.map(r => Number(r.amount));
    if (months.length < 3 || list.length > months.length * 1.5 || Math.max(...amounts) > Math.min(...amounts) * 1.5) continue;
    const ordered = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const last = ordered.at(-1); const before = ordered.at(-2);
    subscriptions.push({ key, name: scrub(last.description), monthly: median(amounts), yearly: median(amounts) * 12, last: Number(last.amount), lastDate: last.date,
      since: months[0], increased: Number(last.amount) > Number(before.amount) * 1.05 });
  }
  subscriptions.sort((a, b) => b.monthly - a.monthly);

  // Small, frequent purchases of the focus month, against the previous three.
  const frequentGroups = new Map();
  for (const row of shared.filter(r => r.date.startsWith(month) && r.date <= today && !Number(r.recurring) && r.category_id !== savingsId && Number(r.amount) <= 4000)) {
    const key = merchantKey(row.description); if (key) frequentGroups.set(key, [...(frequentGroups.get(key) || []), row]);
  }
  const frequent = [...frequentGroups].filter(([, list]) => list.length >= 4).map(([key, list]) => ({
    key, name: scrub(list.at(-1).description), count: list.length, total: sum(list),
    previousAverage: Math.round(sum(shared.filter(r => merchantKey(r.description) === key && r.date < `${month}-01` && r.date >= `${shiftMonth(month, -3)}-01`)) / 3),
  })).sort((a, b) => b.total - a.total);

  // Same amount to the same shop within a day: possibly charged twice.
  const recent = shared.filter(r => r.date >= addDays(today, -45) && r.date <= today && !Number(r.recurring)).sort((a, b) => a.date.localeCompare(b.date));
  const duplicates = [];
  for (let i = 0; i < recent.length; i++) for (let j = i + 1; j < recent.length; j++) {
    const a = recent[i]; const b = recent[j];
    if (Date.parse(b.date) - Date.parse(a.date) > 86400000) break;
    if (Number(a.amount) === Number(b.amount) && merchantKey(a.description) && merchantKey(a.description) === merchantKey(b.description) && Number(a.amount) >= 500)
      duplicates.push({ name: scrub(b.description), amount: Number(b.amount), dates: [a.date, b.date] });
  }

  const week = kind === 'weekly' ? (() => {
    const from = addDays(today, -7); const to = addDays(today, -1);
    const list = expenses.filter(r => r.date >= from && r.date <= to);
    return { from, to, total: sum(list), categories: Object.fromEntries(categories.map(c => [c.id, sum(list.filter(r => r.category_id === c.id))])),
      largest: list.filter(r => !Number(r.private)).sort((a, b) => b.amount - a.amount).slice(0, 8).map(r => ({ name: scrub(r.description), amount: Number(r.amount), date: r.date, categoryId: r.category_id })) };
  })() : null;

  const uncategorized = shared.filter(r => !r.category_id && r.date >= addDays(today, -45)).slice(-40).map(r => ({ id: r.id, name: scrub(r.description), amount: Number(r.amount), date: r.date }));
  const incomes = rows.filter(r => r.kind === 'income' && r.date.startsWith(month));
  return {
    kind, today, month, days, elapsed, base, income: sum(incomes), expense: sum(inMonth),
    categories: byCategory, alerts, subscriptions: subscriptions.slice(0, 10), frequent: frequent.slice(0, 5), duplicates: duplicates.slice(0, 5), week,
    deadlines: upcoming.slice(0, 12), uncategorized,
    goals: goals.map(g => {
      const left = Math.max(0, Number(g.target) - Number(g.saved));
      const months = g.due_date ? Math.max(1, (Number(g.due_date.slice(0, 4)) - Number(current.slice(0, 4))) * 12 + Number(g.due_date.slice(5, 7)) - Number(current.slice(5)) + 1) : null;
      return { name: g.title, target: Number(g.target), saved: Number(g.saved), dueDate: g.due_date, monthly: Number(g.monthly), needed: months ? Math.ceil(left / months) : null };
    }),
    empty: !expenses.some(r => r.date >= addDays(today, -60)),
  };
}

const euros = cents => Math.round(cents) / 100;
// What Claude reads: euros as numbers for readability, the family's categories,
// and nothing that names members, accounts or the household.
export function modelInput(facts, { current, months }) {
  const name = id => facts.categories.find(c => c.id === id)?.name || null;
  return JSON.stringify({
    tipo_report: facts.kind === 'weekly' ? 'settimanale' : 'mensile', oggi: facts.today, mese_analizzato: facts.month, giorni_del_mese: facts.days, giorni_trascorsi: facts.elapsed,
    mese_corrente: current, mesi_ammessi_per_la_ripartizione: months,
    entrate_ricorrenti_da_ripartire: euros(facts.base), entrate_del_mese: euros(facts.income), uscite_del_mese: euros(facts.expense),
    categorie: facts.categories.map(c => ({ id: c.id, nome: c.name, percentuale: c.percentage / 100, risparmio: c.savings, massimale: euros(c.limit), speso: euros(c.spent), di_cui_fisso: euros(c.fixed), proiezione_fine_mese: euros(c.projected), mesi_precedenti: c.previous.map(euros) })),
    sforamenti: facts.alerts.map(a => ({ categoria: a.name, stato: a.status === 'over' ? 'superato' : 'a rischio', speso: euros(a.spent), massimale: euros(a.limit), proiezione: euros(a.projected), al_giorno_per_rientrare: euros(a.perDay) })),
    settimana: facts.week && { dal: facts.week.from, al: facts.week.to, totale: euros(facts.week.total), per_categoria: Object.fromEntries(Object.entries(facts.week.categories).map(([id, v]) => [name(id) || id, euros(v)])), spese_maggiori: facts.week.largest.map(r => ({ descrizione: r.name, importo: euros(r.amount), data: r.date, categoria: name(r.categoryId) })) },
    abbonamenti_e_pagamenti_ripetuti: facts.subscriptions.map(s => ({ descrizione: s.name, al_mese: euros(s.monthly), all_anno: euros(s.yearly), ultimo: euros(s.last), dal: s.since, aumentato: s.increased })),
    piccole_spese_frequenti: facts.frequent.map(f => ({ descrizione: f.name, volte: f.count, totale: euros(f.total), media_mesi_precedenti: euros(f.previousAverage) })),
    possibili_doppioni: facts.duplicates.map(d => ({ descrizione: d.name, importo: euros(d.amount), date: d.dates })),
    scadenze_in_arrivo: facts.deadlines.map(d => ({ nome: d.name, data: d.date, importo: euros(d.amount), categoria: name(d.categoryId) })),
    obiettivi: facts.goals.map(g => ({ nome: g.name, obiettivo: euros(g.target), risparmiato: euros(g.saved), entro: g.dueDate, quota_mensile: euros(g.monthly), necessario_al_mese: g.needed === null ? null : euros(g.needed) })),
    uscite_da_classificare: facts.uncategorized.map(u => ({ id: u.id, descrizione: u.name, importo: euros(u.amount), data: u.date })),
  });
}

export const SYSTEM_PROMPT = `Sei il consulente del budget di una famiglia italiana nell'app Family Hub. Ricevi i dati del loro budget già calcolati dal server (importi in euro) e scrivi un report breve, concreto e gentile, in italiano, rivolto alla famiglia ("voi").

Come lavorare:
- Usa solo i numeri forniti: non ricalcolare totali e non inventare movimenti, negozi o importi. Se citi una cifra, deve comparire nei dati.
- Report settimanale: com'è andata la settimana e come rientrare nel budget entro fine mese. Report mensile: com'è andato il mese chiuso e cosa preparare per il mese corrente.
- Consigli ("tips"): da 2 a 5, ciascuno con un'azione precisa. Usa "avoid" per spese da evitare o rivedere (abbonamenti, piccole spese frequenti, doppioni, aumenti), "adjust" per aggiustamenti del periodo, "goal" per gli obiettivi, "info" per il resto. La categoria con "risparmio": true non è una spesa da tagliare.
- Ripartizione ("adjustment"): proponila ("propose": true) solo se una scadenza in arrivo, un mese pesante o uno sforamento la giustificano; altrimenti "propose": false con "percentages" vuoto. Vale per un solo mese, scelto tra quelli ammessi, e il mese dopo torna la ripartizione abituale. Indica una percentuale intera per ogni categoria, con gli stessi id, e la somma deve fare 100. Spiega il motivo in una frase.
- Classificazione ("categories"): per ogni uscita da classificare di cui sei ragionevolmente sicuro, indica l'id della categoria più adatta. Ometti le incerte.
- Stile: frasi semplici, niente gergo finanziario, niente elenchi nel testo. Titolo ("headline") di massimo 100 caratteri, riepilogo ("summary") di massimo 3 frasi.`;

export const ADVICE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'summary', 'tips', 'adjustment', 'categories'],
  properties: {
    headline: { type: 'string' }, summary: { type: 'string' },
    tips: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'title', 'detail'], properties: { kind: { type: 'string', enum: ['avoid', 'adjust', 'goal', 'info'] }, title: { type: 'string' }, detail: { type: 'string' } } } },
    adjustment: { type: 'object', additionalProperties: false, required: ['propose', 'month', 'reason', 'percentages'], properties: { propose: { type: 'boolean' }, month: { type: 'string' }, reason: { type: 'string' },
      percentages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category_id', 'percent'], properties: { category_id: { type: 'string' }, percent: { type: 'integer' } } } } } },
    categories: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['transaction_id', 'category_id'], properties: { transaction_id: { type: 'string' }, category_id: { type: 'string' } } } },
  },
};

const clip = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
// The model's answer is data: lengths are bounded, the split must cover every
// category with whole percentages adding up to 100 and differ from the month's
// own, and hints may only name the family's records.
export function sanitizeAdvice(raw, facts, { months }) {
  const tips = (Array.isArray(raw?.tips) ? raw.tips : []).filter(t => t && ['avoid', 'adjust', 'goal', 'info'].includes(t.kind) && clip(t.title, 100))
    .slice(0, 6).map(t => ({ kind: t.kind, title: clip(t.title, 100), detail: clip(t.detail, 400) }));
  let adjustment = null;
  const proposal = raw?.adjustment;
  if (proposal?.propose && months.includes(proposal.month) && Array.isArray(proposal.percentages)) {
    const entries = proposal.percentages;
    const ids = facts.categories.map(c => c.id);
    const valid = entries.length === ids.length && new Set(entries.map(e => e?.category_id)).size === ids.length && entries.every(e => ids.includes(e?.category_id) && Number.isInteger(e.percent) && e.percent >= 0 && e.percent <= 100)
      && entries.reduce((total, e) => total + e.percent, 0) === 100;
    if (valid) {
      const split = Object.fromEntries(ids.map(id => [id, entries.find(e => e.category_id === id).percent * 100]));
      if (facts.categories.some(c => split[c.id] !== c.percentage)) adjustment = { month: proposal.month, reason: clip(proposal.reason, 300), split };
    }
  }
  const allowed = new Set(facts.uncategorized.map(u => u.id)); const categories = new Set(facts.categories.map(c => c.id));
  const hints = (Array.isArray(raw?.categories) ? raw.categories : []).filter(h => allowed.has(h?.transaction_id) && categories.has(h?.category_id))
    .map(h => ({ transactionId: h.transaction_id, categoryId: h.category_id }));
  return { headline: clip(raw?.headline, 140) || 'Il vostro report del budget', summary: clip(raw?.summary, 900), tips, adjustment, hints };
}

// Claude through the Anthropic API; the key never leaves the backend.
// A different API address is accepted over HTTPS, or HTTP on loopback for tests.
export function anthropicAdvisor({ apiKey = process.env.ANTHROPIC_API_KEY, model = process.env.ANTHROPIC_MODEL || DEFAULT_ADVISOR_MODEL, baseURL = process.env.ANTHROPIC_BASE_URL } = {}) {
  if (!apiKey) return null;
  if (baseURL && !safeProviderUrl(baseURL)) throw new Error('ANTHROPIC_BASE_URL deve usare HTTPS.');
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined, timeout: 240000, maxRetries: 1 });
  // Server-side fallback re-runs a declined request on the recommended model;
  // the Haiku models have none.
  const fallback = !model.startsWith('claude-haiku');
  return {
    model,
    async advise({ system, input, schema }) {
      const response = await client.beta.messages.create({
        model, max_tokens: 16000, system, messages: [{ role: 'user', content: input }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      });
      if (response.stop_reason === 'refusal') throw Object.assign(new Error('Il modello non ha preparato il report.'), { code: 'refusal' });
      if (response.stop_reason === 'max_tokens') throw Object.assign(new Error('Il report è risultato troppo lungo.'), { code: 'max_tokens' });
      return JSON.parse(response.content.filter(block => block.type === 'text').map(block => block.text).join(''));
    },
  };
}

function present(report, { current, overrides, unread }) {
  if (!report) return null;
  const facts = JSON.parse(report.facts); const advice = JSON.parse(report.advice);
  const applied = advice.adjustment && overrides.find(o => o.month === advice.adjustment.month && o.report_id === report.id);
  return {
    id: report.id, kind: report.kind, period: report.period, month: report.month, createdAt: report.created_at, unread: unread(report),
    headline: advice.headline, summary: advice.summary, tips: advice.tips,
    adjustment: advice.adjustment && { ...advice.adjustment, applied: !!applied, applicable: advice.adjustment.month >= current },
    alerts: facts.alerts, subscriptions: facts.subscriptions.slice(0, 5), frequent: facts.frequent.slice(0, 3), duplicates: facts.duplicates.slice(0, 3),
    deadlines: facts.deadlines.filter(d => d.date >= facts.today).slice(0, 3), week: facts.week && { from: facts.week.from, to: facts.week.to, total: facts.week.total },
  };
}

export function installAdvisor(app, { db, one, all, run, atomic, fail, exclusive, splitFor, budgetBase, notifications }, { model, schedule, clock = Date.now } = {}) {
  if (!db.cloud) db.exec(ADVISOR_SCHEMA);
  const now = () => new Date(clock()).toISOString();
  const pending = new Set();
  const later = work => {
    const task = work().catch(error => console.error('Report del budget non preparato:', error.message)).finally(() => pending.delete(task));
    pending.add(task); if (schedule) schedule(task); return task;
  };
  const settings = hid => one('SELECT * FROM advisor_settings WHERE household_id = ?', hid);
  const periodOf = (kind, today) => kind === 'weekly' ? mondayOf(today) : shiftMonth(today.slice(0, 7), -1);
  // A one-month split may be suggested for the current month or the next two.
  const allowedMonths = (kind, current) => kind === 'weekly' ? [current, shiftMonth(current, 1)] : [current, shiftMonth(current, 1), shiftMonth(current, 2)];

  async function collect(hid, kind, today) {
    const current = today.slice(0, 7);
    const month = kind === 'monthly' ? shiftMonth(current, -1) : current;
    const categories = await all('SELECT id, name, percentage FROM categories WHERE household_id = ? ORDER BY position', hid);
    const split = await splitFor(hid, month);
    const shares = categories.map(c => ({ ...c, percentage: split?.[c.id] ?? c.percentage }));
    const base = await budgetBase(hid, month);
    const rows = await all(`SELECT t.id, t.kind, t.amount, t.category_id, t.description, t.date,
        CASE WHEN p.transaction_id IS NULL THEN 0 ELSE 1 END AS private, CASE WHEN o.rule_id IS NULL THEN 0 ELSE 1 END AS recurring,
        CASE WHEN EXISTS (SELECT 1 FROM deadline_receipts r WHERE r.transaction_id = t.id) OR EXISTS (SELECT 1 FROM bill_payments b WHERE b.transaction_id = t.id) THEN 1 ELSE 0 END AS scheduled
      FROM transactions t LEFT JOIN private_transactions p ON p.transaction_id = t.id LEFT JOIN recurring_occurrences o ON o.transaction_id = t.id
      WHERE t.household_id = ? AND t.date >= ? AND t.date <= ? ORDER BY t.date, t.id`, hid, `${shiftMonth(month, -6)}-01`, `${shiftMonth(current, 0)}-31`);
    const deadlines = await all('SELECT * FROM deadlines WHERE household_id = ? AND active = 1 AND requires_payment = 1', hid);
    const handled = await all('SELECT r.deadline_id, r.month FROM deadline_receipts r JOIN deadlines d ON d.id = r.deadline_id WHERE d.household_id = ?', hid);
    const goals = await all('SELECT g.title, g.target, g.saved, g.due_date, COALESCE(p.monthly, 0) AS monthly FROM goals g LEFT JOIN goal_plans p ON p.goal_id = g.id WHERE g.household_id = ? AND g.saved < g.target', hid);
    // Figures of the focus month only: later records of a closed month's report stay out.
    const scoped = kind === 'monthly' ? rows.filter(r => r.date <= `${month}-31`) : rows;
    return analyze({ kind, today, month, categories: shares, limits: allocateBudget(base, shares), base, rows: scoped, deadlines, handled, goals });
  }

  // Automatic assignment: pending suggestions become the expense's category.
  // Savings transfers stay suggestions, since confirming one also feeds the goals.
  async function assignHints(hid) {
    const savings = (await all('SELECT id FROM categories WHERE household_id = ? ORDER BY position', hid))[SAVINGS_POSITION]?.id;
    const pending = await all(`SELECT h.transaction_id, h.category_id FROM advisor_category_hints h JOIN transactions t ON t.id = h.transaction_id
      WHERE t.household_id = ? AND t.category_id IS NULL AND NOT EXISTS (SELECT 1 FROM private_transactions p WHERE p.transaction_id = t.id)`, hid);
    for (const hint of pending.filter(h => h.category_id !== savings)) {
      await run('UPDATE transactions SET category_id = ? WHERE id = ? AND household_id = ? AND category_id IS NULL', hint.category_id, hint.transaction_id, hid);
      await run('DELETE FROM advisor_category_hints WHERE transaction_id = ?', hint.transaction_id);
    }
  }

  // Figures are read inside the request queue, Claude is called outside it,
  // and the report is stored in one transaction with its category hints.
  async function generate(hid, kind, { queued = false } = {}) {
    const serial = queued ? work => work() : exclusive;
    const today = romeToday(clock()); const current = today.slice(0, 7);
    const facts = await serial(async () => {
      if (!(await settings(hid))?.enabled) return null;
      const result = await collect(hid, kind, today);
      await run('UPDATE advisor_settings SET running_since = ?, attempted_at = ? WHERE household_id = ?', now(), now(), hid);
      return result;
    });
    if (!facts) return;
    if (facts.empty) { await serial(() => run('UPDATE advisor_settings SET running_since = NULL WHERE household_id = ?', hid)); return; }
    const months = allowedMonths(kind, current);
    let advice;
    try { advice = sanitizeAdvice(await model.advise({ system: SYSTEM_PROMPT, input: modelInput(facts, { current, months }), schema: ADVICE_SCHEMA }), facts, { months }); }
    catch (error) {
      await serial(() => run('UPDATE advisor_settings SET running_since = NULL, last_error = ? WHERE household_id = ?', 'L’ultimo report non è stato preparato: l’app riprova da sola tra qualche ora.', hid));
      throw Object.assign(new Error(`${error.code || error.status || 'errore'}`), { cause: error });
    }
    const period = periodOf(kind, today);
    const messages = await serial(() => atomic(async () => {
      if (!(await settings(hid))?.enabled) return [];
      const { hints, ...stored } = advice;
      await run(`INSERT INTO advisor_reports VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(household_id, kind, period) DO UPDATE SET month = excluded.month, facts = excluded.facts, advice = excluded.advice, created_at = excluded.created_at`,
        randomUUID(), hid, kind, period, facts.month, JSON.stringify(facts), JSON.stringify(stored), now());
      // Hints only for expenses that are still without a category.
      for (const hint of hints) await run(`INSERT INTO advisor_category_hints SELECT t.id, CAST(? AS TEXT), CAST(? AS TEXT) FROM transactions t WHERE t.id = ? AND t.household_id = ? AND t.category_id IS NULL
        ON CONFLICT(transaction_id) DO UPDATE SET category_id = excluded.category_id, created_at = excluded.created_at`, hint.categoryId, now(), hint.transactionId, hid);
      if ((await one('SELECT automatic FROM advisor_assignment WHERE household_id = ?', hid))?.automatic) await assignHints(hid);
      await run('UPDATE advisor_settings SET running_since = NULL, last_error = NULL WHERE household_id = ?', hid);
      return notifications.reportReady(hid, { kind, period, title: kind === 'weekly' ? 'Report settimanale del budget' : `Il budget di ${monthName(facts.month)}`, body: advice.headline });
    }));
    await notifications.deliver(messages);
  }

  // Missing reports of one family: the monthly first, so that a weekly report
  // of the new month is the most recent one.
  async function catchUp(hid, attemptedAt) {
    const today = romeToday(clock());
    if (attemptedAt && clock() - Date.parse(attemptedAt) < RETRY_GAP && !(await one('SELECT id FROM advisor_reports WHERE household_id = ? AND created_at >= ?', hid, attemptedAt))) return;
    for (const kind of ['monthly', 'weekly']) {
      // The days before the month's first Monday belong to the monthly report.
      if (kind === 'weekly' && periodOf(kind, today) < `${today.slice(0, 7)}-01`) continue;
      // The closed month's report belongs to the month's first week: turned on
      // later, the first monthly report arrives on the next 1st.
      if (kind === 'monthly' && Number(today.slice(8)) > MONTHLY_DAYS) continue;
      if (await one('SELECT id FROM advisor_reports WHERE household_id = ? AND kind = ? AND period = ?', hid, kind, periodOf(kind, today))) continue;
      try { await generate(hid, kind); } catch (error) { console.error('Report del budget non preparato:', error.message); }
    }
  }

  return {
    // Weekly report from Monday, monthly report from the 1st; failed attempts
    // wait six hours, so the local timer does not call the API every 15 minutes.
    async scheduled() {
      if (!model) return;
      for (const row of await all('SELECT household_id, attempted_at FROM advisor_settings WHERE enabled = 1')) await catchUp(row.household_id, row.attempted_at);
    },
    runLater() { return later(() => this.scheduled()); },
    async idle() { while (pending.size) await Promise.all([...pending]); },
    async state(user, month) {
      const row = await settings(user.household_id);
      const current = romeToday(clock()).slice(0, 7);
      const overrides = await all('SELECT month, report_id FROM budget_month_overrides WHERE household_id = ?', user.household_id);
      const latest = kind => one('SELECT * FROM advisor_reports WHERE household_id = ? AND kind = ? ORDER BY period DESC LIMIT 1', user.household_id, kind);
      const enabled = !!row?.enabled;
      const monthly = enabled ? await latest('monthly') : null;
      // A new month starts with its monthly report: the weekly report of a week
      // that began in the closed month is no longer shown.
      const weeklyRow = enabled ? await latest('weekly') : null;
      const weekly = weeklyRow && (!monthly || weeklyRow.period > `${monthly.month}-31`) ? weeklyRow : null;
      // Read per kind; reads saved before the two were separate count for both.
      const before = (await one('SELECT read_at FROM advisor_reads WHERE user_id = ?', user.id))?.read_at || '';
      const reads = Object.fromEntries((await all('SELECT kind, read_at FROM advisor_kind_reads WHERE user_id = ?', user.id)).map(r => [r.kind, r.read_at]));
      const unread = report => !!report && report.created_at > [before, reads[report.kind] || ''].sort().at(-1);
      const hints = enabled ? await all(`SELECT h.transaction_id, h.category_id FROM advisor_category_hints h JOIN transactions t ON t.id = h.transaction_id
        WHERE t.household_id = ? AND t.category_id IS NULL AND NOT EXISTS (SELECT 1 FROM private_transactions p WHERE p.transaction_id = t.id)`, user.household_id) : [];
      const override = overrides.find(o => o.month === month);
      return {
        configured: !!model, enabled, canManage: user.role === 'admin',
        automatic: !!(await one('SELECT automatic FROM advisor_assignment WHERE household_id = ?', user.household_id))?.automatic,
        running: !!row?.running_since && clock() - Date.parse(row.running_since) < RUNNING_LIMIT, error: row?.last_error || null,
        weekly: present(weekly, { current, overrides, unread }), monthly: present(monthly, { current, overrides, unread }),
        unread: unread(weekly) || unread(monthly),
        hints: Object.fromEntries(hints.map(h => [h.transaction_id, h.category_id])),
        override: override ? { month: override.month, fromReport: !!override.report_id } : null,
      };
    },
    routes() {
      // Sending the family's figures to an outside service is the administrator's choice.
      app.put('/api/advisor/settings', async (req, res) => {
        if (req.user.role !== 'admin') fail('Solo l’amministratore può attivare i consigli del budget.', 403);
        if (typeof req.body?.enabled !== 'boolean') fail('Valore non valido.');
        if (req.body.enabled && !model) fail('I consigli non sono configurati sul server.', 503);
        await atomic(async () => {
          await run(`INSERT INTO advisor_settings (household_id, enabled, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(household_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at, last_error = NULL, attempted_at = NULL`, req.user.household_id, req.body.enabled ? 1 : 0, now());
          if (!req.body.enabled) await run('DELETE FROM advisor_category_hints WHERE transaction_id IN (SELECT id FROM transactions WHERE household_id = ?)', req.user.household_id);
        });
        // Reports are never requested by hand: once on, the missing ones are prepared at once.
        const hid = req.user.household_id;
        if (req.body.enabled) res.once('finish', () => { void later(() => catchUp(hid, null)); });
        res.json({ ok: true });
      });
      // Suggested or automatic categories for the expenses still to classify.
      app.put('/api/advisor/assignment', async (req, res) => {
        if (req.user.role !== 'admin') fail('Solo l’amministratore può scegliere come assegnare le categorie.', 403);
        if (typeof req.body?.automatic !== 'boolean') fail('Valore non valido.');
        await atomic(async () => {
          await run(`INSERT INTO advisor_assignment VALUES (?, ?, ?) ON CONFLICT(household_id) DO UPDATE SET automatic = excluded.automatic, updated_at = excluded.updated_at`, req.user.household_id, req.body.automatic ? 1 : 0, now());
          if (req.body.automatic && (await settings(req.user.household_id))?.enabled) await assignHints(req.user.household_id);
        });
        res.json({ ok: true });
      });
      // Reading is personal: the highlight goes away for whoever opened the reports.
      app.post('/api/advisor/reports/:id/read', async (req, res) => {
        const report = await one('SELECT kind, created_at FROM advisor_reports WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
        if (!report) fail('Report non trovato.', 404);
        await run(`INSERT INTO advisor_kind_reads VALUES (?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET read_at = CASE WHEN advisor_kind_reads.read_at > excluded.read_at THEN advisor_kind_reads.read_at ELSE excluded.read_at END`, req.user.id, report.kind, report.created_at);
        res.json({ ok: true });
      });
      // The suggested split holds for its month only; the next month returns to
      // the usual one by itself.
      app.post('/api/advisor/reports/:id/apply', async (req, res) => {
        await atomic(async () => {
          const report = await one('SELECT * FROM advisor_reports WHERE id = ? AND household_id = ?', req.params.id, req.user.household_id);
          if (!report) fail('Report non trovato.', 404);
          const adjustment = JSON.parse(report.advice).adjustment;
          if (!adjustment) fail('Questo report non suggerisce una ripartizione.');
          if (adjustment.month < romeToday(clock()).slice(0, 7)) fail('Il mese di questa ripartizione è già chiuso.');
          const ids = (await all('SELECT id FROM categories WHERE household_id = ?', req.user.household_id)).map(c => c.id);
          if (ids.length !== Object.keys(adjustment.split).length || ids.some(id => !Number.isInteger(adjustment.split[id]))) fail('Le categorie sono cambiate dopo il report: chiedi un nuovo report.');
          await run(`INSERT INTO budget_month_overrides VALUES (?, ?, ?, ?, ?) ON CONFLICT(household_id, month) DO UPDATE SET entries = excluded.entries, report_id = excluded.report_id, created_at = excluded.created_at`,
            req.user.household_id, adjustment.month, JSON.stringify(adjustment.split), report.id, now());
        });
        res.json({ ok: true });
      });
      app.delete('/api/budget/overrides/:month', async (req, res) => {
        const month = req.params.month;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('Mese non valido.');
        if (month < romeToday(clock()).slice(0, 7)) fail('Un mese chiuso conserva la sua ripartizione.');
        await run('DELETE FROM budget_month_overrides WHERE household_id = ? AND month = ?', req.user.household_id, month);
        res.json({ ok: true });
      });
    },
  };
}
