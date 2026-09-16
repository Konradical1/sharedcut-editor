import { useRef, useState, type PointerEvent } from 'react';
import { AudioLines, ArrowRightLeft, Save, Trash2 } from 'lucide-react';
import { useEditorStore } from '../state/store';
import { useShallow } from 'zustand/react/shallow';
import { ease } from '../services/animation';
import { leakRange, maximumDuration, transitionAligns, transitionCurve, transitionDefinitions, transitionName, transitionParams, timelineTransitions, type TransitionAlign } from '../services/transitions';
import { Property, Section } from './Inspector';

const CURVE_PRESETS: Record<string, [number, number, number, number]> = {
  Linear: [1 / 3, 1 / 3, 2 / 3, 2 / 3],
  'Ease in': [.42, 0, 1, 1],
  'Ease out': [0, 0, .58, 1],
  'Ease in-out': [.42, 0, .58, 1],
  Snap: [.8, 0, .2, 1],
};
const GRAPH = 132;

/** The timing curve, drawn and edited the same way the keyframe graph handles are. */
function CurveEditor({ curve, onChange }: { curve: [number, number, number, number]; onChange: (curve: [number, number, number, number]) => void }) {
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef<0 | 1 | null>(null);
  const point = (event: PointerEvent) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect) return null;
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(-.5, Math.min(1.5, 1 - (event.clientY - rect.top) / rect.height))] as const;
  };
  const move = (event: PointerEvent) => {
    if (dragging.current === null) return;
    const at = point(event);
    if (!at) return;
    const next: [number, number, number, number] = [...curve];
    // Handle 0 owns x1/y1, handle 1 owns x2/y2; x stays inside the unit span so the ease is monotonic.
    if (dragging.current === 0) { next[0] = Math.min(at[0], curve[2]); next[1] = at[1]; }
    else { next[2] = Math.max(at[0], curve[0]); next[3] = at[1]; }
    onChange(next);
  };
  const y = (value: number) => (1 - value) * GRAPH;
  const path = `M 0 ${y(0)} C ${curve[0] * GRAPH} ${y(curve[1])}, ${curve[2] * GRAPH} ${y(curve[3])}, ${GRAPH} ${y(1)}`;
  return <svg ref={svg} className="transition-curve" viewBox={`-10 -26 ${GRAPH + 20} ${GRAPH + 52}`} role="img" aria-label="Transition timing curve"
    onPointerMove={move} onPointerUp={() => { dragging.current = null; }} onPointerLeave={() => { dragging.current = null; }}>
    <rect x="0" y="0" width={GRAPH} height={GRAPH} className="transition-curve-field" />
    {[.25, .5, .75].map(line => <line key={line} x1="0" x2={GRAPH} y1={line * GRAPH} y2={line * GRAPH} className="transition-curve-grid" />)}
    <line x1="0" y1={y(0)} x2={curve[0] * GRAPH} y2={y(curve[1])} className="transition-curve-arm" />
    <line x1={GRAPH} y1={y(1)} x2={curve[2] * GRAPH} y2={y(curve[3])} className="transition-curve-arm" />
    <path d={path} className="transition-curve-line" />
    {([[curve[0], curve[1], 0], [curve[2], curve[3], 1]] as const).map(([px, py, index]) =>
      <circle key={index} cx={px * GRAPH} cy={y(py)} r="6" className="transition-curve-handle" tabIndex={0} role="slider"
        aria-label={index === 0 ? 'Curve start handle' : 'Curve end handle'} aria-valuenow={Math.round(py * 100)}
        onPointerDown={event => { dragging.current = index; (event.target as Element).setPointerCapture?.(event.pointerId); }}
        onKeyDown={event => {
          const step = event.shiftKey ? .01 : .05;
          const axis = event.key === 'ArrowUp' ? [0, step] : event.key === 'ArrowDown' ? [0, -step] : event.key === 'ArrowRight' ? [step, 0] : event.key === 'ArrowLeft' ? [-step, 0] : null;
          if (!axis) return;
          event.preventDefault();
          const next: [number, number, number, number] = [...curve];
          if (index === 0) { next[0] = Math.max(0, Math.min(curve[2], curve[0] + axis[0])); next[1] = curve[1] + axis[1]; }
          else { next[2] = Math.max(curve[0], Math.min(1, curve[2] + axis[0])); next[3] = curve[3] + axis[1]; }
          onChange(next);
        }} />)}
  </svg>;
}

export default function TransitionInspector() {
  const { clips, media, leaks, selection } = useEditorStore(useShallow(state => ({ clips: state.clips, media: state.media, leaks: state.leaks, selection: state.selectedTransition })));
  const actions = useEditorStore.getState;
  const [savingPreset, setSavingPreset] = useState(false);
  const [gesture] = useState(() => `transition-${Math.random().toString(36).slice(2)}`);
  const clip = clips.find(item => item.id === selection?.clipId);
  const side = selection?.side ?? 'in';
  if (!clip || !selection) return null;
  const name = transitionName(clip, side);
  const definition = transitionDefinitions[name];
  if (!definition) return null;
  const params = transitionParams(clip, side);
  const curve = transitionCurve(clip, side);
  const align = clip.properties[`transition${side === 'in' ? '' : 'Out'}Align`] as TransitionAlign ?? 'center';
  const record = timelineTransitions(clips, clip.timelineId, media).find(item => item.clipId === clip.id && item.side === side);
  const room = maximumDuration(clips, clip, side, align, media, true);
  const update = (patch: Parameters<ReturnType<typeof actions>['updateTransition']>[2]) => actions().updateTransition(clip.id, side, patch, gesture);

  return <>
    <div className="inspector-transition-head">
      <span className="inspector-clip-icon"><ArrowRightLeft size={16} /></span>
      <div><b>{name}</b><span>{definition.description}</span></div>
    </div>
    <Section title="Timing" icon={<ArrowRightLeft size={12} />}>
      <Property name="__transitionDuration" label={definition.overlay ? "Duration (retime)" : "Duration"} initial={record?.duration ?? 1} min={1 / 48} max={Math.max(1 / 48, room)} step={1 / 48} suffix="s"
        control={{ value: record?.duration, change: value => update({ duration: value }), preview: value => update({ duration: value }) }} />
      {!definition.overlay && <label className="inspector-select-row"><span>Alignment</span>
        <select aria-label="Transition alignment" value={align} onChange={event => update({ align: event.target.value as TransitionAlign })}>
          {transitionAligns.map(item => <option key={item} value={item}>{item === 'center' ? 'Centred on cut' : item === 'in' ? 'Start at cut' : 'End at cut'}</option>)}
        </select>
      </label>}
      {record && record.requested - record.duration > 1e-3 && <p className="inspector-note warning">
        Shortened to {record.duration.toFixed(2)}s to fit the available footage. {definition.overlay ? 'The peak remains anchored to the cut.' : 'Changing alignment may allow a longer transition.'}
      </p>}
      {!definition.overlay && <p className="inspector-note">Room at this alignment: {room >= 30 ? '30s+' : `${room.toFixed(2)}s`}. A transition borrows unused trim handles, so nothing on the timeline moves.</p>}
      {definition.overlay && <p className="inspector-note">The peak stays on the clip cut. Peak position shifts the overlay window; the clips keep their timing. Drag the box edges or edit Source start/end to trim without changing speed. Duration (retime) changes playback speed.</p>}
    </Section>
    {!definition.overlay && <Section title="Timing curve" icon={<ArrowRightLeft size={12} />}>
      <CurveEditor curve={curve} onChange={next => update({ curve: next })} />
      <label className="inspector-select-row"><span>Preset</span>
        <select aria-label="Timing curve preset" value={Object.keys(CURVE_PRESETS).find(key => CURVE_PRESETS[key].every((n, i) => Math.abs(n - curve[i]) < 1e-6)) ?? 'Custom'}
          onChange={event => { const preset = CURVE_PRESETS[event.target.value]; if (preset) update({ curve: preset }); }}>
          {[...Object.keys(CURVE_PRESETS), 'Custom'].map(item => <option key={item}>{item}</option>)}
        </select>
      </label>
      <p className="inspector-note">Midpoint lands at {(ease(.5, curve) * 100).toFixed(0)}% through the blend.</p>
    </Section>}
    {!!definition.parameters.length && <Section title={name} icon={<ArrowRightLeft size={12} />}>
      {definition.parameters.map(parameter => {
        if (parameter.key === 'leakIn' || parameter.key === 'leakOut') {
          const leak = leaks.find(item => item.id === params.leak);
          if (!leak) return null;
          const range = leakRange(params, leak.duration), start = parameter.key === 'leakIn';
          const step = 1 / (leak.fps || 24);
          return <Property key={parameter.key} name={`__transition_${parameter.key}`} label={parameter.label}
            min={start ? 0 : Math.min(leak.duration, range.start + step)} max={start ? Math.max(0, range.end - step) : leak.duration} step={step} suffix="s"
            control={{ value: start ? range.start : range.end, change: value => update({ params: { [parameter.key]: value } }), preview: value => update({ params: { [parameter.key]: value } }) }} />;
        }
        if (parameter.key === 'leak') return <label key="leak" className="inspector-select-row"><span>Leak</span>
          <select aria-label="Light leak" value={String(params.leak ?? '')} onChange={event => update({ params: { leak: event.target.value } })}>
            <option value="">Choose a leak…</option>
            {leaks.map(leak => <option key={leak.id} value={leak.id}>{leak.name}</option>)}
          </select></label>;
        if (parameter.choices) return <label key={parameter.key} className="inspector-select-row"><span>{parameter.label}</span>
          <select aria-label={parameter.label} value={String(params[parameter.key] ?? parameter.initial)} onChange={event => update({ params: { [parameter.key]: event.target.value } })}>
            {parameter.choices.map(choice => <option key={choice}>{choice}</option>)}
          </select></label>;
        if (typeof parameter.initial === 'string') return <label key={parameter.key} className="inspector-color-row"><span>{parameter.label}</span>
          <input type="color" aria-label={parameter.label} value={String(params[parameter.key] ?? parameter.initial)} onChange={event => update({ params: { [parameter.key]: event.target.value } })} /></label>;
        return <Property key={parameter.key} name={`__transition_${parameter.key}`} label={parameter.label}
          initial={Number(parameter.initial)} min={parameter.min} max={parameter.max} step={parameter.step} suffix={parameter.suffix}
          control={{ value: Number(params[parameter.key] ?? parameter.initial), change: value => update({ params: { [parameter.key]: value } }), preview: value => update({ params: { [parameter.key]: value } }) }} />;
      })}
      {definition.motion && <p className="inspector-note">Shutter angle drives the baked motion blur. The preview approximates it with a few sub-frames; the export averages the full set, so the rendered blur is the accurate one.</p>}
    </Section>}
    {definition.overlay && <Section title="Overlay sound" icon={<AudioLines size={12} />}>
      <button className="button button-secondary" disabled={!!record?.audioClipId} onClick={() => actions().expandTransitionAudio(clip.id, side)}>
        <AudioLines size={14} />{record?.audioClipId ? 'Sound is on a track' : 'Expand audio to track'}
      </button>
      <p className="inspector-note">{record?.audioClipId
        ? 'The leak’s sound is now an ordinary audio clip you can trim, fade and mix. The embedded copy is muted so it cannot play twice.'
        : 'The leak’s sound plays with the transition. Expand it to edit it as a clip on the nearest free audio track.'}</p>
    </Section>}
    <Section title="Shared preset" icon={<Save size={12} />}>
      <button className="button button-secondary" disabled={savingPreset} onClick={async () => { setSavingPreset(true); try { await actions().saveTransitionPreset(clip.id, side); } finally { setSavingPreset(false); } }}><Save size={14} />{savingPreset ? 'Saving…' : 'Save to transition preset'}</button>
      <p className="inspector-note">Updates {definition.overlay ? leaks.find(leak => leak.id === params.leak)?.name ?? name : name} for everyone’s future uses. Existing timeline transitions stay unchanged.</p>
    </Section>
    <div className="inspector-transition-actions">
      <button className="button button-secondary danger-text" onClick={() => actions().removeTransition(clip.id, side)}><Trash2 size={14} />Remove transition</button>
    </div>
  </>;
}
