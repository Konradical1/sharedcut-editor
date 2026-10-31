// The Color page's Camera Raw tool for Blackmagic RAW clips, laid out like DaVinci Resolve's Camera Raw palette. Settings belong
// to the media (every clip of it), as in Resolve; the server develops them through Blackmagic's RAW SDK (src/services/braw.ts).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { RotateCcw } from 'lucide-react';
import { useEditorStore } from '../state/store';
import type { MediaAsset, RawValue } from '../state/models';
import { curveEditable, effectiveRaw, rawChange, rawPending, rawSignature, toneCurve, type RawKey } from '../services/braw';
import { Button, IconButton, NumberInput } from '../components/ui';

const decimals = (step: number) => Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
/** A Camera Raw slider in the grade sliders' style; the fill runs from the camera's value. Double-click goes back to the camera's. */
function RawSlider({ name, value, camera, min, max, step, disabled, onChange }: { name: string; value: number; camera: number; min: number; max: number; step: number; disabled?: boolean; onChange: (v: number | undefined) => void }) {
  const at = (x: number) => `${(Math.max(min, Math.min(max, x)) - min) / (max - min) * 100}%`;
  return <div className={`grade-slider${Math.abs(value - camera) > 1e-9 ? ' changed' : ''}${disabled ? ' disabled' : ''}`} title={`${name}. Double-click for the camera's value (${camera}).`}
    style={{ '--from': at(Math.min(value, camera)), '--to': at(Math.max(value, camera)) } as CSSProperties}
    onDoubleClick={e => { if (!disabled && !(e.target as Element).matches('input[inputmode=decimal]')) onChange(undefined); }}>
    <span>{name}</span>
    <NumberInput aria-label={`${name} value`} disabled={disabled} min={min} max={max} step={step} decimals={decimals(step)} value={value} onCommit={onChange} />
    <input aria-label={name} type="range" disabled={disabled} min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
  </div>;
}
function RawSelect({ name, value, options, label = String, onChange }: { name: string; value: RawValue; options: RawValue[]; label?: (v: RawValue) => string; onChange: (v: RawValue) => void }) {
  return <label className="raw-select"><span>{name}</span><select aria-label={name} value={String(value)} onChange={e => onChange(options.find(o => String(o) === e.target.value) ?? e.target.value)}>
    {options.map(o => <option key={String(o)} value={String(o)}>{label(o)}</option>)}</select></label>;
}
function RawSwitch({ name, value, disabled, onChange }: { name: string; value: RawValue | undefined; disabled?: boolean; onChange: (v: number) => void }) {
  return <label className="grade-toggle"><input type="checkbox" role="switch" aria-label={name} disabled={disabled} checked={Number(value) === 1} onChange={e => onChange(e.target.checked ? 1 : 0)} /><i aria-hidden="true" /><span>{name}</span></label>;
}

const CURVE: [RawKey, string, number][] = [['tone_curve_saturation', 'Saturation', .01], ['tone_curve_contrast', 'Contrast', .01], ['tone_curve_midpoint', 'Midpoint', .001],
  ['tone_curve_highlights', 'Highlight Rolloff', .01], ['tone_curve_shadows', 'Shadow Rolloff', .01], ['tone_curve_white_level', 'White Level', .01], ['tone_curve_black_level', 'Black Level', .01]];

export function CameraRawPanel({ asset }: { asset: MediaAsset }) {
  const braw = asset.braw!, setCameraRaw = useEditorStore(s => s.setCameraRaw);
  // Dragging changes a draft; it is saved (and the clip develops) once the controls rest for a moment.
  const [draft, setDraft] = useState<Record<string, RawValue> | null>(null), timer = useRef<ReturnType<typeof setTimeout>>(undefined), pending = useRef<Record<string, RawValue> | null>(null);
  const save = () => { clearTimeout(timer.current); if (pending.current) { setCameraRaw(asset.id, pending.current); pending.current = null; } };
  useEffect(() => () => save(), [asset.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The saved settings caught up with the draft: show them.
  useEffect(() => { if (draft && !pending.current && rawSignature(draft) === rawSignature(braw.settings)) setDraft(null); }, [braw.settings, draft]);
  const settings = draft ?? braw.settings, state = { info: braw.info, settings }, value = effectiveRaw(state), camera = braw.info.asShot;
  const change = (next: Record<string, RawValue>) => { setDraft(next); pending.current = next; clearTimeout(timer.current); timer.current = setTimeout(save, 350); };
  const set = (key: RawKey, v: RawValue | undefined) => {
    if (v !== undefined) return change(rawChange(state, key, v));
    const next = { ...settings }; delete next[key]; change(next);
  };
  const curve = toneCurve(state), editable = curveEditable(value), range = (key: string, fallback: [number, number]) => braw.info.ranges[key] ?? fallback;
  const cameraDefaults = !Object.keys(settings).length, developing = rawPending({ ...braw, settings }) && !braw.error;
  const lut = braw.info.options.post_3dlut_mode ?? [];
  return <div className="camera-raw-tool">
    <div className="camera-raw-bar">
      <div className="segmented" role="group" aria-label="Decode using"><span>Decode using</span>
        <button aria-pressed={cameraDefaults} onClick={() => change({})} title="Develop with the settings the camera recorded">Camera metadata</button>
        <button aria-pressed={!cameraDefaults} disabled={cameraDefaults} title="This clip's own settings: change any control below">Clip</button></div>
      <span className="camera-raw-camera" title={`${braw.info.camera}${braw.info.lens ? ` · ${braw.info.lens}` : ''}`}>{braw.info.camera} · {braw.info.width} × {braw.info.height} · ISO {String(camera.iso)} · {String(camera.white_balance_kelvin)}K</span>
      <span className="spacer" />
      <span className={`camera-raw-state${braw.error ? ' failed' : developing ? ' busy' : ''}`} role="status">{braw.error ? `Develop failed: ${braw.error}` : developing ? `Developing${braw.developing ? ` · ${braw.developing}%` : '…'} · the paused viewer shows the new look` : 'Developed'}</span>
      {braw.error && <Button onClick={() => setCameraRaw(asset.id, { ...braw.settings })}>Retry</Button>}
      <IconButton label="Reset Camera Raw to camera metadata" disabled={cameraDefaults} onClick={() => change({})}><RotateCcw size={13} /></IconButton>
    </div>
    <div className="camera-raw-grid">
      <section className="raw-section"><h4>Decode</h4>
        <RawSelect name="Color Science" value={value.viewing_bmdgen} options={braw.info.options.viewing_bmdgen ?? []} label={v => `Gen ${v}`} onChange={v => set('viewing_bmdgen', v)} />
        <RawSelect name="Gamut" value={value.viewing_gamut} options={braw.info.options.viewing_gamut ?? []} label={v => v === 'Blackmagic Design' ? 'Blackmagic Design (Wide Gamut)' : String(v)} onChange={v => set('viewing_gamut', v)} />
        <RawSelect name="Gamma" value={value.viewing_gamma} options={braw.info.options.viewing_gamma ?? []} onChange={v => set('viewing_gamma', v)} />
        {lut.length > 1 && <RawSelect name="3D LUT" value={value.post_3dlut_mode} options={lut} label={v => v === 'Embedded' ? 'Apply embedded LUT' : 'No LUT'} onChange={v => set('post_3dlut_mode', v)} />}
      </section>
      <section className="raw-section"><h4>Image</h4>
        <RawSelect name="ISO" value={value.iso} options={braw.info.options.iso ?? []} onChange={v => set('iso', v)} />
        <RawSlider name="Color Temp" value={Number(value.white_balance_kelvin)} camera={Number(camera.white_balance_kelvin)} min={range('white_balance_kelvin', [2000, 50000])[0]} max={Math.min(12000, range('white_balance_kelvin', [2000, 50000])[1])} step={50} onChange={v => set('white_balance_kelvin', v)} />
        <RawSlider name="Tint" value={Number(value.white_balance_tint)} camera={Number(camera.white_balance_tint)} min={range('white_balance_tint', [-150, 150])[0]} max={range('white_balance_tint', [-150, 150])[1]} step={1} onChange={v => set('white_balance_tint', v)} />
        <RawSlider name="Exposure" value={Number(value.exposure)} camera={Number(camera.exposure)} min={range('exposure', [-5, 5])[0]} max={range('exposure', [-5, 5])[1]} step={.01} onChange={v => set('exposure', v)} />
        <RawSwitch name="Highlight Recovery" value={value.highlight_recovery} onChange={v => set('highlight_recovery', v)} />
        <RawSwitch name="Gamut Compression" value={value.gamut_compression_enable} onChange={v => set('gamut_compression_enable', v)} />
      </section>
      <section className={`raw-section${editable ? '' : ' raw-off'}`}><h4>Custom gamma{!editable && <small> · Film, Extended Video or Custom</small>}</h4>
        {CURVE.slice(0, 4).map(([key, name, step]) => <RawSlider key={key} name={name} value={curve[key]} camera={curve[key]} disabled={!editable} min={range(key, [0, 2])[0]} max={range(key, [0, 2])[1]} step={step} onChange={v => set(key, v ?? curve[key])} />)}
      </section>
      <section className={`raw-section${editable ? '' : ' raw-off'}`}><h4>Levels</h4>
        {CURVE.slice(4).map(([key, name, step]) => <RawSlider key={key} name={name} value={curve[key]} camera={curve[key]} disabled={!editable} min={range(key, [0, 2])[0]} max={range(key, [0, 2])[1]} step={step} onChange={v => set(key, v ?? curve[key])} />)}
        <RawSwitch name="Use Video Black Level" disabled={!editable} value={curve.tone_curve_video_black_level} onChange={v => set('tone_curve_video_black_level', v)} />
      </section>
    </div>
    <p className="tool-note">Decoded by Blackmagic's RAW SDK, as in DaVinci Resolve. Settings apply to every clip of this media; the clip develops again after a change and exports wait for it.{value.viewing_gamma === 'Blackmagic Design Film' && Number(value.viewing_bmdgen) !== 5 ? ' Colour management reads Film as Gen 5 only.' : ''}</p>
  </div>;
}
