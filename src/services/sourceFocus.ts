import { create } from 'zustand';
import { useEditorStore } from '../state/store';
import { pictureTimeAt, playheadShowing } from './motionTracker';
import { useTrackerEditor } from './motionTrackerClient';
import { useMaskEditor } from './smartMaskClient';

/**
 * A frame editor (motion tracker or Smart Mask) open in the viewer. While one is, the viewer shows that clip's own
 * source frames, whole and untransformed, through the timeline's streaming engine: the editor plays, scrubs and steps
 * at playback speed, with its marks drawn over the moving picture in source pixels.
 */
export type FocusKind = 'tracker' | 'mask';
export type SourceFocus = { kind: FocusKind; clipId: string; time: number };

export function sourceFocus(): SourceFocus | null {
  const tracker = useTrackerEditor.getState();
  if (tracker.clipId) return { kind: 'tracker', clipId: tracker.clipId, time: tracker.time };
  const mask = useMaskEditor.getState();
  return mask.clipId ? { kind: 'mask', clipId: mask.clipId, time: mask.time } : null;
}

export function useFocusKind(): FocusKind | null {
  const tracker = useTrackerEditor(s => !!s.clipId), mask = useMaskEditor(s => !!s.clipId);
  return tracker ? 'tracker' : mask ? 'mask' : null;
}
export function useFocusClipId() {
  const tracker = useTrackerEditor(s => s.clipId), mask = useMaskEditor(s => s.clipId);
  return tracker ?? mask;
}

/** Zoom while a frame editor is open: 'Fit', or source pixels per screen pixel in percent. */
export const FOCUS_ZOOMS = ['Fit', '100', '200', '400'] as const;
export const useFocusZoom = create<{ zoom: typeof FOCUS_ZOOMS[number] }>(() => ({ zoom: 'Fit' }));

export function closeFocus() {
  useTrackerEditor.setState({ clipId: null, trackerId: null });
  useMaskEditor.setState({ clipId: null, maskId: null });
}

function setFocusTime(time: number) {
  if (useTrackerEditor.getState().clipId) useTrackerEditor.setState({ time });
  else if (useMaskEditor.getState().clipId) useMaskEditor.setState({ time });
}

const lookup = (clipId: string) => {
  const state = useEditorStore.getState(), clip = state.clips.find(c => c.id === clipId && c.projectId === state.projectId && c.timelineId === state.timelineId);
  return { state, clip, asset: clip && state.media.find(m => m.id === clip.mediaId), fps: state.projects.find(p => p.id === state.projectId)?.fps || 24 };
};

/** The playhead this module last moved: a playhead change that lands there is the editor's own, not a scrub. */
let movedTo: number | undefined;
/** Show source second `time` in the open editor, and put the timeline playhead on the frame showing it where one does. */
export function showFocusFrame(time: number) {
  const focus = sourceFocus();
  if (!focus) return;
  setFocusTime(time);
  const { state, clip, asset, fps } = lookup(focus.clipId), at = clip && asset && playheadShowing(clip, asset, time, fps);
  if (at === undefined || Math.abs(at - state.playhead) < 1e-6) return;
  movedTo = at;
  state.setPlayhead(at);
}

/** Frame stepping belongs to the open editor: it walks source frames, which a timeline frame can skip or repeat. */
let stepper: ((delta: number) => void) | null = null;
export function registerFocusStep(step: (delta: number) => void) {
  stepper = step;
  return () => { if (stepper === step) stepper = null; };
}
/** Step the open editor `delta` source frames; false when no editor is open. */
export function stepFocus(delta: number) {
  if (!stepper || !sourceFocus()) return false;
  stepper(delta);
  return true;
}

/**
 * Keep the open editor on the frame the viewer shows. Playing, the frame comes from the picture itself, so the marks
 * are drawn on exactly the frame on screen, and playback loops over the clip being edited. Paused, a playhead moved
 * on the timeline moves the editor to the source frame it shows.
 */
export function followFocus(canvas: HTMLCanvasElement) {
  // One frame editor at a time: the viewer shows one clip's source. Each opens at Fit, with its subject in view.
  const opened = (close: () => void) => (state: { clipId: string | null }, previous: { clipId: string | null }) => {
    if (state.clipId && state.clipId !== previous.clipId) { close(); useFocusZoom.setState({ zoom: 'Fit' }); }
  };
  const trackerOpened = useTrackerEditor.subscribe(opened(() => useMaskEditor.setState({ clipId: null, maskId: null })));
  const maskOpened = useMaskEditor.subscribe(opened(() => useTrackerEditor.setState({ clipId: null, trackerId: null })));
  // A finished run's message belongs to that session; reopening starts clean.
  const trackerClosed = useTrackerEditor.subscribe((state, previous) => {
    if (!state.clipId && previous.clipId && state.job && !['starting', 'queued', 'running'].includes(state.job.status)) useTrackerEditor.setState({ job: null });
  });
  const unsubscribe = useEditorStore.subscribe((state, previous) => {
    const focus = sourceFocus();
    if (!focus) return;
    // The editor belongs to one clip on one timeline: another timeline, project or workspace closes it.
    if (state.timelineId !== previous.timelineId || state.projectId !== previous.projectId || state.workspace !== previous.workspace) { closeFocus(); return; }
    if (state.playhead === previous.playhead && state.playing === previous.playing) return;
    // Following a collaborator, their playhead rules; the editor just shows what it lands on.
    if (state.liveMode === 'following') return;
    const { clip, asset, fps } = lookup(focus.clipId);
    if (!clip || !asset) return;
    const end = clip.start + clip.duration;
    // Playback that ran off the clip, or stopped at the end of the timeline, goes round again from the clip's start.
    const ranOut = state.playhead >= end - 1e-6 || state.playhead < clip.start - 1e-6;
    if (state.playing) movedTo = undefined;
    if (state.playing && ranOut) { useEditorStore.setState({ playhead: clip.start }); return; }
    if (previous.playing && !state.playing && state.playhead !== previous.playhead && state.playhead >= end - 1e-6) { useEditorStore.setState({ playhead: clip.start, playing: true }); return; }
    if (state.playing || state.playhead === previous.playhead) return;
    const own = movedTo !== undefined && Math.abs(state.playhead - movedTo) < 1e-6;
    movedTo = undefined;
    if (own) return;
    setFocusTime(pictureTimeAt(clip, asset, Math.max(clip.start, Math.min(end - 1e-6, state.playhead)), fps));
  });
  const frame = () => {
    const focus = sourceFocus();
    if (!focus || !useEditorStore.getState().playing || canvas.dataset.sourceClip !== focus.clipId) return;
    const shown = Number(canvas.dataset.sourceTimestamp), fps = lookup(focus.clipId).asset?.fps || 24;
    // A quarter frame in, so a proxy timestamp a hair off the original's still names the same frame.
    if (canvas.dataset.sourceTimestamp && Number.isFinite(shown)) setFocusTime(shown + .25 / fps);
  };
  window.addEventListener('frameline:frame', frame);
  return () => { unsubscribe(); trackerOpened(); maskOpened(); trackerClosed(); window.removeEventListener('frameline:frame', frame); };
}
