import { PiggyBank } from 'lucide-react';
import Account from './Account';
import { SectionHeading } from './components';
import { Backups, type WorkflowProps } from './WorkflowPages';
import type { User } from './types';
import type { Page } from './pages';

type Props = WorkflowProps & { user: User; onUser: (user: User) => void; mutate: <T>(path: string, method: string, body?: unknown) => Promise<T>; navigate: (page: Page) => void };

// Family-wide and personal settings gathered in one place.
export function Settings(props: Props) {
  const { data, act, busy, navigate } = props;
  const planned = data.goals.filter(g => g.monthly > 0 && g.saved < g.target);
  return <div className="settings-page">
    <Account {...props} scope="settings" />
    <section className="panel planning-section bank-strategy"><SectionHeading title="Ripartizione dei risparmi" />
      <div className="bank-strategy-body">
        <p>I versamenti verso conti risparmio e investimento vengono divisi da soli tra gli obiettivi, secondo l’accantonamento mensile di ciascuno.{planned.length ? ` Obiettivi con quota: ${planned.map(g => `${g.title}${g.is_primary ? ' (primario)' : ''}`).join(', ')}.` : ''}</p>
        <label>Se il risparmio del mese non copre tutte le quote<select value={data.bank.savingsStrategy} disabled={busy} onChange={e => void act('/savings/strategy', 'PUT', { strategy: e.target.value }).catch(() => {})}><option value="primary">Priorità all’obiettivo primario</option><option value="proportional">In proporzione alle quote mensili</option></select></label>
        {!planned.length && <button className="text-button" onClick={() => navigate('goals')}><PiggyBank size={15} />Imposta le quote mensili in Obiettivi</button>}
      </div>
    </section>
    <section className="planning-section"><SectionHeading title="Backup" /><Backups {...props} /></section>
  </div>;
}
