import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Landmark, Plus, ShieldCheck, AlertCircle, X, Unlink } from 'lucide-react';
import { Empty, Modal, SectionHeading } from './components';
import { api } from './api';
import { readableDate } from './finance';
import type { BankAccount, FamilyState } from './types';
import type { Page } from './pages';

type Props = { data: FamilyState; act: (path: string, method: string, body?: unknown) => Promise<void>; busy: boolean; navigate: (page: Page) => void };

// Linking only: connect, disconnect, renew and sharing. Balances live in the
// overview, imported records in Entrate and Uscite; savings are split automatically.
export function Bank({ data, act, busy, navigate }: Props) {
  const [connect, setConnect] = useState<{ bank?: string; visibility?: BankAccount['visibility'] } | null>(null);
  const bank = data.bank;
  if (!bank.configured) return <section className="panel"><Empty icon={<Landmark size={26} />} title="Collegamento bancario non ancora attivo" description="Il gestore dell’app deve configurare Enable Banking sul server (ENABLE_BANKING_APP_ID e ENABLE_BANKING_PRIVATE_KEY). Dopo, ognuno potrà collegare il proprio conto in sola lettura." /></section>;
  const others = bank.accounts.filter(a => !a.mine);
  return <>
    <section className="planning-section"><div className="section-heading"><h2>I tuoi collegamenti</h2><button className="button primary" disabled={busy} onClick={() => setConnect({})}><Plus size={16} />Collega una banca</button></div>
      {bank.connections.length ? bank.connections.map(connection => {
        const accounts = bank.accounts.filter(a => a.connection_id === connection.id);
        const left = Math.floor((Date.parse(connection.valid_until) - Date.now()) / 86400000);
        const expired = connection.status === 'expired' || left < 0;
        const renew = () => setConnect({ bank: connection.bank, visibility: accounts[0]?.visibility });
        return <article className="panel bank-group" key={connection.id}>
          <div className="bank-group-heading"><div><h3>{connection.bank}</h3>
            {expired ? <div className="bank-warning"><AlertCircle size={15} /><span>Consenso scaduto o revocato.</span><button className="text-button" onClick={renew}>Rinnova</button></div>
              : left <= 14 ? <div className="bank-warning"><AlertCircle size={15} /><span>Consenso in scadenza il {readableDate(connection.valid_until.slice(0, 10))}.</span><button className="text-button" onClick={renew}>Rinnova</button></div>
              : <small>Consenso valido fino al {readableDate(connection.valid_until.slice(0, 10))}</small>}
            {connection.last_error && !expired && <div className="bank-warning"><AlertCircle size={15} /><span>{connection.last_error}</span></div>}</div>
            <button className="button secondary bank-unlink" disabled={busy} onClick={() => { if (confirm(`Scollegare ${connection.bank}? Tutti i suoi conti non verranno più letti; le registrazioni già aggiunte a Entrate e Uscite restano.`)) void act(`/bank/connections/${connection.id}`, 'DELETE').catch(() => {}); }}><Unlink size={16} />Scollega banca</button>
          </div>
          {accounts.length > 0 && <div className="recurring-grid">{accounts.map(account => <div className="recurring-card bank-card" key={account.id}>
            <div className="recurring-top"><span className="bank-badges"><span className={`badge ${account.visibility === 'shared' ? 'green' : ''}`}>{account.visibility === 'shared' ? 'Condiviso' : 'Movimenti privati'}</span>{account.savings && <span className="badge green">Risparmio</span>}</span>
              {accounts.length > 1 && <button className="icon-button danger" aria-label={`Rimuovi ${account.name}`} title="Rimuovi conto" disabled={busy} onClick={() => { if (confirm(`Rimuovere “${account.name}”? Sparirà dalla vista e dal saldo, e verranno eliminate le entrate e le uscite importate da questo conto (restano quelle inserite a mano); ${connection.bank} resta collegata. Per riaverlo dovrai scollegare e ricollegare la banca.`)) void act(`/bank/accounts/${account.id}`, 'DELETE').catch(() => {}); }}><X size={16} /></button>}</div>
            <h4>{account.name}</h4>
            <p>{account.iban_last4 ? `•••• ${account.iban_last4}` : 'Conto senza IBAN'}</p>
            <label className="bank-visibility">Con la famiglia condividi<select value={account.visibility} disabled={busy} onChange={e => void act(`/bank/accounts/${account.id}`, 'PATCH', { visibility: e.target.value }).catch(() => {})}><option value="shared">Saldo e movimenti</option><option value="balance">Saldo e totali, movimenti privati</option></select></label>
          </div>)}</div>}
        </article>;
      }) : <section className="panel"><Empty icon={<Landmark size={26} />} title="Nessun conto collegato" description="Collega il tuo conto in sola lettura: il saldo entra nel totale di famiglia e i movimenti diventano entrate e uscite del budget." action="Collega una banca" onAction={() => setConnect({})} /></section>}
    </section>
    {others.length > 0 && <section className="planning-section"><SectionHeading title="Conti degli altri membri" /><div className="recurring-grid">{others.map(account => <article className="panel recurring-card bank-card" key={account.id}>
      <div className="recurring-top"><span className="bank-badges"><span className={`badge ${account.visibility === 'shared' ? 'green' : ''}`}>{account.visibility === 'shared' ? 'Condiviso' : 'Movimenti privati'}</span>{account.savings && <span className="badge green">Risparmio</span>}</span></div>
      <h3>{account.name}</h3><p>{account.bank}{account.iban_last4 ? ` · •••• ${account.iban_last4}` : ''} · {account.owner}</p>
    </article>)}</div></section>}
    <div className="panel-tip bank-tip"><ShieldCheck size={18} /><span>Solo lettura: Family Hub legge saldo e movimenti tramite Enable Banking e non può disporre pagamenti. Le credenziali restano sul sito della tua banca. I movimenti diventano entrate e uscite; la ripartizione dei risparmi è in Impostazioni.</span></div>
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
