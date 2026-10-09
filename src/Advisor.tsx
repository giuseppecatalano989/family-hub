import { useState } from 'react';
import { AlertCircle, CalendarClock, CircleCheck, FileText, Info, Repeat, RefreshCw, Scissors, Sparkles, Target } from 'lucide-react';
import { Empty, Modal, SectionHeading } from './components';
import { money } from './finance';
import type { AdvisorReport, FamilyState } from './types';

type Act = (path: string, method: string, body?: unknown) => Promise<void>;
const monthName = (month: string) => new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00`));
const shortDay = (date: string) => new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`));
const tipIcons = { avoid: Scissors, adjust: CalendarClock, goal: Target, info: Info };

// The latest weekly and monthly reports: figures from the server, advice from
// Claude. A new monthly report starts the month without a weekly one.
function AdvisorReports({ data, act, busy }: { data: FamilyState; act: Act; busy: boolean }) {
  const { advisor } = data;
  if (!advisor.weekly && !advisor.monthly) return <>
    {advisor.running ? <p className="advice-running" role="status"><RefreshCw className="spin" size={15} />Stiamo preparando il primo report: compare qui tra poco.</p>
      : <Empty icon={<FileText size={26} />} title="Ancora nessun report" description="Arrivano da soli: ogni lunedì quello della settimana, il 1° del mese il riepilogo del mese chiuso." />}
  </>;
  return <div className="advice-reports">
    {advisor.running && <p className="advice-running" role="status"><RefreshCw className="spin" size={15} />Stiamo preparando un nuovo report: compare qui tra poco.</p>}
    <section aria-label="Report settimanale">
      {advisor.weekly ? <Report report={advisor.weekly} data={data} act={act} busy={busy} /> : <p className="advice-waiting"><span className="eyebrow">SETTIMANA</span>È iniziato un nuovo mese: il primo report settimanale arriva lunedì.</p>}</section>
    {advisor.monthly && <section aria-label="Report mensile"><Report report={advisor.monthly} data={data} act={act} busy={busy} /></section>}
    <p className="advice-note"><Sparkles size={15} />Preparati con Claude. Le cifre sono calcolate dall’app sui vostri movimenti.</p>
  </div>;
}

// Optional overview card with the same reports as the report button.
export function AdvisorCard({ data, act, busy }: { data: FamilyState; act: Act; busy: boolean }) {
  return <section className="panel advice-panel"><div className="section-heading"><h2>Consigli del budget</h2></div><AdvisorReports data={data} act={act} busy={busy} /></section>;
}

// The report button beside the month: it lights up when a report has arrived
// that this account has not opened yet.
export function AdvisorButton({ data, act, busy, mutate }: { data: FamilyState; act: Act; busy: boolean; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> }) {
  const { advisor } = data;
  const [open, setOpen] = useState(false);
  const newest = [advisor.weekly, advisor.monthly].flatMap(r => r ? [r.createdAt] : []).sort().at(-1);
  function show() {
    setOpen(true);
    if (advisor.unread && newest) void mutate('/advisor/read', 'POST', { seen: newest }).catch(() => {});
  }
  return <>
    <button type="button" className={`icon-button report-button ${advisor.unread ? 'has-new' : ''}`} aria-label={advisor.unread ? 'Report del budget: nuovo report da leggere' : 'Report del budget'} title="Report del budget" onClick={show}><FileText size={19} />{advisor.unread && <span className="report-dot" aria-hidden="true" />}</button>
    {open && <Modal title="Report del budget" subtitle="L’ultimo report della settimana e quello del mese." onClose={() => setOpen(false)}><AdvisorReports data={data} act={act} busy={busy} /></Modal>}
  </>;
}

function Report({ report, data, act, busy }: { report: AdvisorReport; data: FamilyState; act: Act; busy: boolean }) {
  const changed = report.adjustment ? data.categories.filter(c => report.adjustment!.split[c.id] !== c.percentage) : [];
  return <div className="advice-body">
    <span className="eyebrow">{report.kind === 'weekly' && report.week ? `SETTIMANA DAL ${shortDay(report.week.from)} AL ${shortDay(report.week.to)}`.toLocaleUpperCase('it') : `MESE DI ${monthName(report.month)}`.toLocaleUpperCase('it')}</span>
    <h3>{report.headline}</h3>
    {report.summary && <p className="advice-summary">{report.summary}</p>}
    {report.alerts.length > 0 && <ul className="advice-alerts">{report.alerts.slice(0, 3).map(a => <li key={a.categoryId}><AlertCircle size={17} /><div><strong>{a.name}</strong><span>{money(a.spent)} su {money(a.limit)}{a.status === 'risk' ? ` · a questo ritmo ${money(a.projected)}` : ` · ${money(a.spent - a.limit)} oltre`}{a.perDay > 0 ? ` · per rientrare ${money(a.perDay)} al giorno` : ''}</span></div></li>)}</ul>}
    {report.tips.length > 0 && <ul className="advice-tips">{report.tips.map((tip, i) => { const Icon = tipIcons[tip.kind]; return <li key={i} className={tip.kind}><Icon size={17} /><div><strong>{tip.title}</strong>{tip.detail && <p>{tip.detail}</p>}</div></li>; })}</ul>}
    {report.subscriptions.length > 0 && <details className="advice-details"><summary><Repeat size={15} />Pagamenti ripetuti: {money(report.subscriptions.reduce((s, x) => s + x.yearly, 0))} all’anno</summary><ul>{report.subscriptions.map(s => <li key={s.key}><span>{s.name}{s.increased && <em className="badge">aumentato</em>}</span><b>{money(s.monthly)} al mese</b></li>)}</ul></details>}
    {report.adjustment && changed.length > 0 && <div className="advice-adjust">
      <strong>Ripartizione suggerita per {monthName(report.adjustment.month)}</strong>
      {report.adjustment.reason && <p>{report.adjustment.reason}</p>}
      <ul>{changed.map(c => <li key={c.id}><span className="category-dot" style={{ background: c.color }} />{c.name}<s>{c.percentage / 100}%</s><b>{report.adjustment!.split[c.id] / 100}%</b></li>)}</ul>
      {report.adjustment.applied
        ? <div className="advice-applied"><span><CircleCheck size={16} />Applicata a {monthName(report.adjustment.month)}</span>{report.adjustment.applicable && <button className="text-button" disabled={busy} onClick={() => void act(`/budget/overrides/${report.adjustment!.month}`, 'DELETE').catch(() => {})}>Torna alla ripartizione abituale</button>}</div>
        : report.adjustment.applicable && <button className="button primary" disabled={busy} onClick={() => void act(`/advisor/reports/${report.id}/apply`, 'POST').catch(() => {})}>Applica solo a {monthName(report.adjustment.month)}</button>}
      <small>Vale per quel mese soltanto: dal mese successivo torna la ripartizione abituale.</small>
    </div>}
  </div>;
}

// Family setting: the administrator decides whether the figures go to Claude.
export function AdvisorSettings({ data, mutate }: { data: FamilyState; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> }) {
  const { advisor } = data;
  const [enabled, setEnabled] = useState(advisor.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [automatic, setAutomatic] = useState(advisor.automatic);
  const [assigning, setAssigning] = useState(false);
  async function assign(next: boolean) {
    setAutomatic(next); setAssigning(true); setError('');
    try { await mutate('/advisor/assignment', 'PUT', { automatic: next }); } catch (e) { setAutomatic(!next); setError((e as Error).message); } finally { setAssigning(false); }
  }
  async function toggle(next: boolean) {
    setEnabled(next); setPending(true); setError('');
    try { await mutate('/advisor/settings', 'PUT', { enabled: next }); } catch (e) { setEnabled(!next); setError((e as Error).message); } finally { setPending(false); }
  }
  return <section className="panel settings-card"><SectionHeading title="Consigli del budget" /><div className="settings-body"><span className="settings-icon"><Sparkles size={25} /></span>
    {!advisor.configured && <p className="form-error" role="status">I consigli non sono ancora configurati sul server: serve la chiave ANTHROPIC_API_KEY tra le variabili private del deployment.</p>}
    <label className="checkbox-label"><input type="checkbox" checked={enabled} disabled={!advisor.canManage || !advisor.configured || pending} onChange={e => void toggle(e.target.checked)} />Prepara ogni settimana e ogni mese un report con i consigli per restare nel budget</label>
    {!advisor.canManage && <p className="form-hint">Solo l’amministratore della casa può attivarli o disattivarli.</p>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {advisor.error && enabled && <div className="form-error" role="status">{advisor.error}</div>}
    <fieldset className="advisor-assignment" disabled={!advisor.canManage || !enabled || assigning}><legend>Categorie delle uscite da classificare</legend>
      <label className="checkbox-label"><input type="radio" name="assignment" checked={!automatic} onChange={() => void assign(false)} /><span><strong>Suggerita</strong> La categoria proposta compare in Uscite e la applicate voi con un clic.</span></label>
      <label className="checkbox-label"><input type="radio" name="assignment" checked={automatic} onChange={() => void assign(true)} /><span><strong>Automatica</strong> L’app assegna da sola la categoria proposta. I versamenti verso Risparmio restano da confermare.</span></label>
    </fieldset>
    <div className="advisor-info">
      <h3>Come funzionano</h3>
      <ul>
        <li>Arrivano da soli: ogni lunedì un report sulla settimana e su come chiudere il mese nel budget, il 1° del mese il riepilogo del mese chiuso. Li aprite dall’icona del foglio accanto al mese in Panoramica, che si illumina quando ne arriva uno nuovo. Il nuovo report settimanale sostituisce il precedente; quello mensile sostituisce il mensile precedente e chiude la settimana del mese passato.</li>
        <li>Volendo, potete mostrarli anche in un riquadro della Panoramica: lo attivate in Impostazioni → Panoramica.</li>
        <li>Segnalano le categorie che stanno sforando, abbonamenti e piccole spese da rivedere, possibili doppioni e le scadenze in arrivo, e propongono la categoria delle uscite da classificare: suggerita, da applicare voi, oppure assegnata in automatico. Una categoria scelta per un movimento importato dalla banca vale anche per i movimenti successivi dello stesso esercente.</li>
        <li>Quando serve propongono una ripartizione per un solo mese: la applicate con un clic e dal mese successivo torna quella abituale.</li>
      </ul>
      <h3>Privacy</h3>
      <ul>
        <li>Per scrivere i consigli l’app invia a Claude, il modello di Anthropic, importi, date, categorie e descrizioni dei movimenti degli ultimi sei mesi. IBAN, numeri lunghi, email, nomi dei familiari e dati di accesso non vengono inviati.</li>
        <li>Le registrazioni dei conti personali di ciascuno arrivano solo come totali per categoria.</li>
        <li>Anthropic per impostazione predefinita non usa i dati inviati tramite API per addestrare i modelli. Ogni report costa pochi centesimi.</li>
      </ul>
    </div>
  </div></section>;
}
