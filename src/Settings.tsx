import { useEffect, useState } from 'react';
import { Landmark, PiggyBank, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import Account from './Account';
import { Bank } from './Bank';
import { SectionHeading } from './components';
import { Backups, type WorkflowProps } from './WorkflowPages';
import type { User } from './types';
import type { Page } from './pages';

type Props = WorkflowProps & { user: User; onUser: (user: User) => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T>; navigate: (page: Page) => void };
type Category = 'conti' | 'preferenze' | 'famiglia' | 'backup';

const categories: { id: Category; label: string; description: string; icon: typeof Landmark }[] = [
  { id: 'conti', label: 'Conti bancari', description: 'Collegamenti, condivisione e risparmi', icon: Landmark },
  { id: 'preferenze', label: 'Preferenze', description: 'Le tue scelte personali', icon: SlidersHorizontal },
  { id: 'famiglia', label: 'Casa e famiglia', description: 'Nome, membri e inviti', icon: Users },
  { id: 'backup', label: 'Backup e dati', description: 'Copie e esportazione', icon: ShieldCheck },
];

// The bank redirect still lands on #bank; categories live in #settings/<category>.
export function categoryFromHash(): Category {
  const value = window.location.hash.slice(1);
  if (value === 'bank') return 'conti';
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
            <p>I versamenti verso conti risparmio e investimento vengono divisi da soli tra gli obiettivi, secondo l’accantonamento mensile di ciascuno.{planned.length ? ` Obiettivi con quota: ${planned.map(g => `${g.title}${g.is_primary ? ' (primario)' : ''}`).join(', ')}.` : ''}</p>
            <label>Se il risparmio del mese non copre tutte le quote<select value={data.bank.savingsStrategy} disabled={busy} onChange={e => void act('/savings/strategy', 'PUT', { strategy: e.target.value }).catch(() => {})}><option value="primary">Priorità all’obiettivo primario</option><option value="proportional">In proporzione alle quote mensili</option></select></label>
            {!planned.length && <button className="text-button" onClick={() => navigate('goals')}><PiggyBank size={15} />Imposta le quote mensili in Obiettivi</button>}
          </div>
        </section>
      </>}
      {category === 'preferenze' && <Account {...props} scope="preferences" />}
      {category === 'famiglia' && <Account {...props} scope="household" />}
      {category === 'backup' && <Backups {...props} />}
    </div>
  </div>;
}
