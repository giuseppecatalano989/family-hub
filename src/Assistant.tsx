import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { CalendarDays, ChartPie, Check, ChevronRight, MessageCircle, RefreshCw, RotateCcw, Send, ShoppingBasket, Sparkles, StickyNote, Tags, Utensils, Wallet, X } from 'lucide-react';
import { Empty } from './components';
import { api } from './api';
import { money, readableDate } from './finance';
import type { AssistantProposal, FamilyState, User } from './types';

type Mutate = <T>(path: string, method: string, body?: unknown) => Promise<T>;
type Status = 'pending' | 'done' | 'dismissed';
export interface ChatMessage { role: 'user' | 'assistant'; text: string; proposals?: (AssistantProposal & { status: Status })[] }
export interface AssistantChat {
  messages: ChatMessage[]; pending: boolean; error: string; remaining: number | null;
  send: (text: string) => Promise<void>; reset: () => void; settle: (id: string, status: Status) => void;
}

const MAX_HISTORY = 16; const MAX_TEXT = 4000;
const recurrences = { none: '', weekly: 'ogni settimana', monthly: 'ogni mese', yearly: 'ogni anno' };
const storageKey = (user: User) => `casa-assistente-${user.id}`;
export const SUGGESTIONS = ['Come stiamo andando con il budget questo mese?', 'Quanto abbiamo speso in spesa alimentare negli ultimi tre mesi?', 'Cosa abbiamo in programma questa settimana?', 'Aggiungi latte e pane alla lista della spesa'];

function read(user: User): ChatMessage[] {
  try { const saved = JSON.parse(sessionStorage.getItem(storageKey(user)) || '[]'); return Array.isArray(saved) ? saved : []; } catch { return []; }
}
export function forgetChat(user: User | null) { if (user) try { sessionStorage.removeItem(storageKey(user)); } catch { /* storage unavailable */ } }

// One short line per proposal, so that the next answer knows what was confirmed.
function describe(p: AssistantProposal) {
  if (p.type === 'shopping') return `aggiungere alla spesa ${p.items.map(i => i.name).join(', ')}`;
  if (p.type === 'event') return `evento "${p.event.title}" il ${p.event.startDate}`;
  if (p.type === 'meal') return `${p.meal.slot === 'lunch' ? 'pranzo' : 'cena'} del ${p.meal.date}: ${p.meal.title}`;
  if (p.type === 'note') return `appunto "${p.note.title}"`;
  if (p.type === 'categories') return `nuova categoria per ${p.changes.map(c => `"${c.description}"`).join(', ')}`;
  if (p.type === 'budget') return `nuova ripartizione ${p.split.map(c => `${c.name} ${c.to / 100}%`).join(', ')}`;
  return `${p.transaction.kind === 'income' ? 'entrata' : 'uscita'} "${p.transaction.description}" del ${p.transaction.date}`;
}
const outcome = { pending: 'in attesa di conferma', done: 'confermata e applicata', dismissed: 'ignorata' };
function history(messages: ChatMessage[]) {
  const turns = messages.map(m => ({ role: m.role, text: (m.text + (m.proposals?.length ? `\n\n[Proposte: ${m.proposals.map(p => `${describe(p)} (${outcome[p.status]})`).join('; ')}]` : '')).slice(0, MAX_TEXT) }));
  return turns.slice(-MAX_HISTORY);
}

// The conversation lives in this tab for this account: the overview and the
// section share it, and it is cleared on sign-out.
export function useAssistant(user: User | null): AssistantChat {
  const [messages, setMessages] = useState<ChatMessage[]>(() => user ? read(user) : []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const current = useRef(messages); current.current = messages;
  useEffect(() => { setMessages(user ? read(user) : []); setError(''); }, [user?.id]);
  useEffect(() => { if (user) try { sessionStorage.setItem(storageKey(user), JSON.stringify(messages.slice(-40))); } catch { /* storage unavailable */ } }, [messages, user?.id]);
  const send = useCallback(async (raw: string) => {
    const text = raw.trim().slice(0, MAX_TEXT);
    if (!text || pending) return;
    const next = [...current.current, { role: 'user' as const, text }];
    setMessages(next); setPending(true); setError('');
    try {
      const result = await api<{ reply: string; proposals: AssistantProposal[]; remaining: number }>('/assistant/messages', 'POST', { messages: history(next) });
      setMessages(list => [...list, { role: 'assistant', text: result.reply, proposals: result.proposals.map(p => ({ ...p, status: 'pending' as const })) }]);
      setRemaining(result.remaining);
    } catch (e) {
      // The question stays in the box to try again, not in the conversation.
      setMessages(list => list.filter((m, i) => !(i === list.length - 1 && m.role === 'user' && m.text === text)));
      setError((e as Error).message);
      throw e;
    } finally { setPending(false); }
  }, [pending]);
  const reset = useCallback(() => { setMessages([]); setError(''); }, []);
  const settle = useCallback((id: string, status: Status) => setMessages(list => list.map(m => m.proposals?.some(p => p.id === id) ? { ...m, proposals: m.proposals.map(p => p.id === id ? { ...p, status } : p) } : m)), []);
  return { messages, pending, error, remaining, send, reset, settle };
}

// Short paragraphs, bulleted lines and **bold** from the answer, as plain React text.
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part.replace(/\*\*/g, '')}</Fragment>);
}
function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = []; let list: string[] = [];
  const flush = () => { if (list.length) blocks.push(<ul key={blocks.length}>{list.map((item, i) => <li key={i}>{inline(item)}</li>)}</ul>); list = []; };
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) blocks.push(<p key={blocks.length}><strong>{heading[1]}</strong></p>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="assistant-text">{blocks}</div>;
}

function Proposal({ proposal: p, data, mutate, settle }: { proposal: AssistantProposal & { status: Status }; data: FamilyState; mutate: Mutate; settle: AssistantChat['settle'] }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const categoryName = (id: string | null) => data.categories.find(c => c.id === id)?.name || 'Da classificare';
  async function confirm() {
    setSaving(true); setError('');
    try {
      if (p.type === 'shopping') for (const item of p.items) await mutate('/shopping', 'POST', item);
      else if (p.type === 'event') await mutate('/calendar', 'POST', p.event);
      else if (p.type === 'meal') await mutate('/meals', 'POST', p.meal);
      else if (p.type === 'note') await mutate('/notes', 'POST', p.note);
      else if (p.type === 'categories') for (const c of p.changes) await mutate(`/transactions/${c.id}`, 'PUT', { kind: 'expense', amount: c.amount, categoryId: c.to, description: c.description, date: c.date });
      // The custom split keeps the names the categories have now.
      else if (p.type === 'budget') await mutate('/budget', 'PUT', { categories: data.categories.map(c => ({ id: c.id, name: c.name, percentage: p.split.find(s => s.id === c.id)?.to ?? -1 })) });
      else await mutate('/transactions', 'POST', p.transaction);
      settle(p.id, 'done');
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  const view = p.type === 'shopping' ? { icon: ShoppingBasket, title: 'Aggiungere alla lista della spesa', body: <ul>{p.items.map((i, n) => <li key={n}>{i.name}{i.quantity && ` · ${i.quantity}`}<small>{i.section}</small></li>)}</ul> }
    : p.type === 'event' ? { icon: CalendarDays, title: 'Nuovo evento nel calendario', body: <><strong>{p.event.title}</strong><p>{readableDate(p.event.startDate)}{p.event.endDate !== p.event.startDate && ` – ${readableDate(p.event.endDate)}`}{p.event.startTime ? ` · ${p.event.startTime}${p.event.endTime ? `–${p.event.endTime}` : ''}` : ' · tutto il giorno'}{p.event.recurrence !== 'none' && ` · ${recurrences[p.event.recurrence]}${p.event.recurrenceUntil ? ` fino al ${readableDate(p.event.recurrenceUntil)}` : ''}`}</p><p>{p.event.personal ? 'Personale' : 'Famiglia'}{p.event.location && ` · ${p.event.location}`}</p>{p.event.notes && <p>{p.event.notes}</p>}</> }
    : p.type === 'meal' ? { icon: Utensils, title: 'Nuovo pasto nel menu', body: <><strong>{p.meal.title}</strong><p>{p.meal.slot === 'lunch' ? 'Pranzo' : 'Cena'} di {readableDate(p.meal.date)} · {p.meal.servings} {p.meal.servings === 1 ? 'porzione' : 'porzioni'}</p>{!!p.meal.ingredients.length && <p>{p.meal.ingredients.map(i => `${i.name}${i.quantity ? ` (${i.quantity})` : ''}`).join(', ')}</p>}</> }
    : p.type === 'categories' ? { icon: Tags, title: p.changes.length === 1 ? 'Cambiare la categoria di un’uscita' : `Cambiare la categoria di ${p.changes.length} uscite`, body: <ul>{p.changes.map(c => <li key={c.id}>{c.description} · {money(c.amount)}<small>{readableDate(c.date)}</small><br /><span className="assistant-change">{categoryName(c.from)} → <b>{categoryName(c.to)}</b></span></li>)}</ul> }
    : p.type === 'budget' ? { icon: ChartPie, title: 'Nuova ripartizione Pers. dal mese corrente', body: <>{p.reason && <p>{p.reason}</p>}<ul>{p.split.map(c => <li key={c.id}>{data.categories.find(x => x.id === c.id)?.name || c.name}: <span className="assistant-change">{c.from / 100}% → <b>{c.to / 100}%</b></span></li>)}</ul></> }
    : p.type === 'note' ? { icon: StickyNote, title: 'Nuovo appunto in lavagna', body: <><strong>{p.note.title}</strong>{p.note.content && <p className="assistant-note-preview">{p.note.content}</p>}</> }
    : { icon: Wallet, title: p.transaction.kind === 'income' ? 'Nuova entrata' : 'Nuova uscita', body: <><strong>{p.transaction.description} · {money(p.transaction.amount)}</strong><p>{readableDate(p.transaction.date)}{p.transaction.categoryId && ` · ${data.categories.find(c => c.id === p.transaction.categoryId)?.name || 'Categoria'}`}</p></> };
  return <div className={`assistant-proposal is-${p.status}`}>
    <div className="assistant-proposal-heading"><view.icon size={17} /><span>{view.title}</span></div>
    <div className="assistant-proposal-body">{view.body}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {p.status === 'pending' ? <div className="assistant-proposal-actions"><button type="button" className="button secondary" disabled={saving} onClick={() => settle(p.id, 'dismissed')}><X size={15} />Ignora</button><button type="button" className="button primary" disabled={saving} onClick={() => void confirm()}>{saving ? <RefreshCw className="spin" size={15} /> : <Check size={15} />}Conferma</button></div>
      : <p className="assistant-proposal-status">{p.status === 'done' ? <><Check size={15} />Fatto</> : 'Ignorata'}</p>}
  </div>;
}

function Message({ message, data, mutate, settle }: { message: ChatMessage; data: FamilyState; mutate: Mutate; settle: AssistantChat['settle'] }) {
  if (message.role === 'user') return <div className="assistant-message from-user"><p>{message.text}</p></div>;
  return <div className="assistant-message from-assistant"><span className="assistant-avatar" aria-hidden="true"><Sparkles size={15} /></span><div><Rich text={message.text} />{message.proposals?.map(p => <Proposal key={p.id} proposal={p} data={data} mutate={mutate} settle={settle} />)}</div></div>;
}

function Composer({ chat, compact = false, autoFocus = false }: { chat: AssistantChat; compact?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  function submit(event?: FormEvent) {
    event?.preventDefault();
    const question = text;
    if (!question.trim() || chat.pending) return;
    setText('');
    void chat.send(question).catch(() => setText(question));
  }
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } };
  return <form className={`assistant-composer ${compact ? 'compact' : ''}`} onSubmit={submit}>
    <label className="sr-only" htmlFor={compact ? 'assistant-quick' : 'assistant-input'}>Scrivi all’assistente</label>
    <textarea id={compact ? 'assistant-quick' : 'assistant-input'} rows={1} value={text} maxLength={MAX_TEXT} autoFocus={autoFocus} onChange={e => setText(e.target.value)} onKeyDown={keys} placeholder="Chiedi qualcosa o fai una richiesta…" />
    <button type="submit" className="button primary" disabled={chat.pending || !text.trim()} aria-label="Invia">{chat.pending ? <RefreshCw className="spin" size={17} /> : <Send size={17} />}</button>
  </form>;
}

const Thinking = () => <div className="assistant-message from-assistant" role="status"><span className="assistant-avatar" aria-hidden="true"><Sparkles size={15} /></span><p className="assistant-thinking"><RefreshCw className="spin" size={14} />Sto controllando i vostri dati…</p></div>;
const Note = ({ chat }: { chat: AssistantChat }) => <p className="assistant-disclaimer"><Sparkles size={14} />Risposte preparate con l’intelligenza artificiale: le cifre sono calcolate dall’app, ma verifica quelle importanti. Ogni modifica avviene solo con la tua conferma.{chat.remaining !== null && ` Domande rimaste oggi per la famiglia: ${chat.remaining}.`}</p>;

// The full conversation, in its own section.
export function Assistant({ data, chat, mutate }: { data: FamilyState; chat: AssistantChat; mutate: Mutate }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }); }, [chat.messages.length, chat.pending]);
  if (!data.assistant.available) return <section className="panel"><Empty icon={<MessageCircle size={26} />} title="Assistente non disponibile" description="L’assistente con l’intelligenza artificiale non è configurato sul server." /></section>;
  return <section className="panel assistant-panel">
    <div className="section-heading"><h2>La conversazione</h2>{!!chat.messages.length && <button className="button secondary" disabled={chat.pending} onClick={chat.reset}><RotateCcw size={15} />Nuova conversazione</button>}</div>
    <div className="assistant-thread" aria-live="polite">
      {!chat.messages.length && <div className="assistant-welcome"><span className="assistant-avatar large" aria-hidden="true"><Sparkles size={22} /></span><h3>Come posso aiutarvi?</h3><p>Chiedi del budget, delle spese, delle scadenze o del calendario, oppure chiedi di aggiungere qualcosa: te lo propongo e lo confermi tu.</p>
        <div className="assistant-suggestions">{SUGGESTIONS.map(s => <button key={s} type="button" className="hint-chip" disabled={chat.pending} onClick={() => void chat.send(s).catch(() => {})}>{s}</button>)}</div></div>}
      {chat.messages.map((m, i) => <Message key={i} message={m} data={data} mutate={mutate} settle={chat.settle} />)}
      {chat.pending && <Thinking />}
      <div ref={end} />
    </div>
    {chat.error && <p className="form-error assistant-error" role="alert">{chat.error}</p>}
    <div className="assistant-footer"><Composer chat={chat} /><Note chat={chat} /></div>
  </section>;
}

// The overview's bar: ask from here, see the latest answer, open the section for the rest.
export function AssistantCard({ data, chat, mutate, onOpen }: { data: FamilyState; chat: AssistantChat; mutate: Mutate; onOpen: () => void }) {
  const lastAnswer = chat.messages.map(m => m.role).lastIndexOf('assistant');
  const recent = lastAnswer > 0 && chat.messages[lastAnswer - 1].role === 'user' ? chat.messages.slice(lastAnswer - 1, lastAnswer + 1) : [];
  const question = chat.pending ? chat.messages.at(-1) : null;
  return <section className="panel assistant-card" aria-label="Chiedi all’assistente">
    <div className="assistant-card-heading"><span className="assistant-avatar" aria-hidden="true"><Sparkles size={15} /></span><h2>Chiedi all’assistente</h2><button type="button" className="text-button" onClick={onOpen}>{chat.messages.length ? 'Apri la conversazione' : 'Apri l’assistente'}<ChevronRight size={16} /></button></div>
    <Composer chat={chat} compact />
    {!chat.messages.length && !chat.pending && <div className="assistant-suggestions">{SUGGESTIONS.slice(0, 3).map(s => <button key={s} type="button" className="hint-chip" onClick={() => void chat.send(s).catch(() => {})}>{s}</button>)}</div>}
    {chat.error && <p className="form-error assistant-error" role="alert">{chat.error}</p>}
    {(question || recent.length > 0) && <div className="assistant-thread compact">
      {question ? <><Message message={question} data={data} mutate={mutate} settle={chat.settle} /><Thinking /></> : recent.map((m, i) => <Message key={i} message={m} data={data} mutate={mutate} settle={chat.settle} />)}
    </div>}
  </section>;
}
