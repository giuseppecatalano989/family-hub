import { useState, type FormEvent } from 'react';
import { Modal } from './components';
import { parseMoney } from './finance';
import type { FamilyState } from './types';

const order = ['conservative', 'prudent', 'balanced', 'leisure', 'custom'];
export default function BudgetDialog({ data, onClose, mutate }: { data: FamilyState; onClose: () => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> }) {
  const templates = [...data.budgetTemplates].filter(t => order.includes(t.template_key)).sort((a, b) => order.indexOf(a.template_key) - order.indexOf(b.template_key));
  const current = templates.find(t => t.id === data.activeTemplateId && t.entries.every(e => data.categories.some(c => c.id === e.id && c.name === e.name && c.percentage === e.percentage)));
  const [selected, setSelected] = useState(current?.template_key || 'custom');
  const [budget, setBudget] = useState(data.categories.map(c => ({ id: c.id, name: c.name, percentage: String(c.percentage / 100) })));
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const custom = selected === 'custom';
  const sum = budget.reduce((s, c) => s + (/^\d+(?:[.,]\d{1,2})?$/.test(c.percentage) ? parseMoney(c.percentage) : NaN), 0);
  const valid = sum === 10000 && budget.every(c => c.name.trim() && Number(c.percentage.replace(',', '.')) <= 100);
  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true); setError('');
    try {
      if (custom) await mutate('/budget', 'PUT', { categories: budget.map(c => ({ ...c, percentage: parseMoney(c.percentage) })) });
      else await mutate(`/budget-templates/${templates.find(t => t.template_key === selected)!.id}/apply`, 'POST');
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }
  return <Modal title="La vostra ripartizione budget" subtitle="Scegli uno schema fisso oppure modifica Pers. secondo le vostre esigenze." onClose={onClose}><form onSubmit={e => void submit(e)}><div className="budget-presets" role="group" aria-label="Schemi di ripartizione">{templates.map(t => <button key={t.id} type="button" aria-pressed={selected === t.template_key} className={selected === t.template_key ? 'selected' : ''} onClick={() => { setSelected(t.template_key); setBudget(t.entries.map(c => ({ ...c, percentage: String(c.percentage / 100) }))); }}>{t.template_key === 'custom' ? 'Pers.' : t.name}</button>)}</div>{budget.map((c, i) => <div className="budget-edit-row" key={c.id}><span className="category-dot" style={{ background: data.categories[i].color }} /><input aria-label={`Nome categoria ${i + 1}`} value={c.name} readOnly={!custom} onChange={e => setBudget(budget.map(row => row.id === c.id ? { ...row, name: e.target.value } : row))} required maxLength={60} /><div className="percentage-input"><input aria-label={`Percentuale ${c.name}`} value={c.percentage} readOnly={!custom} onChange={e => setBudget(budget.map(row => row.id === c.id ? { ...row, percentage: e.target.value } : row))} inputMode="decimal" required /><span aria-hidden="true">%</span></div></div>)}<div className={`budget-total ${valid ? '' : 'negative'}`}><span>Totale assegnato</span><strong>{Number.isFinite(sum) ? sum / 100 : '—'}%</strong></div><p className="form-hint">{custom ? 'Pers. conserva la vostra composizione personalizzata.' : 'Questo schema è fisso. Seleziona Pers. per modificare nomi e percentuali.'}</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-footer"><button type="button" className="button secondary" disabled={pending} onClick={onClose}>Annulla</button><button className="button primary" disabled={pending || !valid}>{pending ? 'Salvataggio…' : 'Salva schema'}</button></div></form></Modal>;
}
