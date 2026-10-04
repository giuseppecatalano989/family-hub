import { useEffect, useRef, type ReactNode } from 'react';
import { X, Plus, ArrowUpRight } from 'lucide-react';

export function Logo({ small = false }: { small?: boolean }) {
  return <div className={`logo ${small ? 'small' : ''}`}><img className="logo-mark" src="/family-hub.svg" alt="" /><span>Family Hub<span className="logo-dot">.</span></span></div>;
}
export function Modal({ title, subtitle, children, onClose }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input, button, textarea, select')?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]') || []);
        const first = items[0]; const last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handler); before?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" aria-label="Chiudi finestra" onClick={onClose}><X size={20} /></button></div>{children}</div></div>;
}
export function Empty({ icon, title, description, action, onAction }: { icon: ReactNode; title: string; description: string; action?: string; onAction?: () => void }) {
  return <div className="empty"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{description}</p>{action && <button className="button secondary" onClick={onAction}><Plus size={16} />{action}</button>}</div>;
}
export function Progress({ value, color = 'var(--green)' }: { value: number; color?: string }) {
  return <div className="progress" role="progressbar" aria-valuenow={Math.round(Math.max(0, value))} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} /></div>;
}
export function SectionHeading({ title, action, onAction }: { title: ReactNode; action?: string; onAction?: () => void }) {
  return <div className="section-heading"><h2>{title}</h2>{action && <button className="text-button" onClick={onAction}>{action}<ArrowUpRight size={16} /></button>}</div>;
}
