import { Fragment, useEffect, useRef, type PointerEvent } from 'react';
import { Pipette, RotateCcw } from 'lucide-react';
import type { Clip, GradeNode } from '../state/models';
import { GRADE_PARAMS, PARAM, on } from '../services/grading';
import { bandKey, hueColor, hueKey, tidyParams } from '../services/colorKeys';
import { setColorView } from '../services/colorPreview';
import { createId } from '../services';
import { useEditorStore } from '../state/store';
import { IconButton, NumberInput } from '../components/ui';
import { useColorUi } from './colorUi';
import './colorKeys.css';

type Params = Record<string, number>;
export type KeyPanelProps = { node: GradeNode; clip: Clip; update: (p: Params) => void };
const val = (p: Params, key: string) => p[key] ?? PARAM[key].initial;
const mod = (v: number, m = 360) => (v % m + m) % m, apart = (a: number, b: number) => Math.min(mod(a - b), 360 - mod(a - b));
const HUE_TRACK = `linear-gradient(90deg,${Array.from({ length: 37 }, (_, i) => `rgb(${hueColor(i * 10).join(' ')}) ${(i / 36 * 100).toFixed(2)}%`).join(',')})`;

export function Toggle({ label, value, change, title }: { label: string; value: boolean; change: (on: boolean) => void; title?: string }) {
  return <button type="button" className="ck-toggle" aria-pressed={value} title={title} onClick={() => change(!value)}>{label}</button>;
}
/** The viewer's picture of this node's key: the grade, the keyed area over grey, or the black/white matte. Back to Off when
 *  the panel closes or another node is chosen. */
export function KeyView({ nodeId }: { nodeId: string }) {
  const matte = useColorUi(s => s.matte);
  // getState: after a node change the reset below has already run, so the new node never flashes the old view.
  useEffect(() => { setColorView({ nodeId, mode: useColorUi.getState().matte }); }, [nodeId, matte]);
  useEffect(() => () => { useColorUi.setState({ matte: 'off' }); setColorView({ nodeId: null, mode: 'off' }); }, [nodeId]);
  return <div className="ck-view" role="group" aria-label="Key view">{([['off', 'Off', 'Show the grade'], ['highlight', 'Highlight', 'Show the keyed area over grey'], ['matte', 'Matte', 'Show the key in black and white']] as const).map(([mode, label, title]) =>
    <button key={mode} type="button" aria-pressed={matte === mode} title={title} onClick={() => useColorUi.setState({ matte: mode })}>{label}</button>)}</div>;
}
/** A registry parameter as label, slider and number; `bare` leaves the label to a paired row. */
export function Slider({ k, p, set, prefix = '', bare = false }: { k: string; p: Params; set: (patch: Params) => void; prefix?: string; bare?: boolean }) {
  const d = PARAM[k], value = val(p, k), name = `${prefix}${d.label}`;
  return <label className={`ck-slider${bare ? ' bare' : ''}`} title={d.doc}>{!bare && <span>{d.label}</span>}<input type="range" aria-label={name} min={d.min} max={d.max} step={d.step} value={value} onChange={e => set({ [k]: Number(e.target.value) })}/>
    <NumberInput aria-label={`${name} value`} min={d.min} max={d.max} step={d.step} decimals={d.step < .01 ? 3 : 1} value={value} onCommit={v => set({ [k]: v })}/></label>;
}

type Part = 'body' | 'low' | 'high' | 'softLow' | 'softHigh' | 'track';
/** A key range on a 0–`max` bar: the core [lo, hi] (drag to move it, its edges to resize), feather triangles below, and the
 *  key itself as the dimming. `patch` turns a drag (start values, change and press position in bar units) into parameters. */
function KeyBar({ name, p, max, lo, hi, soft, wrap = false, edges = true, feather, track, keyAt, patch, commit }: {
  name: string; p: Params; max: number; lo: number; hi: number; soft: number; wrap?: boolean; edges?: boolean; feather: [boolean, boolean]; track: string;
  keyAt: (x: number) => number; patch: (part: Part, p0: Params, delta: number, at: number) => Params; commit: (patch: Params, gesture: string) => void;
}) {
  const bar = useRef<HTMLDivElement>(null), drag = useRef<{ part: Part; x: number; at: number; p0: Params; gesture: string } | null>(null);
  const units = (clientX: number) => { const r = bar.current!.getBoundingClientRect(); return (clientX - r.left) / r.width * max; };
  const start = (part: Part) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
    bar.current!.setPointerCapture(e.pointerId);
    const d = drag.current = { part, x: e.clientX, at: units(e.clientX), p0: p, gesture: createId('grade') };
    if (part === 'track') commit(patch(part, p, 0, d.at), d.gesture);
  };
  const move = (e: PointerEvent) => { const d = drag.current; if (!d) return; const r = bar.current!.getBoundingClientRect(); commit(patch(d.part, d.p0, (e.clientX - d.x) / r.width * max, d.at), d.gesture); };
  const end = () => { drag.current = null; };
  const pct = (x: number) => `${(x / max * 100).toFixed(3)}%`;
  const dim = `linear-gradient(90deg,${Array.from({ length: 91 }, (_, i) => `rgb(15 16 19 / ${(.7 * (1 - keyAt(i / 90 * max))).toFixed(3)}) ${(i / 90 * 100).toFixed(2)}%`).join(',')})`;
  return <div ref={bar} className="ck-bar" role="group" aria-label={`${name} range`} onPointerDown={start('track')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    <div className="ck-track" style={{ background: track }}><i style={{ background: dim }}/></div>
    {(wrap ? [-max, 0, max] : [0]).map(o => <Fragment key={o}>
      {edges && <><div className={`ck-core${wrap ? ' ck-centred' : ''}`} style={{ left: pct(lo + o), width: pct(hi - lo) }} aria-label={`${name} range: drag to move`} onPointerDown={start('body')}/>
        <div className="ck-edge ck-low" style={{ left: pct(lo + o) }} aria-label={`${name} low edge`} onPointerDown={start('low')}/>
        <div className="ck-edge ck-high" style={{ left: pct(hi + o) }} aria-label={`${name} high edge`} onPointerDown={start('high')}/></>}
      {feather[0] && <div className="ck-feather" style={{ left: pct(lo - soft + o) }} aria-label={`${name} low feather`} onPointerDown={start('softLow')}/>}
      {feather[1] && <div className="ck-feather" style={{ left: pct(hi + soft + o) }} aria-label={`${name} high feather`} onPointerDown={start('softHigh')}/>}
    </Fragment>)}
  </div>;
}
const Field = ({ k, p, set }: { k: string; p: Params; set: (patch: Params) => void }) => {
  const d = PARAM[k];
  return <label className="ck-field" title={d.doc}><span>{d.label.replace(/^\S+ /, '')}</span><NumberInput aria-label={d.label} min={d.min} max={d.max} step={d.step} decimals={1} value={val(p, k)} onCommit={v => set({ [k]: v })}/></label>;
};
// Hue: a press on the bar picks that hue (when every hue is keyed) or moves the nearer edge there; edges change the width both ways.
const huePatch = (part: Part, p0: Params, delta: number, at: number): Params => {
  const c = val(p0, 'qualHue'), w = val(p0, 'qualHueWidth'), soft = val(p0, 'qualHueSoft'), x = at + delta;
  if (part === 'track') return w >= 360 ? { qualHue: mod(x), qualHueWidth: 30 } : { qualHueWidth: 2 * apart(x, c) };
  // Edges follow the pointer's distance from the centre, so a zero-width range opens whichever way it is pulled.
  return part === 'body' ? { qualHue: mod(c + delta) } : part === 'low' || part === 'high' ? { qualHueWidth: w + 2 * (apart(x, c) - apart(at, c)) } : { qualHueSoft: soft + (part === 'softLow' ? -delta : delta) };
};
const bandPatch = (band: 'Sat' | 'Lum') => (part: Part, p0: Params, delta: number, at: number): Params => {
  const L = `qual${band}Low`, H = `qual${band}High`, S = `qual${band}Soft`, low = val(p0, L), high = val(p0, H);
  const edge = part === 'track' ? (Math.abs(at - low) <= Math.abs(at - high) ? 'low' : 'high') : part;
  if (edge === 'body') { const d = Math.max(-low, Math.min(100 - high, delta)); return { [L]: low + d, [H]: high + d }; }
  if (edge === 'low') return { [L]: Math.min(high, (part === 'track' ? at : low) + delta) };
  if (edge === 'high') return { [H]: Math.max(low, (part === 'track' ? at : high) + delta) };
  return { [S]: val(p0, S) + (part === 'softLow' ? -delta : delta) };
};

/** HSL qualifier of the selected node (docs/color-grading-v3.md, Qualifier): hue, saturation and luminance ranges, the
 *  eyedropper on the viewer (ColorWindowOverlay does the picking) and the key view. Editing a range turns the key on. */
export function QualifierPanel({ node, update }: KeyPanelProps) {
  const p = node.parameters, active = on(p.qualOn), picking = useColorUi(s => s.picking);
  const withOn = (patch: Params) => ({ ...patch, ...(active || 'qualOn' in patch ? {} : { qualOn: 1 }) });
  const set = (patch: Params) => update(withOn(patch));
  const commit = (patch: Params, gesture: string) => useEditorStore.getState().updateNode(node.id, { parameters: tidyParams(withOn(patch)) }, gesture);
  // The picker belongs to this panel's node: leaving the panel or the node puts it down.
  useEffect(() => () => useColorUi.setState({ picking: false }), [node.id]);
  const c = val(p, 'qualHue'), w = val(p, 'qualHueWidth'), any = w >= 360;
  const bands = (['Sat', 'Lum'] as const).map(band => {
    const low = val(p, `qual${band}Low`), high = val(p, `qual${band}High`), soft = val(p, `qual${band}Soft`);
    return <div key={band} className="ck-row"><span className="ck-name">{band === 'Sat' ? 'Sat' : 'Lum'}</span>
      <KeyBar name={band === 'Sat' ? 'Saturation' : 'Luminance'} p={p} max={100} lo={low} hi={high} soft={soft} feather={[low > 0 && soft > 0, high < 100 && soft > 0]}
        track={band === 'Sat' ? `linear-gradient(90deg,rgb(128 128 128),rgb(${hueColor(any ? 0 : c).join(' ')}))` : 'linear-gradient(90deg,#000,#fff)'}
        keyAt={x => bandKey(x, low, high, soft)} patch={bandPatch(band)} commit={commit}/>
      <div className="ck-fields">{['Low', 'High', 'Soft'].map(f => <Field key={f} k={`qual${band}${f}`} p={p} set={set}/>)}</div></div>;
  });
  return <div className={`ck-panel ck-qualifier${active ? '' : ' ck-off'}`}>
    <div className="ck-head">
      <Toggle label="On" value={active} change={v => update({ qualOn: v ? 1 : 0 })} title="Limit this node to the colours the key selects"/>
      <Toggle label="Invert" value={on(p.qualInvert)} change={v => set({ qualInvert: v ? 1 : 0 })} title="Grade everything except the selected colours"/>
      <button type="button" className="ck-pick" aria-pressed={picking} title="Pick a colour on the viewer · Shift-click adds to the key" onClick={() => useColorUi.setState({ picking: !picking })}><Pipette size={13}/>{picking ? 'Picking' : 'Pick'}</button>
      <small className="ck-hint">{picking ? 'Click the viewer · Shift-click adds · Esc cancels' : any ? 'Pick a colour, or click a hue below' : ''}</small>
      <span className="spacer"/>
      <KeyView nodeId={node.id}/>
      <IconButton label="Reset qualifier" onClick={() => update(Object.fromEntries(GRADE_PARAMS.filter(d => d.group === 'qualifier' && d.key !== 'qualOn').map(d => [d.key, d.initial])))}><RotateCcw size={13}/></IconButton>
    </div>
    <div className="ck-row ck-hue-row"><span className="ck-name">Hue</span>
      <KeyBar name="Hue" p={p} max={360} lo={c - w / 2} hi={c + w / 2} soft={val(p, 'qualHueSoft')} wrap edges={!any} feather={[!any, !any]} track={HUE_TRACK} keyAt={x => hueKey(x, p)} patch={huePatch} commit={commit}/>
      <div className="ck-fields">{['Hue', 'HueWidth', 'HueSoft'].map(f => <Field key={f} k={`qual${f}`} p={p} set={set}/>)}</div></div>
    {bands}
  </div>;
}
