import { useEffect, useState } from 'react';
import { Square, WandSparkles } from 'lucide-react';
import { useEditorStore } from '../state/store';
import type { Clip } from '../state/models';
import { Badge, Button } from '../components/ui';
import Viewer, { viewerQuality } from '../components/Viewer';
import Timeline from '../components/Timeline';
import { effectDefinitions, initialAmount } from '../services/effects';
import { denoiseSettings, type DenoiseAllStatus, type DenoiseSettings } from '../services/denoise';
import { denoiseCapabilities, type DenoiseCapabilities } from '../services/denoisePreview';
import { setClipActivity } from '../services/clipStatus';
import { api, connection } from '../services/api';
import '../components/depth.css';
import './workspaces.css';
import './denoise.css';

const PARAMS = effectDefinitions['Noise Reduction'].parameters, KIND = 'Denoising';
const noiseOf = (clip: Clip) => clip.effects.find(e => e.name === 'Noise Reduction');
/** The timeline's first Noise Reduction, else the effect's defaults. */
function startingSettings(): DenoiseSettings {
  const s = useEditorStore.getState(), clip = s.clips.find(c => c.timelineId === s.timelineId && noiseOf(c));
  return clip ? denoiseSettings(clip, noiseOf(clip)!) : Object.fromEntries(PARAMS.map(p => [p.key, p.key === 'amount' ? initialAmount('Noise Reduction') : p.initial])) as DenoiseSettings;
}

/** Denoise all: one set of Noise Reduction settings on every video clip of the timeline, denoised on the server ahead of playback
 *  (it carries on with the browser closed). Each clip's bar on the timeline shows how much of it is done. */
export default function DenoiseWorkspace() {
  const projectId = useEditorStore(s => s.projectId), timelineId = useEditorStore(s => s.timelineId), clips = useEditorStore(s => s.clips);
  const quality = viewerQuality(useEditorStore(s => s.settings.viewerQuality));
  const [settings, setSettings] = useState(startingSettings), [run, setRun] = useState<DenoiseAllStatus>(), [busy, setBusy] = useState(false);
  const [capability, setCapability] = useState<DenoiseCapabilities>();
  useEffect(() => { let active = true; void denoiseCapabilities().then(value => { if (active) setCapability(value); }); return () => { active = false; }; }, []);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, running = false;
    const shown = new Set<string>();
    const tick = async () => {
      try {
        const next = await api<DenoiseAllStatus>(`/denoise/all?projectId=${encodeURIComponent(projectId)}`);
        if (!active) return;
        setRun(next); running = next.status === 'running';
        for (const clipId of shown) if (!next.clips[clipId]) { shown.delete(clipId); setClipActivity(clipId, KIND, undefined); }
        for (const [clipId, c] of Object.entries(next.clips)) {
          shown.add(clipId);
          // A stopped run leaves the clips it never finished bare, not stuck at a percentage.
          setClipActivity(clipId, KIND, next.status === 'stopped' && !c.error && c.done < c.total ? undefined
            : { kind: KIND, whole: true, status: c.error ? 'failed' : c.done >= c.total ? 'ready' : 'preparing', progress: c.total ? Math.round(c.done / c.total * 100) : 100, error: c.error });
        }
      } catch { /* A tunnel blip: look again next tick. */ }
      if (active) timer = setTimeout(tick, running ? 1000 : 4000);
    };
    void tick();
    return () => { active = false; clearTimeout(timer); for (const clipId of shown) setClipActivity(clipId, KIND, undefined); };
  }, [projectId]);

  const start = async () => {
    if (!useEditorStore.getState().denoiseAll(settings)) return;
    setBusy(true);
    // The server reads the saved clips.
    try { await connection.flush(); setRun(await api<DenoiseAllStatus>('/denoise/all', { method: 'POST', body: JSON.stringify({ projectId, timelineId, quality }) })); }
    catch (error) { useEditorStore.getState().notify('Denoise all could not start', 'error', (error as Error).message); }
    finally { setBusy(false); }
  };
  const stop = async () => { try { setRun(await api<DenoiseAllStatus>(`/denoise/all?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' })); } catch (error) { useEditorStore.getState().notify('Could not stop Denoise all', 'error', (error as Error).message); } };

  const list = Object.entries(run?.clips ?? {}), done = list.reduce((n, [, c]) => n + c.done, 0), total = list.reduce((n, [, c]) => n + c.total, 0);
  const percent = total ? Math.round(done / total * 100) : 0, finished = list.filter(([, c]) => c.done >= c.total).length, failed = list.filter(([, c]) => c.error);
  const running = run?.status === 'running', unavailable = capability?.available === false;
  const summary = !list.length ? '' : `${running ? 'Denoising' : run?.status === 'stopped' ? 'Stopped' : 'Done'} · ${finished} of ${list.length} clips · ${percent}%${run?.timelineId !== timelineId ? ' · another timeline' : ''}`;
  return <div className="denoise-workspace special-workspace">
    <div className="denoise-viewer"><Viewer compact/></div>
    <section className="panel denoise-panel">
      <div className="panel-header"><WandSparkles size={14}/><span>Denoise all</span><span className="spacer"/><Badge>{quality}</Badge></div>
      <div className="denoise-body">
        <p className="inspector-note">One Noise Reduction for every video clip on this timeline. The server cleans each whole clip, so playback is clean everywhere, and keeps going if you close the browser.</p>
        {PARAMS.map(p => <label key={p.key} className="denoise-setting"><span>{p.label}</span>
          <input type="range" aria-label={p.label} min={p.min} max={p.max} step={p.step ?? 1} value={settings[p.key as keyof DenoiseSettings]} onChange={e => setSettings({ ...settings, [p.key]: Number(e.target.value) })}/>
          <b className="mono">{settings[p.key as keyof DenoiseSettings]}{p.suffix ?? ''}</b></label>)}
        {unavailable && <p className="depth-status failed" role="status">{capability.reason ?? 'Noise Reduction is unavailable on this server.'}</p>}
        <div className="denoise-actions">{running ? <Button onClick={() => void stop()}><Square size={12}/>Stop</Button>
          : <Button variant="primary" disabled={busy || unavailable} onClick={() => void start()}><WandSparkles size={13}/>Denoise all</Button>}</div>
        {summary && <><div className="progress-track" role="progressbar" aria-label="Denoise all progress" aria-valuenow={percent}><i style={{ width: `${percent}%` }}/></div><p className="denoise-summary" role="status">{summary}</p></>}
        {failed.map(([clipId, c]) => <p key={clipId} className="depth-status failed">{clips.find(x => x.id === clipId)?.name ?? 'A clip'}: {c.error}</p>)}
      </div>
    </section>
    <div className="denoise-timeline"><Timeline/></div>
  </div>;
}
