import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { RotateCw } from 'lucide-react';
import type { Clip, Effect } from '../state/models';
import { effectDefinitions } from '../services/effects';
import { denoiseEffect } from '../services/denoise';
import { denoiseCapabilities, denoiseStatus, denoiseStatusText, noiseUi, retryDenoise, subscribeDenoise } from '../services/denoisePreview';
import { Property } from './Inspector';
import './depth.css';

const subscribeNoiseUi = (listener: () => void) => noiseUi.subscribe(listener), noiseUiVersion = () => noiseUi.version();

/** Noise Reduction's panel, shared by the Inspector's Effects tab and the Color page: the status of the chunk under the
 *  playhead, the viewer-only removed-noise view, and the five settings. Settings are read once for the whole clip, so they
 *  do not animate. */
export default function NoiseReductionInspector({ clip, effect }: { clip: Clip; effect: Effect }) {
  useSyncExternalStore(subscribeNoiseUi, noiseUiVersion, () => 0);
  const [, changed] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeDenoise(changed), []);
  const [capability, setCapability] = useState<{ available: boolean; reason?: string }>();
  const [asked, ask] = useReducer((n: number) => n + 1, 0);
  useEffect(() => { let active = true; void denoiseCapabilities().then(value => { if (active) setCapability(value); }); return () => { active = false; }; }, [asked]);
  const status = denoiseStatus(clip.id), active = denoiseEffect(clip)?.id === effect.id;
  const unavailable = capability?.available === false, failed = unavailable || active && (status?.status === 'unavailable' || status?.status === 'failed');
  const text = unavailable ? capability.reason ?? 'Noise Reduction is unavailable on this server.' : active ? denoiseStatusText(status) : '';
  return <div className="depth-inspector">
    {text ? <p className={`depth-status ${failed ? 'failed' : status?.status ?? ''}`} role="status">{text}{failed && <button className="depth-retry" onClick={() => { retryDenoise(clip.id); ask(); }}><RotateCw size={11}/>Retry</button>}</p>
      : <p className="inspector-note" role="status">{active ? 'Denoises around the playhead as you watch; export cleans the whole clip.' : 'Bypassed: the picture is unchanged.'}</p>}
    {active && status?.status === 'preparing' && <div className="progress-track" role="progressbar" aria-label="Noise Reduction progress" aria-valuenow={status.progress}><i style={{ width: `${status.progress}%` }}/></div>}
    <label className="inspector-checks"><input type="checkbox" aria-label="Show removed noise" checked={noiseUi.showRemoved(effect.id)} onChange={e => noiseUi.setShowRemoved(effect.id, e.target.checked)}/>Show removed noise <span className="depth-hint">viewer only</span></label>
    {effectDefinitions['Noise Reduction'].parameters.map(p => <Property key={p.key} clipId={clip.id} effectId={effect.id} name={p.key} label={p.label} initial={p.initial} min={p.min} max={p.max} step={p.step} suffix={p.suffix} animatable={false}/>)}
  </div>;
}
