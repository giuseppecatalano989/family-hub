import { useState, type FormEvent } from 'react';
import { Check, Paperclip, Trash2 } from 'lucide-react';
import BudgetDialog from './BudgetDialog';
import SavingsDialog from './SavingsDialog';
import { Modal } from './components';
import { parseMoney, toInput, readableDate } from './finance';
import type { Dialog } from './pages';
import type { FamilyState } from './types';

type Props = { dialog: Exclude<Dialog, null>; data: FamilyState; onClose: () => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> };
export default function Dialogs({ dialog, data, onClose, mutate }: Props) {
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const [color, setColor] = useState(dialog.type === 'note' ? dialog.note?.color || 'amber' : 'amber');
  const [files, setFiles] = useState<File[]>([]);
  const [noteId, setNoteId] = useState(dialog.type === 'note' ? dialog.note?.id : undefined);
  const [removed, setRemoved] = useState<string[]>([]);
  async function save(action: () => Promise<void>, close = true) {
    setPending(true); setError('');
    try { await action(); if (close) onClose(); }
    catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }
  const footer = (label = 'Salva') => <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={pending}>Annulla</button><button className="button primary" disabled={pending}>{pending ? 'Salvataggio…' : label}</button></div>;
  const errors = error && <div className="form-error" role="alert">{error}</div>;
  const submit = (event: FormEvent<HTMLFormElement>, action: (form: FormData) => Promise<void>) => { event.preventDefault(); const form = new FormData(event.currentTarget); void save(() => action(form)); };
  if (dialog.type === 'viewNote') {
    const note = data.notes.find(n => n.id === dialog.note.id) || dialog.note;
    return <Modal title={note.title} onClose={onClose}>
      <div className="note-reader">
        <p className="note-reader-meta">{note.author} · {readableDate(note.updated_at.slice(0, 10))}</p>
        {note.content && <p className="note-reader-content">{note.content}</p>}
        {note.attachments.length > 0 && <div className="note-reader-attachments"><h3>Allegati</h3>{note.attachments.map(file => <div className="attachment-row" key={file.id}><Paperclip size={16} /><a href={`/api/attachments/${file.id}`}>{file.original_name}</a></div>)}</div>}
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Chiudi</button></div>
    </Modal>;
  }
  if (dialog.type === 'budget') return <BudgetDialog data={data} onClose={onClose} mutate={mutate} />;
  if (dialog.type === 'goal') return <Modal title={dialog.goal ? 'Modifica il vostro progetto' : 'Un nuovo progetto, insieme'} subtitle="Dategli un nome e una meta da raggiungere." onClose={onClose}><form onSubmit={e => submit(e, async form => {
    await mutate(dialog.goal ? `/goals/${dialog.goal.id}` : '/goals', dialog.goal ? 'PUT' : 'POST', { title: form.get('title'), horizon: form.get('horizon'), target: parseMoney(String(form.get('target'))), saved: parseMoney(String(form.get('saved') || '0')), dueDate: form.get('dueDate') || null });
  })}><label>Nome dell’obiettivo<input name="title" defaultValue={dialog.goal?.title} placeholder="Ad esempio: il nostro prossimo viaggio" required maxLength={120} /></label><label>Orizzonte<select name="horizon" defaultValue={dialog.goal?.horizon}><option value="short">Breve termine · fino a 1 anno</option><option value="medium">Medio termine · da 1 a 5 anni</option><option value="long">Lungo termine · oltre 5 anni</option></select></label><div className="form-columns"><label>Importo da raggiungere (€)<input name="target" defaultValue={dialog.goal ? toInput(dialog.goal.target) : undefined} inputMode="decimal" placeholder="0,00" pattern="[0-9]+([.,][0-9]{1,2})?" required /></label>{!dialog.goal && <label>Già accantonato (€)<input name="saved" inputMode="decimal" defaultValue="0" pattern="[0-9]+([.,][0-9]{1,2})?" /></label>}</div><label>Entro quando? <span className="optional">facoltativo</span><input name="dueDate" defaultValue={dialog.goal?.due_date || undefined} type="date" min="1900-01-01" max="2199-12-31" /></label>{errors}{footer(dialog.goal ? 'Salva modifiche' : 'Crea obiettivo')}</form></Modal>;
  if (dialog.type === 'contribution') return <SavingsDialog goalId={dialog.goal.id} data={data} onClose={onClose} mutate={mutate} />;
  if (dialog.type === 'note') {
    const note = dialog.note;
    const existingFiles = note?.attachments.filter(a => !removed.includes(a.id)) || [];
    return <Modal title={note ? 'Modifica appunto' : 'Un pensiero sulla lavagna'} subtitle="Le cose da ricordare, a portata di tutta la famiglia." onClose={onClose}><form onSubmit={e => submit(e, async form => {
      const body = { title: form.get('title'), content: form.get('content'), color, pinned: form.get('pinned') === 'on' };
      let id = noteId;
      if (id) await mutate(`/notes/${id}`, 'PUT', body);
      else { const result = await mutate<{ id: string }>('/notes', 'POST', body); id = result.id; setNoteId(id); }
      for (const file of files) {
        const upload = new FormData(); upload.append('file', file);
        await mutate(`/notes/${id}/attachments`, 'POST', upload);
        setFiles(remaining => remaining.filter(f => f !== file));
      }
    })}><label>Titolo<input name="title" defaultValue={note?.title} placeholder="Ad esempio: cose da fare nel weekend" required maxLength={120} /></label><div className="field"><label htmlFor="note-content">Appunto</label><textarea id="note-content" name="content" defaultValue={note?.content} placeholder="Scrivi qui il tuo promemoria…" rows={5} maxLength={10000} /></div><div className="note-options"><div className="color-picker" role="group" aria-label="Colore dell’appunto">{[['amber', 'Giallo'], ['mint', 'Verde'], ['blue', 'Azzurro'], ['rose', 'Rosa'], ['neutral', 'Neutro']].map(([id, name]) => <button type="button" key={id} className={`color-choice note-${id} ${color === id ? 'selected' : ''}`} aria-label={name} aria-pressed={color === id} onClick={() => setColor(id)}>{color === id && <Check size={15} />}</button>)}</div><label className="checkbox-label"><input type="checkbox" name="pinned" defaultChecked={!!note?.pinned} />Metti in evidenza</label></div><div className="attachment-editor"><label className="upload-label"><Paperclip size={17} />Allega file<input type="file" multiple disabled={pending} onChange={e => {
      const selected = Array.from(e.target.files || []);
      if (selected.some(f => f.size > 10 * 1024 * 1024)) { setError('Ogni file può pesare al massimo 10 MB.'); e.target.value = ''; return; }
      if (selected.length + files.length + existingFiles.length > 5) { setError('Puoi allegare al massimo 5 file.'); e.target.value = ''; return; }
      setError(''); setFiles([...files, ...selected]); e.target.value = '';
    }} /></label><span>Fino a 5 file · 10 MB ciascuno</span></div>{existingFiles.map(file => <div className="attachment-row" key={file.id}><Paperclip size={14} /><a href={`/api/attachments/${file.id}`}>{file.original_name}</a><button type="button" className="icon-button danger" aria-label={`Rimuovi allegato ${file.original_name}`} disabled={pending} onClick={() => { if (confirm('Rimuovere questo allegato?')) void save(async () => { await mutate(`/attachments/${file.id}`, 'DELETE'); setRemoved([...removed, file.id]); }, false); }}><Trash2 size={14} /></button></div>)}{files.map((file, index) => <div className="attachment-row" key={`${file.name}-${index}`}><Paperclip size={14} /><span>{file.name}</span><small>da caricare</small><button type="button" className="icon-button danger" aria-label={`Rimuovi file ${file.name}`} disabled={pending} onClick={() => setFiles(files.filter((_, i) => i !== index))}><Trash2 size={14} /></button></div>)}{errors}{footer(note ? 'Salva modifiche' : 'Pubblica sulla lavagna')}</form></Modal>;
  }
  return null;
}
