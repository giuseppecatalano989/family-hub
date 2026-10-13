import { useRef, useState, type ChangeEvent } from 'react';
import { Camera, ImagePlus, RefreshCw, ShoppingBasket, Sparkles, Trash2, Clock, Users } from 'lucide-react';
import { Modal } from './components';
import { api } from './api';
import { localDate, readableDate } from './finance';
import { addDays } from './schedule';
import type { FamilyState, PantryAnalysis } from './types';

type Slot = 'lunch' | 'dinner';
interface Choice { selected: boolean; date: string; slot: Slot; buy: boolean[] }
// Four photos stay below the 4.5 MB request limit of Vercel functions.
const MAX_PHOTOS = 4; const EDGE = 1568; const MAX_BYTES = 760 * 1024;
const normalized = (value: string) => value.trim().toLocaleLowerCase('it');

// Photos are shrunk and re-encoded in the browser: smaller uploads, no location
// data, and previews as data URLs allowed by the page's security policy.
async function shrink(file: File) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => { throw new Error('Formato della foto non supportato. Usa una foto JPEG o PNG.'); });
  const scale = Math.min(1, EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if ((url.length - 23) * 0.75 <= MAX_BYTES) return url;
  }
  throw new Error('La foto è troppo grande. Prova con un’altra inquadratura.');
}

export default function PantryDialog({ data, week, onClose, mutate }: { data: FamilyState; week: string; onClose: () => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> }) {
  const [photos, setPhotos] = useState<string[]>([]);
  const [servings, setServings] = useState(Math.max(1, data.members.length));
  const [note, setNote] = useState('');
  const [result, setResult] = useState<PantryAnalysis | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [extras, setExtras] = useState<boolean[]>([]);
  const [pending, setPending] = useState<'' | 'photos' | 'analysis' | 'save'>('');
  const [error, setError] = useState('');
  const gallery = useRef<HTMLInputElement>(null); const camera = useRef<HTMLInputElement>(null);
  const inList = new Set(data.shopping.filter(s => !s.checked).map(s => normalized(s.name)));

  async function add(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []).slice(0, MAX_PHOTOS - photos.length);
    event.target.value = '';
    if (!files.length) return;
    setPending('photos'); setError('');
    try { const next = await Promise.all(files.map(shrink)); setPhotos(current => [...current, ...next].slice(0, MAX_PHOTOS)); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(''); }
  }
  // Suggested moments start from the next meal and skip those already planned.
  function freeSlots(count: number) {
    const taken = new Set(data.meals.map(m => `${m.date} ${m.slot}`));
    const slots: { date: string; slot: Slot }[] = [];
    const today = localDate();
    let date = today < week ? week : today; let slot: Slot = date === today && new Date().getHours() >= 15 ? 'dinner' : 'lunch';
    for (let guard = 0; slots.length < count && guard < 60; guard++) {
      if (!taken.has(`${date} ${slot}`)) slots.push({ date, slot });
      if (slot === 'lunch') slot = 'dinner'; else { slot = 'lunch'; date = addDays(date, 1); }
    }
    return slots;
  }
  async function analyse() {
    setPending('analysis'); setError('');
    try {
      const answer = await api<PantryAnalysis>('/pantry/analysis', 'POST', { photos: photos.map(p => p.slice(p.indexOf(',') + 1)), servings, note }, 'application/x-casa-pantry');
      const slots = freeSlots(answer.recipes.length);
      setChoices(answer.recipes.map((r, i) => ({ selected: false, date: slots[i]?.date || localDate(), slot: slots[i]?.slot || 'dinner', buy: r.ingredients.map(ing => !ing.available && !inList.has(normalized(ing.name))) })));
      setExtras(answer.shopping.map(s => !inList.has(normalized(s.name))));
      setResult(answer);
    } catch (e) { setError((e as Error).message); }
    finally { setPending(''); }
  }
  const update = (index: number, change: Partial<Choice>) => setChoices(choices.map((c, i) => i === index ? { ...c, ...change } : c));
  // A product already bought with a chosen recipe is not added a second time.
  const recipeItems = new Set(result ? result.recipes.flatMap((r, i) => choices[i]?.selected ? r.ingredients.filter((_, j) => choices[i].buy[j]).map(ing => normalized(ing.name)) : []) : []);
  const chosenExtras = result ? result.shopping.filter((s, i) => extras[i] && !recipeItems.has(normalized(s.name))) : [];
  const chosenMeals = result ? result.recipes.flatMap((r, i) => choices[i]?.selected ? [{ recipe: r, choice: choices[i] }] : []) : [];
  const toBuy = chosenMeals.reduce((sum, { choice }) => sum + choice.buy.filter(Boolean).length, 0) + chosenExtras.length;
  async function confirm() {
    setPending('save'); setError('');
    try {
      await mutate('/meals/batch', 'POST', {
        meals: chosenMeals.map(({ recipe, choice }) => ({ date: choice.date, slot: choice.slot, title: recipe.title, servings: recipe.servings, notes: recipe.notes, ingredients: recipe.ingredients.map((ing, j) => ({ name: ing.name, quantity: ing.quantity, section: ing.section, buy: choice.buy[j] })) })),
        shopping: chosenExtras.map(s => ({ name: s.name, quantity: s.quantity, section: s.section })),
      });
      onClose();
    } catch (e) { setError((e as Error).message); setPending(''); }
  }
  const summary = [chosenMeals.length && `${chosenMeals.length} ${chosenMeals.length === 1 ? 'pasto' : 'pasti'}`, toBuy && `${toBuy} ${toBuy === 1 ? 'prodotto' : 'prodotti'} in lista`].filter(Boolean).join(' e ');

  if (!result) return <Modal title="Cosa c’è in frigo?" subtitle="Fotografa frigo e dispensa: ti suggerisco cosa comprare e cosa cucinare." onClose={onClose}>
    {pending === 'analysis' ? <div className="pantry-loading" role="status"><RefreshCw className="spin" size={26} /><strong>Sto guardando le foto…</strong><p>Riconosco gli alimenti e preparo qualche ricetta. Può volerci fino a un minuto.</p></div> : <>
      <div className="pantry-photos">{photos.map((photo, index) => <figure key={index}><img src={photo} alt={`Foto ${index + 1}`} /><button type="button" className="icon-button danger" aria-label={`Rimuovi foto ${index + 1}`} onClick={() => setPhotos(photos.filter((_, i) => i !== index))}><Trash2 size={14} /></button></figure>)}
        {photos.length < MAX_PHOTOS && <div className="pantry-add"><button type="button" className="button secondary" disabled={!!pending} onClick={() => camera.current?.click()}><Camera size={16} />Scatta foto</button><button type="button" className="text-button" disabled={!!pending} onClick={() => gallery.current?.click()}><ImagePlus size={15} />Scegli dalla galleria</button></div>}
      </div>
      <input ref={camera} className="sr-only" type="file" accept="image/*" capture="environment" aria-label="Scatta una foto" onChange={e => void add(e)} tabIndex={-1} />
      <input ref={gallery} className="sr-only" type="file" accept="image/*" multiple aria-label="Scegli le foto" onChange={e => void add(e)} tabIndex={-1} />
      <p className="form-hint">{pending === 'photos' ? 'Preparo le foto…' : `Fino a ${MAX_PHOTOS} foto, ad esempio frigo, freezer e dispensa.`}</p>
      <label>Porzioni per ricetta<input type="number" min={1} max={20} step={1} value={servings} onChange={e => setServings(Math.min(20, Math.max(1, Math.round(Number(e.target.value)) || 1)))} required /></label>
      <div className="field"><label htmlFor="pantry-note">Preferenze <span className="optional">facoltativo</span></label><textarea id="pantry-note" rows={2} maxLength={500} value={note} onChange={e => setNote(e.target.value)} placeholder="Ad esempio: niente carne, cene veloci, un bambino piccolo" /></div>
      <p className="form-hint">Le foto vengono inviate a Claude solo per questa analisi e non vengono salvate. Analisi rimaste oggi per la famiglia: {data.pantry.remaining}.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Annulla</button><button type="button" className="button primary" disabled={!photos.length || !!pending || !data.pantry.remaining} onClick={() => void analyse()}><Sparkles size={16} />Analizza le foto</button></div>
    </>}
  </Modal>;

  return <Modal title="Ecco cosa ho trovato" subtitle="Scegli le ricette da inserire nel menu e i prodotti da aggiungere alla spesa." onClose={onClose}>
    {result.notice && <div className="panel-tip pantry-notice"><Sparkles size={16} /><span>{result.notice}</span></div>}
    {!!result.found.length && <section className="pantry-section"><h3>In casa</h3><ul className="pantry-found">{result.found.map((f, i) => <li key={i}>{f.name}{f.amount && <small>{f.amount}</small>}</li>)}</ul></section>}
    {!!result.recipes.length && <section className="pantry-section"><h3>Ricette suggerite</h3>{result.recipes.map((recipe, i) => { const choice = choices[i]; const missing = recipe.ingredients.filter(ing => !ing.available).length; return <article className={`pantry-recipe ${choice.selected ? 'selected' : ''}`} key={i}>
      <label className="check-row"><input type="checkbox" checked={choice.selected} onChange={e => update(i, { selected: e.target.checked })} /><span><strong>{recipe.title}</strong><small>{recipe.minutes ? <><Clock size={12} />{recipe.minutes} min · </> : null}<Users size={12} />{recipe.servings} {recipe.servings === 1 ? 'porzione' : 'porzioni'}{missing ? ` · ${missing} da comprare` : ' · tutto in casa'}</small></span></label>
      {recipe.summary && <p>{recipe.summary}</p>}
      <ul className="pantry-ingredients">{recipe.ingredients.map((ing, j) => <li key={j} className={ing.available ? '' : 'missing'}><span>{ing.name}</span><small>{ing.quantity}</small>{!ing.available && (choice.selected ? <label className="pantry-buy"><input type="checkbox" checked={choice.buy[j]} onChange={e => update(i, { buy: choice.buy.map((b, k) => k === j ? e.target.checked : b) })} aria-label={`Aggiungi ${ing.name} alla spesa`} />in spesa</label> : <em>da comprare</em>)}</li>)}</ul>
      {choice.selected && <div className="form-columns"><label>Giorno<input type="date" value={choice.date} min="1900-01-01" max="2199-12-31" onChange={e => { if (e.target.value) update(i, { date: e.target.value }); }} aria-label={`Giorno per ${recipe.title}`} /></label><label>Pasto<select value={choice.slot} onChange={e => update(i, { slot: e.target.value as Slot })} aria-label={`Pasto per ${recipe.title}`}><option value="lunch">Pranzo</option><option value="dinner">Cena</option></select></label></div>}
      {choice.selected && <p className="form-hint">{readableDate(choice.date)}, {choice.slot === 'lunch' ? 'pranzo' : 'cena'}.</p>}
    </article>; })}</section>}
    {!!result.shopping.length && <section className="pantry-section"><h3>Da comprare</h3><ul className="pantry-shopping">{result.shopping.map((item, i) => { const covered = recipeItems.has(normalized(item.name)); const listed = inList.has(normalized(item.name)); return <li key={i}><label className="check-row"><input type="checkbox" checked={covered || extras[i]} disabled={covered} onChange={e => setExtras(extras.map((x, k) => k === i ? e.target.checked : x))} /><span><strong>{item.name}{item.quantity && <small> · {item.quantity}</small>}</strong><small>{covered ? 'Con la ricetta scelta' : listed ? 'Già nella lista della spesa' : item.reason || item.section}</small></span></label></li>; })}</ul></section>}
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-footer pantry-footer"><button type="button" className="button secondary" disabled={pending === 'save'} onClick={() => { setResult(null); setError(''); }}>Nuova analisi</button><button type="button" className="button primary" disabled={pending === 'save' || !summary} onClick={() => void confirm()}><ShoppingBasket size={16} />{pending === 'save' ? 'Salvataggio…' : summary ? `Conferma: ${summary}` : 'Scegli cosa inserire'}</button></div>
  </Modal>;
}
