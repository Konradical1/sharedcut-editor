import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { Crosshair, Layers, PenTool, Plus, RotateCw, Trash2 } from 'lucide-react';
import { useEditorStore } from '../state/store';
import type { Clip, Effect } from '../state/models';
import type { DepthKeyBinding } from '../services/smartMask';
import { Parameter } from '../workspaces/ColorTools';
import { api } from '../services/api';
import { effectDefinitions } from '../services/effects';
import { depthPresets, type DepthCapabilities } from '../services/depth';
import { depthAtCanvas, depthAtSource, depthClipReady, depthFocusTrack, depthState, depthUi, depthVersion, retryDepth, subscribeDepth } from '../services/depthPreview';
import { smartMaskSignature } from '../services/smartMask';
import { openMaskEditor } from '../services/smartMaskClient';
import { Property, Section } from './Inspector';
import './depth.css';

const definition = Object.fromEntries(effectDefinitions.Depth.parameters.map(p => [p.key, p]));
const sections: { title: string; keys: string[] }[] = [
  { title: 'Lens blur', keys: ['blur', 'focus', 'range', 'nearBlur', 'bokeh'] },
  { title: 'Fog', keys: ['fog', 'fogStart', 'fogDensity', 'fogHue', 'fogSaturation', 'fogBrightness', 'fogHorizon'] },
  { title: 'Glow', keys: ['glow', 'glowThreshold', 'glowRadius', 'glowStart'] },
  { title: 'Background light', keys: ['light', 'lightStart', 'lightSoftness', 'bgExposure', 'bgSaturation', 'bgWarmth', 'bgContrast'] },
];
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export const useDepthVersion = () => useSyncExternalStore(subscribeDepth, depthVersion, () => 0);

/** The Depth effect's panel: analysis status, the depth-map view, presets, and the four sections in render order. */
export default function DepthInspector({ clip, effect }: { clip: Clip; effect: Effect }) {
  useDepthVersion();
  const s = useEditorStore.getState, asset = useEditorStore(state => state.media.find(m => m.id === clip.mediaId));
  const [capability, setCapability] = useState<DepthCapabilities>();
  // A failed check (a dropped connection) says nothing about the server: the run's own status shows what happens.
  useEffect(() => { let active = true; void api<DepthCapabilities>('/depth/capabilities').then(value => { if (active) setCapability(value); }).catch(() => {}); return () => { active = false; }; }, []);
  const state = depthState(clip.id), focusPath = `effects.${effect.id}.parameters.focus`, ready = state?.run && depthClipReady(clip, state.run);
  // Focus nobody chose yet follows the frame centre when a preset turns Lens blur on (the store does it for the slider).
  const centreFocus = () => effect.parameters?.focus === undefined && !clip.keyframes?.[focusPath] ? depthAtSource(clip.id, .5, .5) : undefined;
  const touched = () => depthUi.setShowMap(effect.id, false);
  const applyPreset = (values: Record<string, number>) => {
    // A look leaves the clip's own Focus and subject choice alone.
    const next: Record<string, number> = Object.fromEntries(effectDefinitions.Depth.parameters.filter(p => !['amount', 'focus', 'followSubject'].includes(p.key)).map(p => [p.key, p.initial]));
    Object.assign(next, values);
    const focus = next.blur > 0 ? centreFocus() : undefined;
    if (focus !== undefined) next.focus = Math.round(focus);
    touched();
    s().updateEffect(clip.id, effect.id, { amount: 100, parameters: next });
  };
  const picking = depthUi.picking?.effectId === effect.id;
  const status = capability?.available === false ? capability.reason ?? 'Depth analysis is unavailable on this server.'
    : !state ? 'Starting depth analysis…'
    : state.status === 'failed' || state.status === 'cancelled' ? state.error ?? 'Depth analysis failed.'
    : state.status === 'ready' ? 'Depth ready'
    : state.error ? state.error
    : `Analyzing depth · ${Math.round(state.progress)} %${ready ? ` · ready to ${clock(ready)}` : ''}`;
  const failed = state?.status === 'failed' || state?.status === 'cancelled';
  // Subject (Smart Mask tie-in): Lens blur keeps it sharp and out of the background, and can keep Focus on it.
  const masks = clip.smartMasks ?? [], subject = masks.find(m => m.id === effect.maskId), following = Number(effect.parameters?.followSubject ?? 0) >= .5;
  const current = !!subject?.result && subject.result.signature === smartMaskSignature(subject);
  const follow = subject && current && following ? depthFocusTrack(clip, subject.result!.key) : undefined;
  const subjectNote = !subject ? (asset?.kind === 'video' ? 'New subject draws a mask that Lens blur keeps sharp. It does not cut the clip out.' : undefined)
    : !subject.result ? 'Select the subject, then Analyze: until then its edges are not protected.'
    : !current ? 'The subject mask changed since its analysis. Analyze it again.'
    : !following ? 'Lens blur keeps the subject sharp and off the background.'
    : follow?.state === 'failed' ? follow.error
    : follow?.state === 'ready' ? (follow.track.values.length ? 'Focus follows the subject; Focus keyframes are ignored.' : 'The subject is not found in its mask, so Focus applies.')
    : 'Measuring the subject once depth analysis is ready…';
  return <div className="depth-inspector">
    <p className={`depth-status ${state?.status ?? ''}`} role="status">{status}{failed && asset && <button className="depth-retry" onClick={() => retryDepth(clip, asset)}><RotateCw size={11}/>Retry</button>}</p>
    <label className="inspector-checks"><input type="checkbox" aria-label="Show depth map" checked={depthUi.showMap(effect)} onChange={e => depthUi.setShowMap(effect.id, e.target.checked)}/>Show depth map <span className="depth-hint">near is white · viewer only</span></label>
    <div className="depth-presets" role="group" aria-label="Depth presets">{depthPresets.map(preset => <button key={preset.name} title={preset.description} onClick={() => applyPreset(preset.values)}>{preset.name}</button>)}</div>
    <Property effectId={effect.id} name="amount" label="Mix" initial={100} min={0} max={100} suffix="%"/>
    <div className="depth-subject">
      <label className="inspector-select-row"><span>Subject</span><select aria-label="Depth subject" value={subject?.id ?? ''} disabled={!masks.length} onChange={e => s().attachSmartMask(clip.id, e.target.value, effect.id)}><option value="">None</option>{masks.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      {asset?.kind === 'video' && <div className="depth-subject-actions">
        <button className="depth-pick" onClick={() => { const id = s().addSmartMask(clip.id, effect.id); if (id) openMaskEditor(clip.id, id); }}><Plus size={12}/>New subject</button>
        {subject && <button className="depth-pick" onClick={() => openMaskEditor(clip.id, subject.id)}><PenTool size={12}/>Refine subject</button>}
      </div>}
      {subject && <label className="inspector-checks"><input type="checkbox" aria-label="Follow subject" checked={following} onChange={e => s().updateEffect(clip.id, effect.id, { parameters: { followSubject: e.target.checked ? 1 : 0 } })}/>Follow subject <span className="depth-hint">focus stays on it</span></label>}
      {subjectNote && <p className="depth-hint depth-subject-note">{subjectNote}</p>}
    </div>
    <div onPointerDownCapture={touched} onKeyDownCapture={touched}>
      {sections.map(section => <Section key={section.title} title={section.title} open={section.title === 'Lens blur' || Number(effect.parameters?.[section.keys[0]] ?? 0) > 0}>
        {section.keys.map(key => { const p = definition[key]; return <div key={key}>
          <Property effectId={effect.id} name={key} label={p.label} initial={p.initial} min={p.min} max={p.max} step={p.step} suffix={p.suffix}/>
          {key === 'focus' && <button className={`depth-pick ${picking ? 'active' : ''}`} aria-pressed={picking} onClick={() => depthUi.setPicking(picking ? null : { clipId: clip.id, effectId: effect.id })}><Crosshair size={12}/>{picking ? 'Click the picture to focus · Esc cancels' : 'Pick focus in the viewer'}</button>}
        </div>; })}
      </Section>)}
    </div>
  </div>;
}

/** Over the viewer while the focus picker is armed: one click sets Focus from the depth under the cursor. */
export function DepthFocusPicker({ canvas }: { canvas: RefObject<HTMLCanvasElement | null> }) {
  useDepthVersion();
  const picking = depthUi.picking;
  useEffect(() => { if (!picking) return; const key = (e: KeyboardEvent) => { if (e.key === 'Escape') depthUi.setPicking(null); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [picking]);
  if (!picking) return null;
  return <div className="depth-picker" role="button" aria-label="Set focus here" title="Click the picture to set Focus" onClick={e => {
    const view = canvas.current, rect = view?.getBoundingClientRect();
    if (!view || !rect?.width) return;
    const focus = depthAtCanvas(picking.clipId, (e.clientX - rect.left) * view.width / rect.width, (e.clientY - rect.top) * view.height / rect.height);
    if (focus === undefined) { useEditorStore.getState().notify('No depth under that point yet. Try again once this frame is analyzed.', 'info'); return; }
    useEditorStore.getState().updateEffect(picking.clipId, picking.effectId, { parameters: { focus: Math.round(focus) } });
    depthUi.setPicking(null);
  }}/>;
}

/** A grade node's depth key (Color page): analysis status, the key view, and Near / Far / Softness on the clip's
 *  0 (nearest) to 100 (farthest) distance scale. `change` is the workspace's node patch, so a drag is one undo step. */
export function DepthKeyInspector({ clip, nodeId, mask, change }: { clip: Clip; nodeId: string; mask: DepthKeyBinding; change: (mask: DepthKeyBinding | undefined) => void }) {
  useDepthVersion();
  const asset = useEditorStore(state => state.media.find(m => m.id === clip.mediaId)), state = depthState(clip.id);
  const patch = (value: Partial<DepthKeyBinding>) => change({ ...mask, ...value });
  const failed = state?.status === 'failed' || state?.status === 'cancelled';
  const status = !state ? 'Starting depth analysis…' : failed ? state.error ?? 'Depth analysis failed.' : state.status === 'ready' ? 'Depth ready' : state.error ?? `Analyzing depth · ${Math.round(state.progress)} %`;
  return <div className="depth-inspector depth-key-inspector" aria-label="Depth key settings">
    <div className="smart-mask-heading"><Layers size={16}/><strong>Depth Key</strong><button aria-label="Remove depth key" title="Remove the depth key from this node" onClick={() => change(undefined)}><Trash2 size={12}/></button></div>
    <p className={`depth-status ${state?.status ?? ''}`} role="status">{status}{failed && asset && <button className="depth-retry" onClick={() => retryDepth(clip, asset)}><RotateCw size={11}/>Retry</button>}</p>
    <div className="smart-mask-inline"><label><input type="checkbox" checked={mask.enabled} onChange={e => patch({ enabled: e.target.checked })}/>Enable</label><label><input type="checkbox" checked={mask.invert} onChange={e => patch({ invert: e.target.checked })}/>Invert</label><label title="Draw the key in the viewer: white is graded. Viewer only."><input type="checkbox" aria-label="Show key" checked={depthUi.showKey(nodeId)} onChange={e => depthUi.setShowKey(nodeId, e.target.checked)}/>Show key</label></div>
    <Parameter name="Near" value={mask.near} min={0} max={100} step={1} onChange={near => patch({ near, far: Math.max(mask.far, near) })}/>
    <Parameter name="Far" value={mask.far} min={0} max={100} step={1} onChange={far => patch({ far, near: Math.min(mask.near, far) })}/>
    <Parameter name="Softness" value={mask.softness} min={0} max={100} step={1} onChange={softness => patch({ softness })}/>
    <Parameter name="Node influence %" value={mask.amount} min={0} max={100} step={1} onChange={amount => patch({ amount })}/>
    <small className="depth-hint">Distance 0 is the nearest point of the shot, 100 the farthest.</small>
  </div>;
}
