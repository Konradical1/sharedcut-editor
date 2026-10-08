import { useState, useEffect } from 'react';
import { ArrowRight, Check, Eye, EyeOff, Users } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { Brand, Button } from './ui';
import './dashboard.css';
import { api } from '../services/api';
import { connectSession } from '../services/sync';

export default function AuthScreen({ onDone }: { onDone: () => void }) {
  const { users, currentUserId, setUserProfile, setUserColor, notify } = useEditorStore();
  const currentUser = users.find(user => user.id === currentUserId) ?? users[0];
  const [signUp, setSignUp] = useState(window.location.pathname === '/signup');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteCode,setInviteCode]=useState('');
  const [requiresCode,setRequiresCode]=useState(false);
  useEffect(()=>{void api('/auth/me').then(result=>setRequiresCode(!!result.registrationRequiresCode)).catch(()=>{});},[]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [color, setColor] = useState(currentUser?.color ?? '#f07878');
  const [error, setError] = useState('');
  const colors = ['#F06A70', '#B298F5', '#78AAEF', '#EBC876', '#87C9AC', '#ED99C4'];
  return <main className="auth-screen"><section className="auth-art" style={{ backgroundImage: 'url(/brand/close-up-timeline.png)' }}><a className="dash-brand" href="/" onClick={event => { event.preventDefault(); onDone(); }}><Brand /></a></section><section className="auth-form-side"><div className="auth-form-content"><span className="auth-form-symbol"><img src="/brand/sharedcut-logo.png" width="30" height="30" alt="SharedCut" /></span><span className="dash-local-badge"><span /> YOUR STUDIO</span><h2>{signUp ? 'Create account' : 'Sign in'}</h2><div className="auth-mode" role="group" aria-label="Account form"><button aria-pressed={!signUp} className={!signUp ? 'active' : ''} onClick={() => { setSignUp(false); setError(''); }}>Sign in</button><button aria-pressed={signUp} className={signUp ? 'active' : ''} onClick={() => { setSignUp(true); setError(''); }}>Create account</button></div><form onSubmit={async event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await api(signUp?'/auth/signup':'/auth/login',{method:'POST',body:JSON.stringify({name:name.trim(),email:email.trim(),password,inviteCode})}); if(signUp)await api('/auth/profile',{method:'PATCH',body:JSON.stringify({color})}); await connectSession(); onDone(); } catch(error){setError(error instanceof Error?error.message:'Unable to sign in.');}finally{setBusy(false);} }}>
      {signUp && <label className="form-field">Your name<input className="input" autoComplete="name" value={name} onChange={event => setName(event.target.value)} placeholder="Your name" required maxLength={80} /></label>}
      <label className="form-field">Email address<input className="input" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@yourstudio.com" required /></label><label className="form-field">Password<div className="auth-password"><input className="input" type={showPassword ? 'text' : 'password'} autoComplete={signUp ? 'new-password' : 'current-password'} value={password} onChange={event => { setPassword(event.target.value); setError(''); }} placeholder="At least 8 characters" minLength={8} required /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
      {signUp&&requiresCode&&<label className="form-field">Studio registration code<input className="input" value={inviteCode} onChange={e=>setInviteCode(e.target.value)} required autoComplete="off"/></label>}
      {signUp && <fieldset className="auth-color-field"><legend>Your collaboration color</legend><div className="auth-colors">{colors.map(item => <button key={item} type="button" style={{ background: item }} className={color === item ? 'active' : ''} aria-label={`Choose color ${item}`} aria-pressed={color === item} onClick={() => setColor(item)}>{color === item && <Check size={16} />}</button>)}</div><small>Used for your cursor, playhead, and selections.</small></fieldset>}
      {error && <p className="auth-error" role="alert">{error}</p>}<Button type="submit" variant="primary" disabled={busy}>{busy?'Connecting…':signUp?'Create account':'Sign in'}<ArrowRight size={16} /></Button></form><div className="auth-demo-note"><Users size={17} /><p>Your account and projects live on your studio server. Shared class projects are available to signed-in members.</p></div><a className="auth-skip" href="/importer">Bringing a Final Cut project? Import it without an account <ArrowRight size={13}/></a></div></section></main>;
}
