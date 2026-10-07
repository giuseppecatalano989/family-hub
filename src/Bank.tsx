import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Landmark, RefreshCw, Trash2, Plus, ShieldCheck, ArrowDownLeft, ArrowUpRight, AlertCircle } from 'lucide-react';
import { Empty, Modal, SectionHeading } from './components';
import { api } from './api';
import { money, readableDate } from './finance';
import type { BankAccount, FamilyState } from './types';

type Props = { data: FamilyState; act: (path: string, method: string, body?: unknown) => Promise<void>; busy: boolean };
const statusLabels = { stored: 'Precedente al collegamento', imported: 'Aggiunto alle registrazioni', matched: 'Già registrato a mano', transfer: 'Giroconto tra conti di famiglia' };
const dateTime = (value: string) => new Intl.DateTimeFormat('it-IT', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const daysLeft = (account: BankAccount) => Math.floor((Date.parse(account.valid_until) - Date.now()) / 86400000);

export function Bank({ data, act, busy }: Props) {
  const [connect, setConnect] = useState<{ bank?: string; visibility?: BankAccount['visibility'] } | null>(null);
  const bank = data.bank;
  if (!bank.configured) return <section className="panel"><Empty icon={<Landmark size={26} />} title="Collegamento bancario non ancora attivo" description="Il gestore dell’app deve configurare Enable Banking sul server (ENABLE_BANKING_APP_ID e ENABLE_BANKING_PRIVATE_KEY). Dopo, ognuno potrà collegare il proprio conto in sola lettura." /></section>;
  const accounts = new Map(bank.accounts.map(a => [a.id, a]));
  const shared = bank.accounts.filter(a => a.visibility === 'shared').length;
  return <>
    <div className="mini-stats"><div><span>Saldo familiare</span><strong className={bank.total < 0 ? 'negative' : 'positive'}>{money(bank.total)}</strong></div><div><span>Conti collegati</span><strong>{bank.accounts.length}</strong></div><div><span>Con movimenti condivisi</span><strong>{shared}</strong></div></div>
    <section className="planning-section"><div className="section-heading"><h2>I conti della famiglia</h2><button className="button primary" disabled={busy} onClick={() => setConnect({})}><Plus size={16} />Collega una banca</button></div>
      {bank.accounts.length ? <div className="recurring-grid">{bank.accounts.map(account => {
        const left = daysLeft(account);
        const expired = account.status === 'expired' || left < 0;
        return <article className="panel recurring-card bank-card" key={account.id}>
          <div className="recurring-top"><span className={`badge ${account.visibility === 'shared' ? 'green' : ''}`}>{account.visibility === 'shared' ? 'Condiviso' : 'Movimenti privati'}</span>{account.mine && <div className="row-actions">
            <button className="icon-button" aria-label={`Aggiorna ${account.name}`} title="Aggiorna" disabled={busy || expired} onClick={() => void act(`/bank/connections/${account.connection_id}/sync`, 'POST').catch(() => {})}><RefreshCw size={16} /></button>
            <button className="icon-button danger" aria-label={`Scollega ${account.bank}`} title="Scollega" disabled={busy} onClick={() => { if (confirm(`Scollegare ${account.bank}? Saldo e copie dei movimenti bancari verranno rimossi; le registrazioni già aggiunte a Entrate e Uscite restano.`)) void act(`/bank/connections/${account.connection_id}`, 'DELETE').catch(() => {}); }}><Trash2 size={16} /></button>
          </div>}</div>
          <h3>{account.name}</h3>
          <strong className={`recurring-amount ${account.balance !== null && account.balance < 0 ? 'negative' : ''}`}>{account.balance === null ? '—' : money(account.balance)}</strong>
          <p>{account.bank}{account.iban_last4 ? ` · •••• ${account.iban_last4}` : ''} · {account.mine ? 'il tuo conto' : account.owner}</p>
          <small>{account.balance_kind === 'available' ? 'Saldo disponibile' : account.balance_kind === 'booked' ? 'Saldo contabile' : 'Saldo non ancora disponibile'}{account.balance_at ? ` · aggiornato ${dateTime(account.balance_at)}` : ''}</small>
          {account.currency !== 'EUR' && <small>Conto in {account.currency}: escluso dal totale.</small>}
          {expired ? <div className="bank-warning"><AlertCircle size={15} /><span>Consenso scaduto o revocato.</span>{account.mine && <button className="text-button" onClick={() => setConnect({ bank: account.bank, visibility: account.visibility })}>Ricollega</button>}</div>
            : left <= 14 ? <div className="bank-warning"><AlertCircle size={15} /><span>Consenso in scadenza il {readableDate(account.valid_until.slice(0, 10))}.</span>{account.mine && <button className="text-button" onClick={() => setConnect({ bank: account.bank, visibility: account.visibility })}>Rinnova</button>}</div>
            : <small>Consenso valido fino al {readableDate(account.valid_until.slice(0, 10))}</small>}
          {account.mine && account.last_error && !expired && <div className="bank-warning"><AlertCircle size={15} /><span>{account.last_error}</span></div>}
          {account.mine && <label className="bank-visibility">Con la famiglia condividi<select value={account.visibility} disabled={busy} onChange={e => void act(`/bank/accounts/${account.id}`, 'PATCH', { visibility: e.target.value }).catch(() => {})}><option value="shared">Saldo e movimenti</option><option value="balance">Saldo e totali, movimenti privati</option></select></label>}
        </article>;
      })}</div> : <section className="panel"><Empty icon={<Landmark size={26} />} title="Nessun conto collegato" description="Collega il tuo conto in sola lettura: il saldo entra nel totale di famiglia e i movimenti diventano entrate e uscite del budget." action="Collega una banca" onAction={() => setConnect({})} /></section>}
    </section>
    <section className="panel planning-section transactions-panel"><SectionHeading title="Movimenti bancari del mese" />
      {bank.movements.length ? bank.movements.map(m => { const account = accounts.get(m.account_id); return <div className="transaction-row" key={m.id}><span className={`transaction-icon ${m.kind === 'income' ? 'income' : ''}`}>{m.kind === 'income' ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}</span><div className="transaction-description"><strong>{m.description}</strong><span>{statusLabels[m.status]}{m.status === 'imported' && !m.transaction_id ? ' (poi rimosso)' : ''}<span className="dot-separator">·</span>{readableDate(m.date)}</span></div><span className="transaction-author">{account ? `${account.bank}${account.mine ? '' : ` · ${account.owner}`}` : ''}</span><strong className={`transaction-amount ${m.kind === 'income' ? 'positive' : ''}`}>{m.kind === 'income' ? '+' : '−'}{money(m.amount)}</strong></div>; })
        : <Empty icon={<Landmark size={26} />} title="Nessun movimento bancario in questo mese" description={`Compariranno qui i movimenti contabilizzati dei conti condivisi${bank.accounts.some(a => a.mine) ? ' e dei tuoi conti' : ''}.`} />}
      <div className="panel-tip"><ShieldCheck size={18} /><span>Solo lettura: Family Hub legge saldo e movimenti tramite Enable Banking e non può disporre pagamenti. Le credenziali restano sul sito della tua banca. I movimenti dei conti con movimenti privati entrano nel budget, ma gli altri membri vedono solo i totali per categoria. Mentre l’app è aperta i tuoi conti si aggiornano ogni 5 minuti; quelli degli altri membri fino a quattro volte al giorno.</span></div>
    </section>
    {connect && <ConnectDialog key={connect.bank || 'new'} initial={connect} onClose={() => setConnect(null)} />}
  </>;
}

function ConnectDialog({ initial, onClose }: { initial: { bank?: string; visibility?: BankAccount['visibility'] }; onClose: () => void }) {
  const [banks, setBanks] = useState<{ name: string }[] | null>(null);
  const [search, setSearch] = useState(initial.bank || '');
  const [selected, setSelected] = useState(initial.bank || '');
  const [visibility, setVisibility] = useState<BankAccount['visibility']>(initial.visibility || 'shared');
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  useEffect(() => { let alive = true; api<{ banks: { name: string }[] }>('/bank/banks').then(r => { if (alive) setBanks(r.banks); }).catch(e => { if (alive) setError((e as Error).message); }); return () => { alive = false; }; }, []);
  const filtered = useMemo(() => (banks || []).filter(b => b.name.toLocaleLowerCase('it').includes(search.trim().toLocaleLowerCase('it'))).slice(0, 80), [banks, search]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError('');
    try { const { url } = await api<{ url: string }>('/bank/connections', 'POST', { bank: selected, visibility }); window.location.assign(url); }
    catch (e) { setError((e as Error).message); setPending(false); }
  }
  return <Modal title={initial.bank ? 'Rinnova il collegamento' : 'Collega una banca'} subtitle="Accesso in sola lettura a saldo e movimenti." onClose={onClose}><form onSubmit={e => void submit(e)}>
    <label>Cerca la tua banca<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Ad esempio: Intesa Sanpaolo" autoComplete="off" /></label>
    <label>Banca<select value={selected} onChange={e => setSelected(e.target.value)} required size={Math.min(6, Math.max(2, filtered.length))} disabled={!banks}><option value="" disabled>{banks ? filtered.length ? 'Seleziona dall’elenco' : 'Nessuna banca trovata' : 'Caricamento delle banche…'}</option>{filtered.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}</select></label>
    <fieldset className="bank-choice"><legend>Cosa condividi con la famiglia</legend>
      <label className="checkbox-label"><input type="radio" name="visibility" checked={visibility === 'shared'} onChange={() => setVisibility('shared')} />Saldo e movimenti: tutti vedono le operazioni, che da questo mese diventano entrate e uscite della famiglia</label>
      <label className="checkbox-label"><input type="radio" name="visibility" checked={visibility === 'balance'} onChange={() => setVisibility('balance')} />Movimenti privati: le operazioni entrano nel budget, ma gli altri vedono solo saldo e totali per categoria</label>
    </fieldset>
    <p className="form-hint">Verrai indirizzato al sito della banca per autorizzare la sola lettura. Family Hub non riceve le tue credenziali e non può disporre pagamenti. Il consenso dura fino a 180 giorni, poi va rinnovato.</p>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-footer"><button type="button" className="button secondary" disabled={pending} onClick={onClose}>Annulla</button><button className="button primary" disabled={pending || !selected}>{pending ? 'Apertura della banca…' : 'Continua sul sito della banca'}</button></div>
  </form></Modal>;
}
