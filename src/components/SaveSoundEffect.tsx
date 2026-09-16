import { useEffect, useRef, useState } from 'react';
import { api, connection } from '../services/api';
import { soundCategories, type SoundEffect } from '../services/sfx';
import { useEditorStore } from '../state/store';
import type { Clip } from '../state/models';
import { Modal, Field, Button } from './ui';
import './sfx.css';
export default function SaveSoundEffect({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const close = useRef(onClose); close.current = onClose;
  const [name, setName] = useState(clip.name.replace(/\.[^.]+$/, '')), [tags, setTags] = useState(''), [category, setCategory] = useState('Everyday Sounds');
  const [categories, setCategories] = useState(soundCategories), [error, setError] = useState(''), [busy, setBusy] = useState(false), [pending, setPending] = useState<string | null>(null);
  useEffect(() => { void api('/sfx').then(data => setCategories([...new Set<string>([...soundCategories, ...data.categories])])).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    const timer = setInterval(() => { void api<{ sounds: SoundEffect[] }>('/sfx').then(({ sounds }) => {
      if (stopped) return; const sound = sounds.find(s => s.id === pending);
      if (sound?.status === 'ready') { stopped = true; clearInterval(timer); window.dispatchEvent(new Event('sfx-saved')); useEditorStore.getState().notify(`${sound.name} saved to SFX`, 'success'); close.current(); }
      else if (sound?.status === 'failed') { setError(sound.error || 'Could not save this sound.'); setBusy(false); setPending(null); }
    }).catch(e => { if (!stopped) { setError(e.message); setBusy(false); setPending(null); } }); }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [pending]);
  return <Modal title="Save as Sound Effect" onClose={onClose}><form onSubmit={async e => {
    e.preventDefault(); if (busy) return; setError(''); setBusy(true);
    try { await connection.flush(); const { sound } = await api<{ sound: SoundEffect }>('/sfx', { method: 'POST', body: JSON.stringify({ projectId: clip.projectId, clipId: clip.id, name, category, tags: tags.split(',').map(t => t.trim()).filter(Boolean), description: '' }) }); setPending(sound.id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save sound.'); setBusy(false); }
  }}><div className="modal-body sfx-save">
    <p>Save this {clip.duration.toFixed(2)}s trim with its clip audio settings baked in. The saved sound is available to everyone on this installation.</p>
    <Field label="Name"><input autoFocus required maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)}/></Field>
    <Field label="Tags"><input placeholder="e.g. suspense, transition, airy" value={tags} disabled={busy} onChange={e => setTags(e.target.value)}/></Field><small>Separate tags with commas.</small>
    <Field label="Category"><input required maxLength={50} list="sfx-category-options" value={category} disabled={busy} onChange={e => setCategory(e.target.value)}/><datalist id="sfx-category-options">{categories.map(c => <option key={c} value={c}/>)}</datalist></Field><small>Choose a category or type a new one.</small>
    {error && <p role="alert" className="danger-text">{error}</p>}{pending && <p role="status">Preparing your sound… You can close this panel; saving continues.</p>}
  </div><div className="modal-actions"><Button onClick={onClose}>{pending ? 'Close' : 'Cancel'}</Button><Button type="submit" variant="primary" disabled={busy}>{busy ? 'Saving…' : 'Save sound effect'}</Button></div></form></Modal>;
}
