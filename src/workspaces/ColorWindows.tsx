import { Blend, Circle, RectangleHorizontal, RotateCcw } from 'lucide-react';
import { GRADE_PARAMS, on } from '../services/grading';
import { IconButton } from '../components/ui';
import { KeyView, Slider, Toggle, type KeyPanelProps } from './ColorQualifier';
import './colorKeys.css';

const CARDS = [['grad', 'gradient', 'Gradient', Blend], ['circ', 'circle', 'Circle', Circle], ['rect', 'rectangle', 'Rectangle', RectangleHorizontal]] as const;
// Position and size share a row: two sliders side by side keep a card short enough for a MacBook's tool area.
const PAIRS: Record<string, [string, string]> = { X: ['Center', 'Y'], W: ['Size', 'H'] };

/** Gradient, circle and rectangle windows of the selected node (docs/color-grading-v3.md, Windows). The shapes are edited on the
 *  viewer (ColorWindowOverlay); here are their exact values. Editing a window turns it on. */
export function WindowsPanel({ node, update }: KeyPanelProps) {
  const p = node.parameters;
  return <div className="ck-panel ck-windows">
    <div className="ck-head"><KeyView nodeId={node.id}/><small className="ck-hint">Drag the handles on the viewer · Shift turns in 15° steps and resizes evenly</small></div>
    <div className="ck-cards">{CARDS.map(([kind, group, name, Icon]) => {
      const active = on(p[`${kind}On`]), keys = GRADE_PARAMS.filter(d => d.group === group && d.key !== `${kind}On` && d.key !== `${kind}Invert`).map(d => d.key);
      const set = (patch: Record<string, number>) => update({ ...patch, ...(active || `${kind}On` in patch ? {} : { [`${kind}On`]: 1 }) });
      const rows = keys.filter(k => !Object.values(PAIRS).some(([, second]) => k === kind + second)).map(k => {
        const pair = PAIRS[k.slice(kind.length)];
        return pair ? <div key={k} className="ck-pair" role="group" aria-label={`${name} ${kind === 'circ' && pair[0] === 'Size' ? 'radius' : pair[0].toLowerCase()}`}>
          <span>{kind === 'circ' && pair[0] === 'Size' ? 'Radius' : pair[0]}</span><Slider k={k} p={p} set={set} prefix={`${name} `} bare/><Slider k={kind + pair[1]} p={p} set={set} prefix={`${name} `} bare/></div>
          : <Slider key={k} k={k} p={p} set={set} prefix={`${name} `}/>;
      });
      return <section key={kind} className={`ck-card${active ? ' on' : ''}`} aria-label={`${name} window`}>
        <header><Icon size={13} aria-hidden/><strong>{name}</strong><span className="spacer"/>
          <Toggle label="On" value={active} change={v => update({ [`${kind}On`]: v ? 1 : 0 })} title={`Use the ${name.toLowerCase()} window`}/>
          <Toggle label="Invert" value={on(p[`${kind}Invert`])} change={v => set({ [`${kind}Invert`]: v ? 1 : 0 })} title="Grade the other side"/>
          <IconButton label={`Reset ${name.toLowerCase()} window`} onClick={() => update(Object.fromEntries([...keys.map(k => [k, GRADE_PARAMS.find(d => d.key === k)!.initial]), [`${kind}Invert`, 0]]))}><RotateCcw size={12}/></IconButton>
        </header>
        <div className="ck-sliders">{rows}</div>
      </section>;
    })}</div>
  </div>;
}
