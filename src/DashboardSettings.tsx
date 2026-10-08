import { useState } from 'react';
import { ArrowDown, ArrowUp, LayoutDashboard, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { SectionHeading } from './components';
import type { DashboardCard, FamilyState } from './types';

type Props = { data: FamilyState; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> };
type Layout = { quickActions: boolean; order: DashboardCard[]; hidden: DashboardCard[] };

const DEFAULT_ORDER: DashboardCard[] = ['income', 'expense', 'balance', 'savings', 'spending', 'home', 'goals', 'recent'];
const groups: { title: string; hint: string; cards: { id: DashboardCard; label: string }[] }[] = [
  { title: 'Indicatori in alto', hint: 'Le cifre del mese, affiancate.', cards: [{ id: 'income', label: 'Entrate del mese' }, { id: 'expense', label: 'Uscite del mese' }, { id: 'balance', label: 'Saldo del mese' }, { id: 'savings', label: 'Risparmi per gli obiettivi' }] },
  { title: 'Riquadri', hint: 'Disposti due per riga, nell’ordine scelto.', cards: [{ id: 'spending', label: 'Dove vanno le nostre uscite' }, { id: 'home', label: 'La vita di casa' }, { id: 'goals', label: 'I nostri prossimi traguardi' }, { id: 'recent', label: 'Gli ultimi movimenti' }] },
];

// Personal choices for the overview: quick buttons, the real balance line, and
// which cards to show in which order. Each change is saved at once.
export function DashboardSettings({ data, mutate }: Props) {
  const [layout, setLayout] = useState<Layout>({ quickActions: data.preferences.quickActions, ...data.preferences.dashboard });
  const [showBalance, setShowBalance] = useState(data.preferences.showBankBalance);
  const [status, setStatus] = useState<{ error?: string; saved?: boolean } | null>(null);
  async function save(change: () => Promise<unknown>, revert: () => void) {
    setStatus(null);
    try { await change(); setStatus({ saved: true }); } catch (error) { revert(); setStatus({ error: (error as Error).message }); }
  }
  function update(next: Layout) {
    const previous = layout; setLayout(next);
    void save(() => mutate('/preferences/dashboard', 'PUT', next), () => setLayout(previous));
  }
  function move(id: DashboardCard, step: -1 | 1) {
    const group = groups.find(g => g.cards.some(c => c.id === id))!.cards.map(c => c.id);
    const siblings = layout.order.filter(card => group.includes(card));
    const target = siblings[siblings.indexOf(id) + step];
    if (!target) return;
    const order = [...layout.order]; const a = order.indexOf(id); const b = order.indexOf(target);
    [order[a], order[b]] = [order[b], order[a]];
    update({ ...layout, order });
  }
  const toggle = (id: DashboardCard, visible: boolean) => update({ ...layout, hidden: visible ? layout.hidden.filter(card => card !== id) : [...layout.hidden, id] });
  const customised = layout.quickActions || layout.hidden.length > 0 || layout.order.some((id, i) => id !== DEFAULT_ORDER[i]);
  return <div className="settings-panel">
    {status?.error && <div className="form-error" role="alert">{status.error}</div>}
    {status?.saved && <p className="settings-success" role="status">Modifiche salvate.</p>}
    <section className="panel settings-card"><SectionHeading title="Pulsanti e saldo" /><div className="settings-body"><span className="settings-icon"><SlidersHorizontal size={25} /></span>
      <label className="checkbox-label"><input type="checkbox" checked={layout.quickActions} onChange={e => update({ ...layout, quickActions: e.target.checked })} />Mostra in Panoramica i pulsanti Nuova entrata e Nuova uscita</label>
      <label className="checkbox-label"><input type="checkbox" checked={showBalance} onChange={e => { const checked = e.target.checked; setShowBalance(checked); void save(() => mutate('/preferences', 'PUT', { showBankBalance: checked }), () => setShowBalance(!checked)); }} />Mostra in Panoramica, sotto il saldo del mese, quanto c’è oggi sui conti collegati</label>
      <p className="form-hint">Le scelte della Panoramica valgono solo per il tuo account. Il saldo dei conti compare quando almeno un conto è collegato.</p>
    </div></section>
    <section className="panel settings-card dashboard-cards"><div className="section-heading"><h2>Card della Panoramica</h2><button className="button secondary" disabled={!customised} onClick={() => update({ quickActions: false, order: DEFAULT_ORDER, hidden: [] })}><RotateCcw size={16} />Ripristina predefinita</button></div>
      {groups.map(group => {
        const ordered = layout.order.filter(id => group.cards.some(c => c.id === id));
        return <div className="dashboard-group" key={group.title}><h3>{group.title}</h3><p className="form-hint">{group.hint}</p>
          <ol className="dashboard-card-list">{ordered.map((id, i) => {
            const label = group.cards.find(c => c.id === id)!.label; const visible = !layout.hidden.includes(id);
            return <li key={id} className={visible ? '' : 'is-hidden'}><label className="checkbox-label"><input type="checkbox" checked={visible} onChange={e => toggle(id, e.target.checked)} />{label}</label>
              <span className="row-actions"><button className="icon-button" aria-label={`Sposta su ${label}`} disabled={i === 0} onClick={() => move(id, -1)}><ArrowUp size={16} /></button><button className="icon-button" aria-label={`Sposta giù ${label}`} disabled={i === ordered.length - 1} onClick={() => move(id, 1)}><ArrowDown size={16} /></button></span></li>;
          })}</ol></div>;
      })}
      <div className="panel-tip"><LayoutDashboard size={18} /><span>Le card nascoste restano disponibili qui: riattivale quando vuoi.</span></div>
    </section>
  </div>;
}
