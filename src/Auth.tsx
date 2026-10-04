import { useState, useEffect, type FormEvent } from 'react';
import { ArrowRight, Check, Heart, ShieldCheck, Users, Wallet, ShoppingBasket, StickyNote } from 'lucide-react';
import { api, setCsrf } from './api';
import { Logo } from './components';
import type { User } from './types';

export default function Auth({ onLogin, onReset }: { onLogin: (user: User) => void; onReset: () => void }) {
  const [resetToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('reset') || '');
  const [mode, setMode] = useState<'register' | 'login' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'register');
  const [notice, setNotice] = useState('');
  const [inviteCode] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('invite') || '');
  const [joining, setJoining] = useState(!!inviteCode);
  useEffect(() => { if (inviteCode || resetToken) window.history.replaceState(null, '', window.location.pathname + window.location.search); }, [inviteCode, resetToken]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice(''); setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      if (mode === 'forgot') {
        const result = await api<{ message: string }>('/auth/forgot-password', 'POST', { email: form.get('email') });
        setNotice(result.message); return;
      }
      if (mode === 'reset') {
        if (form.get('newPassword') !== form.get('confirmPassword')) throw new Error('Le nuove password non coincidono.');
        await api('/auth/reset-password', 'POST', { token: resetToken, newPassword: form.get('newPassword') });
        onReset(); setMode('login'); setNotice('Password aggiornata. Accedi con la nuova password.'); return;
      }
      const result = await api<{ user: User; csrf: string }>(`/auth/${mode}`, 'POST', Object.fromEntries(form));
      setCsrf(result.csrf); onLogin(result.user);
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  }
  return <div className="auth-layout"><section className="auth-story"><Logo /><div className="auth-copy"><span className="eyebrow"><Heart size={14} /> PICCOLE COSE, INSIEME</span><h1>Una casa organizzata.<br /><em>Più spazio per voi.</em></h1><p>Conti, progetti e cose da ricordare.<br />Tutta la vita di famiglia, in un posto solo.</p><div className="auth-illustration" aria-hidden="true"><div className="illustration-card budget-preview"><Wallet size={23} /><span>Il nostro mese</span><strong>Tutto sotto controllo</strong><div className="preview-bars"><i /><i /><i /><i /><i /><i /></div></div><div className="illustration-card shopping-preview"><ShoppingBasket size={20} /><strong>Per la cena di stasera</strong><span><Check size={14} /> Pomodori</span><span><Check size={14} /> Pasta fresca</span><span className="unchecked">Basilico</span></div><div className="illustration-note"><StickyNote size={19} /><span>Il prossimo progetto?<br /><b>Decidiamolo insieme.</b></span></div><span className="illustration-spark">✳</span></div><div className="auth-benefits"><span><ShieldCheck size={17} /> Uno spazio riservato</span><span><Users size={17} /> Per tutta la famiglia</span></div></div><p className="auth-footer">Meno cose da gestire. Più cose da vivere.</p></section><section className="auth-form-section"><div className="auth-form"><span className="eyebrow">BENVENUTI IN FAMILY HUB</span><h2>{mode === 'register' ? 'Cominciamo da qui.' : mode === 'forgot' ? 'Recupera il tuo accesso.' : mode === 'reset' ? 'Una nuova password.' : 'Bello ritrovarti.'}</h2><p>{mode === 'register' ? 'Crea il tuo account e organizza il vostro spazio.' : mode === 'forgot' ? 'Inserisci la tua email per ricevere un link valido 30 minuti.' : mode === 'reset' ? 'Scegli una password di almeno 10 caratteri.' : 'Accedi al tuo spazio di famiglia.'}</p>{(mode === 'register' || mode === 'login') && <div className="segmented"><button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError(''); setNotice(''); }}>Crea account</button><button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); setNotice(''); }}>Accedi</button></div>}{notice && <div className="auth-notice" role="status">{notice}</div>}<form key={mode} onSubmit={submit}>{mode === 'register' && <label>Il tuo nome<input name="name" autoComplete="name" placeholder="Come ti chiami?" required maxLength={80} /></label>}{mode === 'reset' ? <><label>Nuova password<input name="newPassword" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /></label><label>Conferma nuova password<input name="confirmPassword" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /></label></> : <><label>Email<input name="email" type="email" autoComplete="email" placeholder="nome@esempio.it" required maxLength={254} /></label>{mode !== 'forgot' && <label>Password<input name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} placeholder={mode === 'register' ? 'Almeno 10 caratteri' : 'La tua password'} minLength={mode === 'register' ? 10 : 1} maxLength={128} required /></label>}</>}{mode === 'register' && <><div className="join-choice"><button type="button" className={!joining ? 'selected' : ''} onClick={() => setJoining(false)}>Creo una famiglia</button><button type="button" className={joining ? 'selected' : ''} onClick={() => setJoining(true)}>Ho un invito</button></div>{joining ? <label>Codice invito<input name="inviteCode" defaultValue={inviteCode} placeholder="Il codice ricevuto dalla tua famiglia" required maxLength={30} /></label> : <label>Nome del vostro spazio<input name="householdName" placeholder="Ad esempio: Casa Rossi" required maxLength={80} /></label>}</>}{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary auth-submit" disabled={pending}>{pending ? 'Un momento…' : mode === 'register' ? 'Entra a casa' : mode === 'forgot' ? 'Invia link di recupero' : mode === 'reset' ? 'Reimposta password' : 'Accedi'}<ArrowRight size={18} /></button></form>{mode === 'login' && <button className="text-button auth-recovery-link" type="button" onClick={() => { setMode('forgot'); setError(''); setNotice(''); }}>Password dimenticata?</button>}{(mode === 'forgot' || mode === 'reset') && <button className="text-button auth-recovery-link" type="button" onClick={() => { setMode('login'); setError(''); setNotice(''); }}>Torna ad Accedi</button>}<p className="auth-small">{mode === 'register' ? 'Ogni persona ha il proprio account. Potrai invitare gli altri membri dal tuo spazio.' : 'Il tuo spazio e i tuoi dati ti aspettano.'}</p></div></section></div>;
}
