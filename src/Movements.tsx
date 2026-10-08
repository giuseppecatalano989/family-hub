import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Landmark, Lock, Search, Tags, CircleCheck } from 'lucide-react';
import { Empty, SectionHeading } from './components';
import { money, readableDate } from './finance';
import type { FamilyState } from './types';
import type { Page } from './pages';

type Props = { data: FamilyState; act: (path: string, method: string, body?: unknown) => Promise<void>; busy: boolean; navigate: (page: Page) => void };
const statusLabels = { stored: 'Precedente al collegamento', imported: 'Aggiunto alle registrazioni', matched: 'Già registrato a mano', transfer: 'Giroconto tra conti di famiglia' };

// Bank movements in detail; expenses without a category can be classified here.
export function Movements({ data, act, busy, navigate }: Props) {
  const [search, setSearch] = useState('');
  const bank = data.bank;
  if (!bank.accounts.length && !bank.uncategorized.length && !bank.othersUncategorized.length) return <section className="panel"><Empty icon={<Landmark size={26} />} title="Nessun conto collegato" description="Collega un conto corrente per vedere qui i movimenti della banca e assegnare loro una categoria." action="Vai a Conti bancari" onAction={() => navigate('bank')} /></section>;
  const classify = (transactionId: string, categoryId: string) => { if (categoryId) void act(`/transactions/${transactionId}/category`, 'PATCH', { categoryId }).catch(() => {}); };
  const categorySelect = (transactionId: string, value: string | null, label: string) => <select className="movement-category" aria-label={label} value={value || ''} disabled={busy} onChange={e => classify(transactionId, e.target.value)}>{!value && <option value="" disabled>Scegli una categoria</option>}{data.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>;
  const where = (m: { account: string | null; iban_last4: string | null; owner: string }, mine: boolean) => `${m.account ? `${m.account}${m.iban_last4 ? ` •••• ${m.iban_last4}` : ''}` : 'Conto non più collegato'}${mine ? '' : ` · ${m.owner}`}`;
  const query = search.trim().toLocaleLowerCase('it');
  const movements = bank.movements.filter(m => !query || `${m.description} ${m.account} ${m.owner}`.toLocaleLowerCase('it').includes(query));
  return <>
    <section className="panel planning-section transactions-panel movements-todo"><SectionHeading title={<>Da classificare{bank.uncategorized.length > 0 && <span className="heading-count">{bank.uncategorized.length}</span>}</>} />
      {bank.uncategorized.length ? bank.uncategorized.map(t => <div className="transaction-row movement-row" key={t.transaction_id}><span className="transaction-icon"><ArrowUpRight size={20} /></span><div className="transaction-description"><strong>{t.description}</strong><span>{readableDate(t.date)}<span className="dot-separator">·</span>{where(t, t.mine)}</span></div><strong className="transaction-amount">−{money(t.amount)}</strong>{categorySelect(t.transaction_id, null, `Categoria per ${t.description}`)}</div>)
        : <p className="ledger-empty movements-done"><CircleCheck size={18} />{bank.othersUncategorized.length ? 'Le tue uscite hanno tutte una categoria.' : 'Tutte le uscite hanno una categoria.'}</p>}
      {bank.othersUncategorized.map(o => <div className="panel-tip" key={o.owner}><Lock size={18} /><span>{o.count === 1 ? `1 uscita privata di ${o.owner}` : `${o.count} uscite private di ${o.owner}`} ({money(o.amount)}) {o.count === 1 ? 'è' : 'sono'} ancora da classificare: può farlo solo {o.owner}, dalla sua sezione Movimenti.</span></div>)}
      <div className="panel-tip"><Tags size={18} /><span>La categoria scelta vale anche per i prossimi movimenti dello stesso esercente o IBAN. Scegliendo Risparmio, il versamento viene ripartito sugli obiettivi.</span></div>
    </section>
    <section className="panel planning-section transactions-panel"><SectionHeading title="Movimenti del mese" />
      <div className="list-toolbar"><div className="search-input"><Search size={17} /><input aria-label="Cerca movimenti" placeholder="Cerca per descrizione o conto…" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
      {movements.length ? movements.map(m => <div className="transaction-row movement-row" key={m.id}><span className={`transaction-icon ${m.kind === 'income' ? 'income' : ''}`}>{m.kind === 'income' ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}</span><div className="transaction-description"><strong>{m.description}</strong><span>{readableDate(m.date)}<span className="dot-separator">·</span>{where(m, m.mine)}<span className="dot-separator">·</span>{statusLabels[m.status]}{m.status === 'imported' && !m.transaction_id ? ' (poi rimosso)' : ''}</span></div><strong className={`transaction-amount ${m.kind === 'income' ? 'positive' : ''}`}>{m.kind === 'income' ? '+' : '−'}{money(m.amount)}</strong>{m.classifiable && m.transaction_id ? categorySelect(m.transaction_id, m.category_id, `Categoria per ${m.description}`) : <span className="movement-category muted">{m.kind === 'income' ? 'Entrata' : m.status === 'transfer' ? 'Giroconto' : '—'}</span>}</div>)
        : <Empty icon={<Landmark size={26} />} title="Nessun movimento in questo mese" description={query ? 'Nessun movimento corrisponde alla ricerca.' : 'I movimenti contabilizzati dei conti collegati compariranno qui.'} />}
    </section>
  </>;
}
