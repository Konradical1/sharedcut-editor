import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
import { X, FolderOpen } from 'lucide-react';
import { motion } from 'motion/react';
import type { User } from '../state/models';

export function Button({ variant = 'secondary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'secondary' | 'danger' }) {
  return <button type="button" className={`button button-${variant} ${className}`} {...props} />;
}
export function IconButton({ label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" title={label} aria-label={label} className={`icon-button ${className}`} {...props} />;
}
export function Avatar({ user, size = 28 }: { user: User; size?: number }) {
  return <span className="avatar" title={user.name} style={{ '--user-color': user.color, width: size, height: size, fontSize: size * .34 } as CSSProperties}>{user.initials}</span>;
}
export function Badge({ children, color, className = '' }: { children: ReactNode; color?: string; className?: string }) {
  return <span className={`badge ${className}`} style={color ? { color, borderColor: `${color}40`, background: `${color}12` } : undefined}>{children}</span>;
}
/** The app's only number field: type freely, commit on blur, clamp silently. Native min/max would argue mid-keystroke and pop a browser bubble. */
export function NumberInput({ value, min = -Infinity, max = Infinity, step = 1, decimals = 3, onCommit, onFocus, onBlur, onKeyDown, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'type'> & { value: number | undefined; min?: number; max?: number; step?: number; decimals?: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const shown = draft ?? (value === undefined ? '' : String(Number(value.toFixed(decimals))));
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  // Blur and Enter are the only moments a half-typed number gets corrected; '', '-', '1.' and '00' all survive until then.
  const settle = (raw: string) => { setDraft(null); const n = Number(raw); if (raw.trim() && Number.isFinite(n) && clamp(n) !== value) onCommit(clamp(n)); };
  return <input {...props} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={shown}
    onChange={e => { const raw = e.currentTarget.value; if (!/^-?\d*\.?\d*$/.test(raw)) return; setDraft(raw); const n = Number(raw); if (raw.trim() && Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n); }}
    onFocus={e => { setDraft(shown); onFocus?.(e); }}
    onBlur={e => { if (cancelled.current) { cancelled.current = false; setDraft(null); } else settle(e.currentTarget.value); onBlur?.(e); }}
    onKeyDown={e => {
      if (e.key === 'Enter') settle(e.currentTarget.value);
      else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); const next = clamp(Number(((value ?? 0) + step * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)).toFixed(6))); setDraft(String(next)); if (next !== value) onCommit(next); }
      onKeyDown?.(e);
    }}/>;
}
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}</label>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); dialog?.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=hidden]), textarea')?.focus(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-label={title} onCancel={onClose} onClick={e => { if (e.target === ref.current) { const r = ref.current.getBoundingClientRect(); if(e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <motion.div initial={{ opacity: 0, y: 9 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .18 }}>
      <header className="modal-heading"><h2>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={18}/></IconButton></header>{children}
    </motion.div>
  </dialog>;
}
export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return <div className="empty-state">{icon ?? <FolderOpen size={30}/>}<h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}
export { timecode } from '../services/timecode';
export function durationLabel(seconds: number) { return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
/** 23.976023976023978 is a true frame rate but not a readable one; three decimals covers every NTSC rate. */
export function fpsLabel(fps: number | undefined, fallback = 24) { return String(Number((fps ?? fallback).toFixed(3))); }
export function Brand({ compact = false }: { compact?: boolean }) {
  return <span className="brand"><img className="brand-mark" src="/brand/sharedcut-logo-colored.png" width="30" height="30" alt={compact ? 'SharedCut' : ''} />{!compact && <span>SharedCut<span className="brand-period">.</span></span>}</span>;
}
export function ContextMenu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) closeRef.current(); };
    const key = (e: KeyboardEvent) => { if(e.key === 'Escape') closeRef.current(); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', key); };
  }, []);
  return <motion.div ref={ref} className="context-menu" role="menu" initial={{opacity:0,scale:.97}} animate={{opacity:1,scale:1}} style={{left: Math.min(x, window.innerWidth - 242), top: Math.max(8, Math.min(y, window.innerHeight - 480))}} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const items = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); } }}>{children}</motion.div>;
}
