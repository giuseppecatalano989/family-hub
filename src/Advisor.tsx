import { useState } from 'react';
import { AlertCircle, CalendarClock, CircleCheck, Info, Repeat, RefreshCw, Scissors, Sparkles, Target } from 'lucide-react';
import { Empty, SectionHeading } from './components';
import { money } from './finance';
import type { AdvisorReport, FamilyState } from './types';

type Act = (path: string, method: string, body?: unknown) => Promise<void>;
const monthName = (month: string) => new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(new Date(`${month}-15T12:00:00`));
const shortDay = (date: string) => new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`));
const tipIcons = { avoid: Scissors, adjust: CalendarClock, goal: Target, info: Info };

// The latest weekly and monthly reports: figures from the server, advice from Claude.
export function AdvisorCard({ data, act, busy }: { data: FamilyState; act: Act; busy: boolean }) {
  const { advisor } = data;
  const [kind, setKind] = useState<'weekly' | 'monthly'>(advisor.weekly || !advisor.monthly ? 'weekly' : 'monthly');
  const report = advisor[kind];
  const request = () => void act('/advisor/reports', 'POST', { kind }).catch(() => {});
  return <section className="panel advice-panel">
    <div className="section-heading"><h2>Consigli del budget</h2>
      <div className="advice-switch" role="group" aria-label="Tipo di report">{(['weekly', 'monthly'] as const).map(k => <button key={k} type="button" aria-pressed={kind === k} className={kind === k ? 'selected' : ''} onClick={() => setKind(k)}>{k === 'weekly' ? 'Settimana' : 'Mese'}</button>)}</div>
    </div>
    {advisor.running && <p className="advice-running" role="status"><RefreshCw className="spin" size={15} />Stiamo preparando il report: compare qui tra poco.</p>}
    {report ? <Report report={report} data={data} act={act} busy={busy} /> : !advisor.running && <Empty icon={<Sparkles size={26} />} title={kind === 'weekly' ? 'Il primo report settimanale' : 'Il primo report mensile'}
      description={kind === 'weekly' ? 'Arriva ogni lunedì: com’è andata la settimana e come chiudere il mese nel budget.' : 'Arriva il 1° del mese: il riepilogo del mese chiuso e cosa preparare.'} action="Preparalo ora" onAction={request} />}
    {report && <div className="panel-tip advice-footer"><Sparkles size={16} /><span>Preparato il {shortDay(report.createdAt.slice(0, 10))} con Claude. Le cifre sono calcolate dall’app sui vostri movimenti.</span><button className="text-button" disabled={busy || advisor.running} onClick={request}>Aggiorna</button></div>}
  </section>;
}

function Report({ report, data, act, busy }: { report: AdvisorReport; data: FamilyState; act: Act; busy: boolean }) {
  const changed = report.adjustment ? data.categories.filter(c => report.adjustment!.split[c.id] !== c.percentage) : [];
  return <div className="advice-body">
    <span className="eyebrow">{report.kind === 'weekly' && report.week ? `SETTIMANA DAL ${shortDay(report.week.from)} AL ${shortDay(report.week.to)}`.toLocaleUpperCase('it') : monthName(report.month).toLocaleUpperCase('it')}</span>
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
    <div className="advisor-info">
      <h3>Come funzionano</h3>
      <ul>
        <li>Ogni lunedì un report sulla settimana e su come chiudere il mese nel budget; il 1° del mese il riepilogo del mese chiuso. Puoi anche aggiornarli dalla Panoramica.</li>
        <li>Segnalano le categorie che stanno sforando, abbonamenti e piccole spese da rivedere, possibili doppioni e le scadenze in arrivo, e suggeriscono la categoria delle uscite da classificare.</li>
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
