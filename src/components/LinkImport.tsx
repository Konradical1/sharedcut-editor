import { useState } from 'react';
import { api, connection } from '../services/api';
import { useEditorStore } from '../state/store';
import { Button, Field, Modal } from './ui';

export default function LinkImport({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('video');
  const [quality, setQuality] = useState(1080);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  let spotify = false;
  try { spotify = new URL(url.trim()).hostname === 'open.spotify.com'; } catch { /* Still typing. */ }
  return <Modal title="Import link" onClose={onClose}>
    <form onSubmit={async event => {
      event.preventDefault(); if (busy) return;
      setBusy(true); setError('');
      try {
        if (!connection.enabled) throw new Error('Connect to the SharedCut server to import links.');
        await connection.flush();
        const { asset } = await api('/media/import-link', { method: 'POST', body: JSON.stringify({ projectId, url, mode: spotify ? 'audio' : mode, quality }) });
        await connection.refresh();
        useEditorStore.getState().revealMedia(asset.id);
        onClose();
      } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
    }}>
      <div className="modal-body">
        <Field label="YouTube video or Spotify track link"><input type="url" required autoFocus placeholder="Paste a YouTube or Spotify link…" value={url} onChange={event => { setUrl(event.target.value); setError(''); }} /></Field>
        <Field label="Import as"><select value={spotify ? 'audio' : mode} disabled={spotify} onChange={event => setMode(event.target.value)}><option value="video">Video + audio</option><option value="audio">Audio only</option></select></Field>
        {!spotify && mode === 'video' && <Field label="Maximum quality"><select value={quality} onChange={event => setQuality(Number(event.target.value))}><option value={720}>720p</option><option value={1080}>1080p</option><option value={2160}>4K</option></select></Field>}
        <p className="muted">{spotify ? 'Spotify links find a matching recording on YouTube. The audio comes from YouTube and may be a different version. Check the recording before editing.' : 'Paste one video or track link. Downloads run on your server and appear in this project’s media bin.'}</p>
        <p className="muted">Import media you own or have permission to use.</p>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="modal-actions"><Button onClick={onClose}>Close</Button><Button type="submit" variant="primary" disabled={busy || !url.trim()}>{busy ? 'Starting…' : spotify ? 'Find & import audio' : 'Import'}</Button></div>
    </form>
  </Modal>;
}
