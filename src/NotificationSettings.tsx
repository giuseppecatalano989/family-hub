import { useEffect, useState } from 'react';
import { Bell, BellOff, Send, Smartphone } from 'lucide-react';
import { SectionHeading } from './components';
import { currentSubscription, pushSupport, subscribe } from './push';
import type { FamilyState, NotificationType } from './types';

type Props = { data: FamilyState; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T> };

const groups: { title: string; items: { id: NotificationType; label: string; hint: string }[] }[] = [
  { title: 'Dalla famiglia', items: [
    { id: 'notes', label: 'Lavagna di famiglia', hint: 'Quando un familiare scrive o modifica un appunto.' },
    { id: 'shopping', label: 'Lista della spesa', hint: 'Quando un familiare aggiunge o spunta prodotti.' },
    { id: 'meals', label: 'Menu settimanale', hint: 'Quando un familiare programma o cambia i pasti.' },
    { id: 'calendar', label: 'Calendario', hint: 'Quando un familiare aggiunge o cambia un evento, e la sera prima degli eventi.' },
  ] },
  { title: 'Promemoria della sera', items: [
    { id: 'deadlines', label: 'Scadenze', hint: 'In arrivo secondo il promemoria scelto, o passate senza essere gestite.' },
    { id: 'waste', label: 'Conferimento rifiuti', hint: 'Cosa portare fuori il giorno dopo, e a che ora.' },
  ] },
  { title: 'Soldi', items: [
    { id: 'budget', label: 'Budget', hint: 'Quando una categoria supera il massimale del mese, una volta al mese, e quando è pronto un report dei consigli.' },
    { id: 'bank', label: 'Banca', hint: 'Nuove uscite da classificare, consenso in scadenza o collegamento in errore.' },
  ] },
];

// Push notifications: turned on per device, chosen per account.
export function NotificationSettings({ data, mutate }: Props) {
  const [types, setTypes] = useState(data.notifications.types);
  const [support, setSupport] = useState(pushSupport);
  const [active, setActive] = useState<boolean | null>(null);
  const [pending, setPending] = useState('');
  const [status, setStatus] = useState<{ error?: string; message?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    // A device already subscribed is confirmed to the server, for example after a restore.
    void currentSubscription().then(async subscription => {
      if (!alive) return;
      setActive(!!subscription);
      if (subscription) await mutate('/notifications/subscriptions', 'POST', subscription.toJSON()).catch(() => undefined);
    }).catch(() => { if (alive) setActive(false); });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function run(name: string, work: () => Promise<string>) {
    setPending(name); setStatus(null);
    try { setStatus({ message: await work() }); } catch (error) { setStatus({ error: (error as Error).message }); } finally { setPending(''); setSupport(pushSupport()); }
  }
  const enable = () => run('enable', async () => {
    const subscription = await subscribe(data.notifications.publicKey);
    await mutate('/notifications/subscriptions', 'POST', subscription.toJSON());
    setActive(true);
    return 'Notifiche attive su questo dispositivo.';
  });
  const disable = () => run('disable', async () => {
    const subscription = await currentSubscription();
    if (subscription) { await mutate('/notifications/subscriptions', 'DELETE', { endpoint: subscription.endpoint }); await subscription.unsubscribe(); }
    setActive(false);
    return 'Notifiche disattivate su questo dispositivo.';
  });
  const test = () => run('test', async () => { await mutate('/notifications/test', 'POST'); return 'Notifica di prova inviata: dovrebbe arrivare tra pochi secondi.'; });
  function toggle(id: NotificationType, value: boolean) {
    const previous = types; setTypes({ ...types, [id]: value }); setStatus(null);
    void mutate('/notifications/preferences', 'PUT', { types: { [id]: value } }).then(() => setStatus({ message: 'Modifiche salvate.' })).catch(error => { setTypes(previous); setStatus({ error: (error as Error).message }); });
  }
  const devices = data.notifications.devices;
  return <div className="settings-panel">
    {status?.error && <div className="form-error" role="alert">{status.error}</div>}
    {status?.message && <p className="settings-success" role="status">{status.message}</p>}
    <section className="panel settings-card"><SectionHeading title="Su questo dispositivo" /><div className="settings-body"><span className="settings-icon"><Smartphone size={25} /></span>
      {support === 'install' ? <div className="notification-help"><strong>Su iPhone e iPad le notifiche arrivano solo dall’app sulla schermata Home.</strong><ol><li>Apri Family Hub in Safari.</li><li>Tocca Condividi, poi “Aggiungi alla schermata Home”.</li><li>Apri Family Hub dall’icona sulla Home e torna qui per attivarle.</li></ol></div>
        : support === 'unsupported' ? <p className="form-hint">Questo browser non supporta le notifiche push. Prova con Chrome, Edge, Firefox o Safari aggiornati.</p>
        : support === 'denied' ? <p className="form-hint">Le notifiche sono bloccate per Family Hub. Consentile dalle impostazioni del browser o del telefono, poi ricarica la pagina.</p>
        : <>
          <p className="notification-state">{active === null ? 'Verifica in corso…' : active ? <><Bell size={16} />Attive su questo dispositivo.</> : <><BellOff size={16} />Non attive su questo dispositivo.</>}</p>
          <div className="notification-actions">{active ? <><button className="button secondary" disabled={!!pending} onClick={() => void disable()}><BellOff size={16} />{pending === 'disable' ? 'Disattivazione…' : 'Disattiva su questo dispositivo'}</button><button className="button secondary" disabled={!!pending} onClick={() => void test()}><Send size={16} />{pending === 'test' ? 'Invio…' : 'Invia una notifica di prova'}</button></>
            : <button className="button primary" disabled={!!pending || active === null} onClick={() => void enable()}><Bell size={16} />{pending === 'enable' ? 'Attivazione…' : 'Attiva su questo dispositivo'}</button>}</div>
        </>}
      <p className="form-hint">{devices === 0 ? 'Nessun dispositivo attivo per il tuo account.' : devices === 1 ? 'Un dispositivo attivo per il tuo account.' : `${devices} dispositivi attivi per il tuo account.`} Attivale su ogni telefono o computer dove vuoi riceverle.</p>
    </div></section>
    <section className="panel settings-card notification-types"><SectionHeading title="Cosa vuoi ricevere" />
      {groups.map(group => <div className="dashboard-group" key={group.title}><h3>{group.title}</h3>
        <ul className="dashboard-card-list">{group.items.map(item => <li key={item.id} className={types[item.id] ? '' : 'is-hidden'}><label className="checkbox-label"><input type="checkbox" checked={types[item.id]} onChange={e => toggle(item.id, e.target.checked)} /><span><strong>{item.label}</strong><small>{item.hint}</small></span></label></li>)}</ul></div>)}
      <div className="panel-tip"><Bell size={18} /><span>Le scelte valgono per il tuo account su tutti i tuoi dispositivi. I promemoria di scadenze e rifiuti arrivano in serata, tra le 18 e le 20 circa; gli altri subito. Non ricevi notifiche per le modifiche fatte da te.</span></div>
    </section>
  </div>;
}
