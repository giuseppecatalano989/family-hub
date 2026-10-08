import { useState, type FormEvent } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Modal } from './components';
import { money, parseMoney, toInput } from './finance';
import type { FamilyState } from './types';

type Props = { goalId: string; data: FamilyState; onClose: () => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> };
export default function SavingsDialog({ goalId, data, onClose, mutate }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const goal = data.goals.find(item => item.id === goalId);
  const contributions = data.contributions.filter(item => item.goal_id === goalId);
  function edit(id: string | null, value = '') { setEditing(id); setAmount(value); setError(''); setNotice(''); }
  async function save(path: string, method: string, body?: unknown) {
    setPending(true); setError(''); setNotice('');
    try {
      await mutate(path, method, body);
      setEditing(null); setAmount('');
      setNotice(method === 'DELETE' ? 'Accantonamento eliminato.' : editing ? 'Importo aggiornato.' : 'Risparmio aggiunto.');
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const value = parseMoney(amount);
      const path = editing === 'initial' ? `/goals/${goalId}/initial-savings` : `/goals/${goalId}/contributions${editing ? `/${editing}` : ''}`;
      void save(path, editing ? 'PUT' : 'POST', { amount: value });
    } catch (error) { setError((error as Error).message); }
  }
  if (!goal) return <Modal title="Risparmi dell’obiettivo" onClose={onClose}><p>L’obiettivo non è più disponibile.</p></Modal>;
  return <Modal title="Risparmi dell’obiettivo" subtitle={goal.title} onClose={onClose}>
    <div className="contribution-status"><span>Già accantonato</span><strong>{money(goal.saved)} <small>di {money(goal.target)}</small></strong></div>
    <form onSubmit={submit}>
      <label>{editing === 'initial' ? 'Importo iniziale (€)' : editing ? 'Importo accantonato (€)' : 'Quanto avete messo da parte? (€)'}<input name="amount" value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" placeholder="0,00" pattern="[0-9]+([.,][0-9]{1,2})?" required disabled={pending} /></label>
      <p className="form-hint">Gli accantonamenti aggiornano il progresso dell’obiettivo. Per conteggiarli anche nel budget mensile, aggiungi un movimento nella categoria dedicata al risparmio.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <p className="savings-notice" role="status">{notice}</p>}
      <div className="savings-editor-actions">{editing && <button type="button" className="button secondary" disabled={pending} onClick={() => edit(null)}>Annulla modifica</button>}<button className="button primary" disabled={pending}>{pending ? 'Salvataggio…' : editing ? 'Salva importo' : 'Aggiungi risparmio'}</button></div>
    </form>
    <section className="savings-history" aria-label="Accantonamenti registrati">
      <h3>Accantonamenti registrati</h3>
      <div className="savings-row"><div className="savings-row-main"><strong>Importo iniziale</strong><span>Già presente alla creazione</span></div><strong className="savings-amount">{money(goal.initial_saved)}</strong><div className="row-actions"><button type="button" className="icon-button" aria-label="Modifica importo iniziale" disabled={pending} onClick={() => edit('initial', toInput(goal.initial_saved))}><Pencil size={16} /></button><button type="button" className="icon-button danger" aria-label="Elimina importo iniziale" disabled={pending || goal.initial_saved === 0} onClick={() => { if (confirm(`Azzerare l’importo iniziale di ${money(goal.initial_saved)}? Gli altri accantonamenti saranno mantenuti.`)) void save(`/goals/${goalId}/initial-savings`, 'DELETE'); }}><Trash2 size={16} /></button></div></div>
      {contributions.map(item => <div className="savings-row" key={item.id}><div className="savings-row-main"><strong>{item.automatic ? 'Ripartizione automatica' : 'Accantonamento'}</strong><span>{new Date(item.created_at).toLocaleDateString('it-IT')}{item.automatic ? ' · dal saldo dei conti risparmio' : ` · ${item.author}`}</span></div><strong className="savings-amount">{money(item.amount)}</strong><div className="row-actions"><button type="button" className="icon-button" aria-label={`Modifica accantonamento di ${money(item.amount)}`} disabled={pending} onClick={() => edit(item.id, toInput(item.amount))}><Pencil size={16} /></button><button type="button" className="icon-button danger" aria-label={`Elimina accantonamento di ${money(item.amount)}`} disabled={pending} onClick={() => { if (confirm(`Eliminare l’accantonamento di ${money(item.amount)} dall’obiettivo “${goal.title}”?`)) void save(`/goals/${goalId}/contributions/${item.id}`, 'DELETE'); }}><Trash2 size={16} /></button></div></div>)}
    </section>
    <div className="modal-footer"><button type="button" className="button secondary" disabled={pending} onClick={onClose}>Chiudi</button></div>
  </Modal>;
}
