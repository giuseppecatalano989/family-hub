import { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutDashboard, ArrowLeftRight, ChartPie, Target, ShoppingBasket, StickyNote, Plus, Minus, UserRound, LogOut, Menu, X, ChevronLeft, ChevronRight, Heart, CircleCheck, AlertCircle, RefreshCw, CalendarClock, Utensils, ShieldCheck, Wallet, Recycle, Landmark } from 'lucide-react';
import { Incomes, Expenses, PlanningDialog } from './Planning';
import { Waste, WasteDialog } from './Waste';
import { Bank } from './Bank';
import Auth from './Auth';
import Account from './Account';
import Dialogs from './Dialogs';
import WorkflowDialog from './WorkflowDialog';
import { Deadlines, DeadlineDialog } from './Deadlines';
import { Meals, Backups } from './WorkflowPages';
import { monday, deadlineStatus } from './schedule';
import { Logo } from './components';
import { api, ApiError, setCsrf } from './api';
import { localDate } from './finance';
import { Overview, Budget, Goals, Shopping, Notes, type Dialog, type Page } from './pages';
import type { FamilyState, User } from './types';

const navigation = [
  { id: 'overview', label: 'Panoramica', icon: LayoutDashboard },
  { id: 'budget', label: 'Ripartizione budget', icon: ChartPie },
  { id: 'incomes', label: 'Entrate', icon: Wallet },
  { id: 'expenses', label: 'Uscite', icon: ArrowLeftRight },
  { id: 'bank', label: 'Conti bancari', icon: Landmark },
  { id: 'bills', label: 'Scadenze', icon: CalendarClock },
  { id: 'goals', label: 'Obiettivi', icon: Target },
  { id: 'shopping', label: 'Lista della spesa', icon: ShoppingBasket },
  { id: 'meals', label: 'Menu settimanale', icon: Utensils },
  { id: 'waste', label: 'Conferimento rifiuti', icon: Recycle },
  { id: 'notes', label: 'Lavagna', icon: StickyNote },
  { id: 'backups', label: 'Backup', icon: ShieldCheck },
] as const;
const pageCopy = {
  waste: ['Ogni rifiuto, nel giorno giusto.', 'Il calendario di conferimento condiviso con la famiglia.'],
  incomes: ['Le entrate della famiglia.', 'Redditi occasionali e ricorrenti, in un unico posto.'],
  expenses: ['Le uscite della famiglia.', 'Spese occasionali e ricorrenti, in un unico posto.'],
  bank: ['I conti di famiglia.', 'Saldi e movimenti bancari, in sola lettura.'],
  account: ['Il tuo account.', 'Profilo, accesso e impostazioni della famiglia.'],
  bills: ['Le scadenze, senza pensieri.', 'Impegni e promemoria condivisi, con eventuali pagamenti.'],
  meals: ['Cosa c’è di buono?', 'Un menu condiviso per organizzare pasti e spesa.'],
  backups: ['Una copia per stare sereni.', 'Conservate le cose importanti della vostra famiglia.'],
  overview: ['La nostra casa, in ordine.', 'Un’occhiata al mese e a tutto quello che conta.'],
  budget: ['Ripartizione budget.', 'Un piano semplice per le spese della famiglia.'],
  goals: ['Facciamo spazio ai progetti.', 'Piccoli passi di oggi, traguardi di domani.'],
  shopping: ['Cosa portiamo a casa?', 'Una lista condivisa, meno cose da dimenticare.'],
  notes: ['Le cose da ricordare.', 'Appunti, idee e documenti. Il vostro punto d’incontro.'],
};
function pageFromHash(): Page {
  const value = window.location.hash.slice(1);
  if (value === 'transactions' || value === 'recurring') return 'expenses';
  return value === 'account' || navigation.some(n => n.id === value) ? value as Page : 'overview';
}
export default function App() {
  const [authGeneration, setAuthGeneration] = useState(0);
  const [recovering, setRecovering] = useState(() => new URLSearchParams(window.location.hash.slice(1)).has('reset'));
  const [user, setUser] = useState<User | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [bootError, setBootError] = useState('');
  const [data, setData] = useState<FamilyState | null>(null);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [month, setMonth] = useState(localDate().slice(0, 7));
  const [week, updateWeek] = useState(monday(localDate()));
  const setWeek = (value: string) => { if (value >= '1900-01-01' && value <= '2199-12-25') updateWeek(value); };
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState(true);
  const [dataError, setDataError] = useState('');
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const requestId = useRef(0);
  const pendingWrites = useRef(0);
  const closeDialog = useCallback(() => setDialog(null), []);
  const loadSession = useCallback(async () => {
    setSessionLoading(true); setBootError('');
    try { const session = await api<{ user: User | null; csrf?: string }>('/session'); setUser(session.user); setCsrf(session.csrf || ''); }
    catch (error) { setBootError((error as Error).message); }
    finally { setSessionLoading(false); }
  }, []);
  useEffect(() => { void loadSession(); }, [loadSession]);
  useEffect(() => {
    // Outcome of the bank redirect; the parameter is removed from the address bar.
    const outcome = new URLSearchParams(window.location.search).get('banca');
    if (!outcome) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    const messages: Record<string, [string, boolean]> = {
      collegato: ['Conto collegato: saldo e movimenti sono aggiornati.', false],
      'collegato-errore': ['Conto collegato, ma il primo aggiornamento non è riuscito. Riprova da Conti bancari.', true],
      annullato: ['Collegamento annullato sul sito della banca.', true],
      'nessun-conto': ['La banca non ha condiviso alcun conto. Riprova selezionando almeno un conto.', true],
    };
    const [message, error] = messages[outcome] || ['Collegamento non riuscito o scaduto. Riprova da Conti bancari.', true];
    setToast({ message, error });
  }, []);
  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const next = await api<FamilyState>(`/state?month=${month}&week=${week}`);
      if (id === requestId.current) { setData(next); setSynced(true); setDataError(''); }
    } catch (error) {
      if (id === requestId.current) {
        setSynced(false); setDataError((error as Error).message);
        if (error instanceof ApiError && error.status === 401) { setUser(null); setData(null); setDialog(null); setCsrf(''); }
      }
      throw error;
    }
  }, [month, week]);
  useEffect(() => {
    if (!user) return;
    setData(null);
    void refresh().catch(() => {});
    const update = () => { if (!document.hidden && !pendingWrites.current) void refresh().catch(() => {}); };
    const interval = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    return () => { requestId.current++; window.clearInterval(interval); window.removeEventListener('focus', update); };
  }, [user?.id, refresh]);
  useEffect(() => { const handler = () => { setPage(pageFromHash()); if (new URLSearchParams(window.location.hash.slice(1)).has('reset')) { setAuthGeneration(n => n + 1); setRecovering(true); } }; window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  useEffect(() => { document.title = `${page === 'account' ? 'Il tuo account' : navigation.find(n => n.id === page)?.label || 'Family Hub'} · Family Hub`; }, [page]);
  useEffect(() => { if (!toast || toast.error) return; const timer = setTimeout(() => setToast(null), 4000); return () => clearTimeout(timer); }, [toast]);
  function navigate(next: Page) { window.location.hash = next; setPage(next); setMobileMenu(false); window.scrollTo(0, 0); }
  async function mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
    pendingWrites.current++;
    try {
      const result = await api<T>(path, method, body);
      // A committed change remains successful even if the subsequent refresh fails.
      if (path !== '/logout') {
        try { await refresh(); } catch { setToast({ message: 'Modifica salvata. La connessione per aggiornare la vista è interrotta: riprova tra poco.', error: true }); }
      }
      return result;
    } finally { pendingWrites.current--; }
  }
  async function act(path: string, method: string, body?: unknown) {
    setBusy(true);
    try { await mutate(path, method, body); }
    catch (error) { setToast({ message: (error as Error).message, error: true }); throw error; }
    finally { setBusy(false); }
  }
  function moveMonth(delta: number) {
    const [year, current] = month.split('-').map(Number);
    const date = new Date(year, current - 1 + delta, 1, 12);
    const next = localDate(date).slice(0, 7);
    if (next >= '1900-01' && next <= '2199-12') setMonth(next);
  }
  if (sessionLoading) return <div className="loading-page"><Logo /><RefreshCw className="spin" size={24} /><p>Apriamo le porte di casa…</p></div>;
  if (bootError) return <div className="loading-page"><Logo /><AlertCircle size={30} /><h2>Non riusciamo a raggiungere casa</h2><p>{bootError}</p><button className="button primary" onClick={() => void loadSession()}>Riprova</button></div>;
  if (!user || recovering) return <Auth key={authGeneration} onReset={() => { setUser(null); setData(null); setCsrf(''); setDialog(null); }} onLogin={next => { setUser(next); setData(null); setRecovering(false); }} />;
  const financial = ['overview', 'budget', 'bills', 'incomes', 'expenses', 'bank'].includes(page);
  const badge = page === 'shopping' ? data?.shopping.filter(s => !s.checked).length : page === 'notes' ? data?.notes.length : undefined;
  const components = { bank: Bank, waste: Waste, account: Account, incomes: Incomes, expenses: Expenses, overview: Overview, budget: Budget, goals: Goals, shopping: Shopping, notes: Notes, bills: Deadlines, meals: Meals, backups: Backups };
  const Content = components[page];
  const date = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  return <div className="app-layout">{mobileMenu && <button className="sidebar-overlay" aria-label="Chiudi menu" onClick={() => setMobileMenu(false)} />}<aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`}><div className="sidebar-brand"><button className="brand-link" aria-label="Family Hub: vai alla panoramica" onClick={() => navigate('overview')}><Logo /></button></div><div className="family-switch"><span className="family-avatar">{data?.household.name.slice(0, 1) || 'C'}</span><div><strong>{data?.household.name || 'Il nostro spazio'}</strong><span>{data?.members.length || 1} {data?.members.length === 1 ? 'membro' : 'membri'} della famiglia</span></div></div><span className="nav-label">IL NOSTRO SPAZIO</span><nav aria-label="Navigazione principale">{navigation.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-label={item.label} aria-description={item.id === 'shopping' && data ? `${data.shopping.filter(s => !s.checked).length} prodotti da acquistare` : undefined} aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={20} strokeWidth={1.7} /><span>{item.label}</span>{item.id === 'shopping' && !!data?.shopping.filter(s => !s.checked).length && <small>{data.shopping.filter(s => !s.checked).length}</small>}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-tip"><Heart size={20} strokeWidth={1.5} /><strong>Si fa meglio, insieme.</strong><p>Una piccola abitudine oggi.<br />Più serenità domani.</p></div><div className="sidebar-user"><button className="sidebar-account" onClick={() => navigate('account')} aria-label="Apri impostazioni account"><span className="avatar">{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><span>Il tuo account</span></div></button><button className="icon-button logout-button" onClick={() => { if (!busy) void act('/logout', 'POST').then(() => { setUser(null); setData(null); setDialog(null); setCsrf(''); }).catch(() => {}); }} disabled={busy} aria-label="Esci dal tuo account" title="Esci"><LogOut size={17} /></button></div></div></aside><div className="main-column"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-toggle" aria-label="Apri menu" onClick={() => setMobileMenu(true)}><Menu size={21} /></button><button className="brand-link" aria-label="Family Hub: vai alla panoramica" onClick={() => navigate('overview')}><Logo /></button></div><div className="topbar-right"><button className="button secondary account-button" onClick={() => navigate('account')} aria-label="Il tuo account"><UserRound size={17} /><span>Il tuo account</span></button></div></header><main><div className="page-greeting"><span className="eyebrow">{page === 'overview' ? `CIAO ${user.name.split(' ')[0].toLocaleUpperCase('it')}` : 'IL VOSTRO SPAZIO DI FAMIGLIA'}</span><span className="today">{date}</span></div><div className="page-heading"><div><h1>{pageCopy[page][0]}{badge ? <span className="heading-count">{badge}</span> : null}</h1><p>{pageCopy[page][1]}</p></div><div className={`page-actions ${page === 'overview' ? 'overview-actions' : ''}`}>{financial && <div className="month-picker"><button className="icon-button" aria-label="Mese precedente" onClick={() => moveMonth(-1)}><ChevronLeft size={16} /></button><label><span className="sr-only">Mese selezionato</span><input type="month" value={month} min="1900-01" max="2199-12" onChange={e => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) setMonth(e.target.value); }} /></label><button className="icon-button" aria-label="Mese successivo" onClick={() => moveMonth(1)}><ChevronRight size={16} /></button></div>}{page === 'overview' ? <div className="dashboard-quick-actions"><button className="button quick-income" disabled={!data} onClick={() => setDialog({ type: 'transaction', kind: 'income' })}><Plus size={17} />Nuova entrata</button><button className="button quick-expense" disabled={!data} onClick={() => setDialog({ type: 'transaction', kind: 'expense' })}><Minus size={17} />Nuova uscita</button></div> : !['shopping', 'backups', 'account', 'budget', 'bank'].includes(page) && <button className="button primary" disabled={!data} onClick={() => setDialog(page === 'waste' ? { type: 'waste' } : page === 'incomes' ? { type: 'transaction', kind: 'income' } : page === 'expenses' ? { type: 'transaction', kind: 'expense' } : page === 'goals' ? { type: 'goal' } : page === 'notes' ? { type: 'note' } : page === 'bills' ? { type: 'deadline' } : { type: 'meal' })}><Plus size={17} />{page === 'waste' ? 'Nuova tipologia' : page === 'incomes' ? 'Nuova entrata' : page === 'expenses' ? 'Nuova uscita' : page === 'goals' ? 'Nuovo obiettivo' : page === 'notes' ? 'Nuovo appunto' : page === 'bills' ? 'Nuova scadenza' : 'Pianifica pasto'}</button>}</div></div>{page === 'overview' && data && data.deadlines.some(b => !b.managed && ['soon', 'overdue'].includes(deadlineStatus(b).key)) && <div className="budget-alert"><CalendarClock size={18} /><span>{data.deadlines.filter(b => !b.managed && ['soon', 'overdue'].includes(deadlineStatus(b).key)).length} scadenze da controllare nel mese selezionato.</span><button className="text-button" onClick={() => navigate('bills')}>Vedi scadenze<ChevronRight size={16} /></button></div>}{dataError && <div className="budget-alert"><AlertCircle size={18} /><span>{dataError}</span><button className="text-button" onClick={() => void refresh().catch(() => {})}>Riprova</button></div>}{data ? <Content data={data} user={user} onUser={setUser} mutate={mutate} open={setDialog} navigate={navigate} act={act} busy={busy} month={month} week={week} setWeek={setWeek} /> : !dataError && <div className="content-loading"><RefreshCw className="spin" size={24} /><p>Mettiamo tutto al suo posto…</p></div>}<footer className="main-footer"><span><Heart size={13} />Fatto per la vita di tutti i giorni.</span><Logo small /></footer></main></div>{dialog && data && (dialog.type === 'waste' ? <WasteDialog key={dialog.schedule?.id || dialog.name || 'new'} dialog={dialog} onClose={closeDialog} mutate={mutate} /> : dialog.type === 'recurring' || dialog.type === 'transaction' ? <PlanningDialog key={dialog.type + (dialog.type === 'recurring' ? dialog.rule?.id || '' : dialog.transaction?.id || dialog.kind || '')} dialog={dialog} data={data} month={month} onClose={closeDialog} mutate={mutate} /> : dialog.type === 'deadline' || dialog.type === 'manage' ? <DeadlineDialog key={dialog.type + dialog.deadline?.id} dialog={dialog} data={data} month={month} onClose={closeDialog} mutate={mutate} /> : dialog.type === 'meal' ? <WorkflowDialog key={dialog.type} dialog={dialog} data={data} month={month} week={week} onClose={closeDialog} mutate={mutate} /> : <Dialogs key={dialog.type + ('note' in dialog ? dialog.note?.id || '' : '')} dialog={dialog} data={data} onClose={closeDialog} mutate={mutate} />)}{toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="alert">{toast.error ? <AlertCircle size={19} /> : <CircleCheck size={19} />}<span>{toast.message}</span><button className="icon-button" aria-label="Chiudi messaggio" onClick={() => setToast(null)}><X size={17} /></button></div>}</div>;
}
