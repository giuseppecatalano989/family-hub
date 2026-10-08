import { randomUUID } from 'node:crypto';
import { PLANNING_SCHEMA } from './schema.mjs';
import { dueDate } from './workflows.mjs';

const labels = ['Casa e bollette', 'Alimentari', 'Trasporti', 'Salute e famiglia', 'Svago', 'Risparmio'];
export const BUDGET_PRESETS = [
  { key: 'conservative', name: 'Conservativa', description: 'Più spazio al risparmio e agli imprevisti.', percentages: [30, 15, 10, 5, 5, 35] },
  { key: 'prudent', name: 'Prudente', description: 'Priorità alle necessità, con una riserva regolare.', percentages: [35, 20, 10, 10, 10, 15] },
  { key: 'balanced', name: 'Equilibrata', description: 'Un equilibrio tra quotidianità, piaceri e progetti.', percentages: [35, 15, 10, 5, 15, 20] },
  { key: 'leisure', name: 'Svago', description: 'Più spazio al tempo libero, mantenendo un risparmio.', percentages: [30, 15, 10, 5, 30, 10] },
];
export const currentMonth = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).format(new Date());
function nextMonth(value) {
  const [year, month] = value.split('-').map(Number);
  return `${year + (month === 12 ? 1 : 0)}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}`;
}
export function installPlanning(app, { db, one, all, run, atomic, owned, fail, text, cents, now, clock = Date.now }) {
  if (!db.cloud) db.exec(PLANNING_SCHEMA);
  function month(value) {
    if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value < '1900-01' || value > '2199-12') fail('Mese non valido.');
    return value;
  }
  async function revision(body, rule) {
    const category = rule.kind === 'expense' ? text(body.categoryId, 'Categoria', 100) : null;
    if (category) await owned('categories', category, { household_id: rule.household_id });
    if (!Number.isInteger(body.day) || body.day < 1 || body.day > 31) fail('Il giorno deve essere tra 1 e 31.');
    const effective = month(body.effectiveMonth || rule.start_month);
    const end = body.endMonth ? month(body.endMonth) : null;
    if (effective < rule.start_month || (end && end < effective)) fail('Il termine deve seguire il mese da cui vale la modifica.');
    if (typeof body.enabled !== 'boolean') fail('Stato della ricorrenza non valido.');
    return { effective, name: text(body.name, 'Nome', 120), amount: cents(body.amount), category, day: body.day, end, enabled: body.enabled ? 1 : 0 };
  }
  async function saveRevision(rule, input) {
    await run(`INSERT INTO recurring_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id, effective_month) DO UPDATE SET name = excluded.name, amount = excluded.amount, category_id = excluded.category_id, day = excluded.day, end_month = excluded.end_month, enabled = excluded.enabled`,
      randomUUID(), rule.id, input.effective, input.name, input.amount, input.category, input.day, input.end, input.enabled);
  }
  const versionFor = (versions, period) => versions.filter(v => v.effective_month <= period).at(-1);
  // Occurrences survive deletion of their transaction: a skipped month must not
  // reappear during polling, cron jobs or concurrent requests on another instance.
  async function generate(hid, target, refreshFrom) {
    const rules = await all('SELECT * FROM recurring_rules WHERE household_id = ?', hid);
    const versions = await all('SELECT v.* FROM recurring_versions v JOIN recurring_rules r ON r.id = v.rule_id WHERE r.household_id = ? ORDER BY v.effective_month', hid);
    const occurrences = await all('SELECT o.* FROM recurring_occurrences o JOIN recurring_rules r ON r.id = o.rule_id WHERE r.household_id = ?', hid);
    for (const rule of rules) {
      const history = versions.filter(v => v.rule_id === rule.id);
      const existing = new Map(occurrences.filter(o => o.rule_id === rule.id).map(o => [o.month, o]));
      // Catch up through today. A selected future month is a separate planned
      // occurrence, without generating every intermediate future month.
      const periods = [];
      for (let period = rule.start_month; period <= currentMonth(); period = nextMonth(period)) periods.push(period);
      if (target > currentMonth() && target >= rule.start_month) periods.push(target);
      if (refreshFrom) for (const period of existing.keys()) if (period >= refreshFrom && !periods.includes(period)) periods.push(period);
      for (const period of periods) {
        const version = versionFor(history, period); const occurrence = existing.get(period);
        const enabled = version?.enabled && (!version.end_month || period <= version.end_month);
        if (occurrence) {
          if (!refreshFrom || period < refreshFrom || occurrence.overridden || !occurrence.transaction_id) continue;
          if (!enabled) {
            // Remove only automatic records affected by this explicit change.
            await run('DELETE FROM recurring_occurrences WHERE id = ?', occurrence.id);
            await run('DELETE FROM transactions WHERE id = ? AND household_id = ?', occurrence.transaction_id, hid);
          } else await run('UPDATE transactions SET amount = ?, category_id = ?, description = ?, date = ? WHERE id = ? AND household_id = ?', version.amount, version.category_id, version.name, dueDate(period, version.day), occurrence.transaction_id, hid);
          continue;
        }
        if (!enabled) continue;
        const transactionId = randomUUID();
        await run('INSERT INTO transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', transactionId, hid, rule.kind, version.amount, version.category_id, version.name, dueDate(period, version.day), rule.author_id, now());
        await run('INSERT INTO recurring_occurrences VALUES (?, ?, ?, ?, 0)', randomUUID(), rule.id, period, transactionId);
      }
    }
  }
  async function materialize(hid, target = currentMonth()) { await atomic(() => generate(hid, month(target))); }
  app.post('/api/recurring', async (req, res) => {
    if (!['income', 'expense'].includes(req.body.kind)) fail('Tipo di movimento non valido.');
    const rule = { id: randomUUID(), household_id: req.user.household_id, kind: req.body.kind, start_month: month(req.body.startMonth), author_id: req.user.id };
    // Bound accidental historical imports; older transactions remain manual.
    if (Number(currentMonth().slice(0, 4)) * 12 + Number(currentMonth().slice(5)) - (Number(rule.start_month.slice(0, 4)) * 12 + Number(rule.start_month.slice(5))) > 120) fail('Una ricorrenza può iniziare al massimo dieci anni fa.');
    const input = await revision({ ...req.body, effectiveMonth: rule.start_month }, rule);
    await atomic(async () => {
      if ((await one('SELECT COUNT(*) AS count FROM recurring_rules WHERE household_id = ?', rule.household_id)).count >= 100) fail('Puoi gestire fino a 100 ricorrenze per famiglia.');
      await run('INSERT INTO recurring_rules VALUES (?, ?, ?, ?, ?, ?)', rule.id, rule.household_id, rule.kind, rule.start_month, rule.author_id, now());
      await saveRevision(rule, input); await generate(rule.household_id, currentMonth());
    });
    res.status(201).json({ id: rule.id });
  });
  app.put('/api/recurring/:id', async (req, res) => {
    await atomic(async () => {
      const rule = await owned('recurring_rules', req.params.id, req.user);
      const input = await revision(req.body, rule);
      await saveRevision(rule, input); await generate(rule.household_id, currentMonth(), input.effective);
    });
    res.json({ ok: true });
  });
  app.delete('/api/recurring/:id', async (req, res) => {
    await atomic(async () => {
      const rule = await owned('recurring_rules', req.params.id, req.user);
      await run('DELETE FROM transactions WHERE household_id = ? AND id IN (SELECT transaction_id FROM recurring_occurrences WHERE rule_id = ?)', req.user.household_id, rule.id);
      await run('DELETE FROM recurring_occurrences WHERE rule_id = ?', rule.id);
      await run('DELETE FROM recurring_versions WHERE rule_id = ?', rule.id);
      await run('DELETE FROM recurring_rules WHERE id = ? AND household_id = ?', rule.id, req.user.household_id);
    });
    res.json({ ok: true });
  });
  // Stopping a rule is a dated revision, retaining both prior months and manual corrections.
  app.post('/api/recurring/:id/stop', async (req, res) => {
    await atomic(async () => {
      const rule = await owned('recurring_rules', req.params.id, req.user);
      const effective = month(req.body.effectiveMonth);
      if (effective < rule.start_month) fail('La sospensione deve seguire il mese iniziale.');
      const previous = await one('SELECT * FROM recurring_versions WHERE rule_id = ? AND effective_month <= ? ORDER BY effective_month DESC LIMIT 1', rule.id, effective);
      await saveRevision(rule, { ...previous, effective, category: previous.category_id, end: null, enabled: 0 });
      await generate(rule.household_id, currentMonth(), effective);
    });
    res.json({ ok: true });
  });
  // Each month keeps the split in force when it closed: a change is saved for the
  // current month (the last change of a month wins) and the split used until
  // then becomes the one of every earlier month without its own.
  const romeMonth = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).format(new Date(clock()));
  const splitOf = async hid => JSON.stringify(Object.fromEntries((await all('SELECT id, percentage FROM categories WHERE household_id = ? ORDER BY position', hid)).map(c => [c.id, c.percentage])));
  async function changeSplit(hid, update) {
    await run("INSERT INTO budget_versions VALUES (?, '1900-01', ?) ON CONFLICT(household_id, effective_month) DO NOTHING", hid, await splitOf(hid));
    await update();
    await run('INSERT INTO budget_versions VALUES (?, ?, ?) ON CONFLICT(household_id, effective_month) DO UPDATE SET entries = excluded.entries', hid, romeMonth(), await splitOf(hid));
  }
  async function splitFor(hid, target) {
    const version = await one('SELECT entries FROM budget_versions WHERE household_id = ? AND effective_month <= ? ORDER BY effective_month DESC LIMIT 1', hid, target);
    return version ? JSON.parse(version.entries) : null;
  }
  async function ensureTemplates(hid) {
    const categories = await all('SELECT * FROM categories WHERE household_id = ? ORDER BY position', hid);
    for (const preset of [...BUDGET_PRESETS, { key: 'custom', name: 'Personalizzato', description: 'La vostra composizione, conservata anche dopo il ripristino.' }]) {
      const entries = categories.map((c, i) => ({ id: c.id, name: preset.key === 'custom' ? c.name : labels[i], percentage: preset.key === 'custom' ? c.percentage : preset.percentages[i] * 100 }));
      const conflict = preset.key === 'custom' ? 'DO NOTHING' : `DO UPDATE SET name = excluded.name, description = excluded.description, entries = excluded.entries
        WHERE budget_templates.entries <> excluded.entries OR budget_templates.name <> excluded.name OR budget_templates.description <> excluded.description`;
      await run(`INSERT INTO budget_templates VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(household_id, template_key) ${conflict}`, randomUUID(), hid, preset.key, preset.name, preset.description, JSON.stringify(entries));
    }
  }
  async function validatedEntries(entries, hid) {
    const categories = await all('SELECT id FROM categories WHERE household_id = ?', hid);
    if (!Array.isArray(entries) || entries.length !== categories.length || entries.some(e => !e || typeof e !== 'object') || new Set(entries.map(e => e.id)).size !== categories.length) fail('Categorie del template non valide.');
    const rows = entries.map(e => {
      if (!categories.some(c => c.id === e.id) || !Number.isInteger(e.percentage) || e.percentage < 0 || e.percentage > 10000) fail('Percentuale o categoria non valida.');
      return { id: e.id, name: text(e.name, 'Categoria', 60), percentage: e.percentage };
    });
    if (rows.reduce((s, e) => s + e.percentage, 0) !== 10000) fail('Le percentuali devono sommare esattamente il 100%.');
    return rows;
  }
  app.put('/api/budget-templates/:id', async (req, res) => {
    await atomic(async () => {
      const template = await owned('budget_templates', req.params.id, req.user);
      if (template.template_key !== 'custom') fail('Gli schemi predefiniti sono fissi. Modifica Pers. per creare la vostra ripartizione.', 403);
      const entries = await validatedEntries(req.body.entries, req.user.household_id);
      await run('UPDATE budget_templates SET entries = ? WHERE id = ?', JSON.stringify(entries), template.id);
      await run('DELETE FROM budget_settings WHERE household_id = ? AND active_template_id = ?', req.user.household_id, template.id);
    });
    res.json({ ok: true });
  });
  app.post('/api/budget-templates/:id/apply', async (req, res) => {
    await atomic(async () => {
      await ensureTemplates(req.user.household_id);
      const template = await owned('budget_templates', req.params.id, req.user);
      if (template.template_key === '50-30-20') fail('Questo schema non è più disponibile. Scegli un altro schema.', 400);
      const rows = await validatedEntries(JSON.parse(template.entries), req.user.household_id);
      await changeSplit(req.user.household_id, async () => { for (const row of rows) await run('UPDATE categories SET name = ?, percentage = ? WHERE id = ? AND household_id = ?', row.name, row.percentage, row.id, req.user.household_id); });
      await run('INSERT INTO budget_settings VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET active_template_id = excluded.active_template_id', req.user.household_id, template.id);
    });
    res.json({ ok: true });
  });
  app.post('/api/budget-templates/reset', async (req, res) => {
    await atomic(async () => {
      await run("DELETE FROM budget_settings WHERE household_id = ? AND active_template_id IN (SELECT id FROM budget_templates WHERE household_id = ? AND template_key <> 'custom')", req.user.household_id, req.user.household_id);
      await run("DELETE FROM budget_templates WHERE household_id = ? AND template_key <> 'custom'", req.user.household_id);
      await ensureTemplates(req.user.household_id);
    });
    res.json({ ok: true });
  });
  return { materialize, changeSplit, splitFor,
    async synchronizeAll() { for (const { id } of await all('SELECT id FROM households')) await materialize(id); },
    async saveCustom(hid, entries) {
      await ensureTemplates(hid);
      const custom = await one("SELECT id FROM budget_templates WHERE household_id = ? AND template_key = 'custom'", hid);
      await run('UPDATE budget_templates SET entries = ? WHERE id = ?', JSON.stringify(entries), custom.id);
      await run('INSERT INTO budget_settings VALUES (?, ?) ON CONFLICT(household_id) DO UPDATE SET active_template_id = excluded.active_template_id', hid, custom.id);
    },
    async state(user, target) {
      await atomic(() => ensureTemplates(user.household_id));
      const rules = await all('SELECT r.*, u.name AS author FROM recurring_rules r JOIN users u ON u.id = r.author_id WHERE r.household_id = ? ORDER BY r.created_at', user.household_id);
      const versions = await all('SELECT v.* FROM recurring_versions v JOIN recurring_rules r ON r.id = v.rule_id WHERE r.household_id = ? ORDER BY v.effective_month', user.household_id);
      return {
        recurring: rules.map(r => { const history = versions.filter(v => v.rule_id === r.id); const v = versionFor(history, target) || history[0]; return { ...r, ...v, id: r.id, active: !!v.enabled && target >= r.start_month && target >= v.effective_month && (!v.end_month || target <= v.end_month) }; }),
        budgetTemplates: (await all("SELECT * FROM budget_templates WHERE household_id = ? AND template_key <> '50-30-20' ORDER BY template_key", user.household_id)).map(t => ({ ...t, entries: JSON.parse(t.entries) })),
        activeTemplateId: (await one('SELECT active_template_id FROM budget_settings WHERE household_id = ?', user.household_id))?.active_template_id || null,
      };
    },
  };
}
