import { useState } from 'react';
import type { Project } from '../state/models';
import { useEditorStore } from '../state/store';
import { Button } from './ui';

const resolutions = ['1280 × 720', '1920 × 1080', '2560 × 1440', '3840 × 2160', '1080 × 1920', '1080 × 1080', '1080 × 1350'];
const ratios = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['4:5', 4 / 5], ['21:9', 21 / 9]] as const;

export default function TimelineSettings() {
  const project = useEditorStore(s => s.projects.find(p => p.id === s.projectId));
  return project ? <FormatForm key={`${project.id}:${project.resolution}:${project.fps}`} project={project} /> : <p className="settings-small-note">Open a project to change its timeline settings. Defaults for new projects are in Editing.</p>;
}

function FormatForm({ project }: { project: Project }) {
  const [width, setWidth] = useState(project.resolution.match(/\d+/g)?.[0] ?? '1920');
  const [height, setHeight] = useState(project.resolution.match(/\d+/g)?.[1] ?? '1080');
  const [fps, setFps] = useState(String(project.fps));
  const currentUserId = useEditorStore(s => s.currentUserId);
  const role = project.members.find(member => member.userId === currentUserId)?.role;
  const editable = role === 'Owner' || role === 'Editor';
  const resolution = `${width} × ${height}`;
  const ratio = ratios.find(([, value]) => Math.abs(Number(width) / Number(height) - value) < .002)?.[0] ?? 'Custom';
  return <form onSubmit={event => {
    event.preventDefault();
    const state = useEditorStore.getState();
    if (state.setTimelineFormat(Number(width), Number(height), Number(fps))) state.notify('Timeline settings applied', 'success');
  }}>
    <p className="settings-small-note">All timelines in “{project.name}” share this format. Changes update the viewer and timeline frame grid. Clip positions and durations stay the same; export settings can override this format.</p>
    <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label className="settings-row"><span><strong>Resolution</strong><small>Choose a preset or enter custom dimensions below.</small></span><select className="select" value={resolutions.includes(resolution) ? resolution : 'Custom'} onChange={event => { if (event.target.value === 'Custom') return; const [w, h] = event.target.value.split(' × '); setWidth(w); setHeight(h); }}><option>Custom</option>{resolutions.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="settings-row"><span><strong>Aspect ratio</strong><small>Changing the ratio keeps the width and adjusts the height.</small></span><select className="select" value={ratio} onChange={event => { const selected = ratios.find(([name]) => name === event.target.value); if (selected) setHeight(String(Math.round(Number(width) / selected[1]))); }}><option>Custom</option>{ratios.map(([name]) => <option key={name}>{name}</option>)}</select></label>
      <label className="settings-row"><span><strong>Width</strong><small>Pixels · 16–8192</small></span><input className="input" aria-label="Timeline width" type="number" required min="16" max="8192" step="1" value={width} onChange={event => setWidth(event.target.value)} /></label>
      <label className="settings-row"><span><strong>Height</strong><small>Pixels · 16–8192</small></span><input className="input" aria-label="Timeline height" type="number" required min="16" max="8192" step="1" value={height} onChange={event => setHeight(event.target.value)} /></label>
      <label className="settings-row"><span><strong>Frame rate</strong><small>Frames per second · 1–240</small></span><input className="input" aria-label="Timeline frame rate" type="number" required min="1" max="240" step="any" list="timeline-frame-rates" value={fps} onChange={event => setFps(event.target.value)} /><datalist id="timeline-frame-rates">{[23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120].map(value => <option key={value} value={value} />)}</datalist></label>
      <Button type="submit">Apply timeline settings</Button>
    </fieldset>
    {!editable && <p className="settings-small-note">An editor role is required to change the timeline format.</p>}
  </form>;
}
