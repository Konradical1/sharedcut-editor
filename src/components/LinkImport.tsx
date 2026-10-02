import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { api, connection } from '../services/api';
import { useEditorStore } from '../state/store';

/** Paste-a-link row inside the media panel's add popover. */
export default function LinkImport({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('video');
  const [quality, setQuality] = useState(1080);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  let spotify = false;
  try { spotify = new URL(url.trim()).hostname === 'open.spotify.com'; } catch { /* Still typing. */ }
  return <form className="media-link" onSubmit={async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      if (!connection.enabled) throw new Error('Connect to the SharedCut server to import links.');
      await connection.flush();
      const { asset } = await api('/media/import-link', { method: 'POST', body: JSON.stringify({ projectId, url, mode: spotify ? 'audio' : mode, quality }) });
      await connection.refresh();
      useEditorStore.getState().revealMedia(asset.id);
      onDone();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }}>
    <div className="media-link-input"><Link2 size={14} /><input type="url" required autoFocus aria-label="YouTube video or Spotify track link" placeholder="Paste a YouTube or Spotify link…" value={url} onChange={event => { setUrl(event.target.value); setError(''); }} /></div>
    <div className="media-link-options">
      <select aria-label="Import as" value={spotify ? 'audio' : mode} disabled={spotify} onChange={event => setMode(event.target.value)}><option value="video">Video + audio</option><option value="audio">Audio only</option></select>
      {!spotify && mode === 'video' && <select aria-label="Maximum quality" value={quality} onChange={event => setQuality(Number(event.target.value))}><option value={720}>720p</option><option value={1080}>1080p</option><option value={2160}>4K</option></select>}
      <button type="submit" className="media-link-go" disabled={busy || !url.trim()}>{busy ? 'Starting…' : 'Import'}</button>
    </div>
    {spotify && <p className="muted">Finds a matching recording on YouTube; it may be a different version.</p>}
    {error && <p role="alert">{error}</p>}
  </form>;
}
