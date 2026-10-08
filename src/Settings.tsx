import { useEffect, useState } from 'react';
import { Bell, LayoutDashboard, Landmark, PiggyBank, ShieldCheck, Users } from 'lucide-react';
import Account from './Account';
import { Bank } from './Bank';
import { DashboardSettings } from './DashboardSettings';
import { NotificationSettings } from './NotificationSettings';
import { SectionHeading } from './components';
import { money } from './finance';
import { Backups, type WorkflowProps } from './WorkflowPages';
import type { User } from './types';
import type { Page } from './pages';

type Props = WorkflowProps & { user: User; onUser: (user: User) => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T>; navigate: (page: Page) => void };
type Category = 'conti' | 'panoramica' | 'notifiche' | 'famiglia' | 'backup';

const categories: { id: Category; label: string; description: string; icon: typeof Landmark }[] = [
  { id: 'conti', label: 'Conti bancari', description: 'Collegamenti e risparmi', icon: Landmark },
  { id: 'panoramica', label: 'Panoramica', description: 'Card e pulsanti', icon: LayoutDashboard },
  { id: 'notifiche', label: 'Notifiche', description: 'Cosa e dove', icon: Bell },
  { id: 'famiglia', label: 'Casa e famiglia', description: 'Nome e inviti', icon: Users },
  { id: 'backup', label: 'Backup e dati', description: 'Copie e ZIP', icon: ShieldCheck },
];

// The bank redirect still lands on #bank; categories live in #settings/<category>.
export function categoryFromHash(): Category {
  const value = window.location.hash.slice(1);
  if (value === 'bank') return 'conti';
  if (value === 'settings/preferenze') return 'panoramica';
  const id = value.startsWith('settings/') ? value.slice(9) : '';
  return categories.some(c => c.id === id) ? id as Category : 'conti';
}

// Family-wide and personal settings, grouped by category.
export function Settings(props: Props) {
  const { data, act, busy, navigate } = props;
  const [category, setCategory] = useState<Category>(categoryFromHash);
  useEffect(() => { const handler = () => setCategory(categoryFromHash()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  const choose = (next: Category) => { setCategory(next); window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#settings/${next}`); };
  const planned = data.goals.filter(g => g.monthly > 0 && g.saved < g.target);
  const current = categories.find(c => c.id === category)!;
  return <div className="settings-page">
    <div className="settings-tabs" role="tablist" aria-label="Categorie delle impostazioni">{categories.map(c => <button key={c.id} type="button" role="tab" id={`settings-tab-${c.id}`} aria-controls="settings-panel" aria-selected={c.id === category} className={`settings-tab ${c.id === category ? 'active' : ''}`} onClick={() => choose(c.id)}><c.icon size={19} strokeWidth={1.8} /><span><strong>{c.label}</strong><small>{c.description}</small></span></button>)}</div>
    <div className="settings-panel" role="tabpanel" id="settings-panel" aria-labelledby={`settings-tab-${current.id}`}>
      {category === 'conti' && <>
        <Bank data={data} act={act} busy={busy} navigate={navigate} />
        <section className="panel planning-section bank-strategy"><SectionHeading title="Ripartizione dei risparmi" />
          <div className="bank-strategy-body">
            <p>Il saldo dei conti segnati come risparmio è diviso tutto tra gli obiettivi, secondo l’accantonamento mensile di ciascuno, e così ogni nuovo versamento. Per un versamento mirato usa Aggiungi risparmio nell’obiettivo: la quota viene tolta prima agli altri obiettivi.{planned.length ? ` Obiettivi con quota: ${planned.map(g => `${g.title}${g.is_primary ? ' (primario)' : ''}`).join(', ')}.` : ''}</p>
            <label>Se il risparmio del mese non copre tutte le quote<select value={data.bank.savingsStrategy} disabled={busy} onChange={e => void act('/savings/strategy', 'PUT', { strategy: e.target.value }).catch(() => {})}><option value="primary">Priorità all’obiettivo primario</option><option value="proportional">In proporzione alle quote mensili</option></select></label>
            {data.bank.savingsUnassigned > 0 && <p role="status">Da assegnare: {money(data.bank.savingsUnassigned)}. Nessun obiettivo con quota mensile può ancora riceverlo: aggiungi una quota o un nuovo obiettivo.</p>}
            {!planned.length && <button className="text-button" onClick={() => navigate('goals')}><PiggyBank size={15} />Imposta le quote mensili in Obiettivi</button>}
          </div>
        </section>
      </>}
      {category === 'panoramica' && <DashboardSettings data={data} mutate={props.mutate} />}
      {category === 'notifiche' && <NotificationSettings data={data} mutate={props.mutate} />}
      {category === 'famiglia' && <Account {...props} scope="household" />}
      {category === 'backup' && <Backups {...props} />}
    </div>
  </div>;
}
