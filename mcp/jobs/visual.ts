// Visual and audio checks. Pictures come from the frame tool (mcp/frame.ts, GET /api/frames); this module adds the
// levels job (sound as text, from the waveform peaks every media row already carries: no request, no render) and the
// "visual" help topic.
import { store, handle, done, timeline, type JobDef } from './kit.ts';
import { waveformBars } from '../../src/services/waveform.ts';
import { sourceTime } from '../../src/services/playback.ts';
import { loudnessTarget, loudnessTargets } from '../../src/services/effects.ts';
import { isComposition } from '../../src/services/compositions.ts';
import { secs } from '../views.ts';
import type { Clip, MediaAsset, Track } from '../../src/state/models.ts';

const BARS = ' ▁▂▃▄▅▆▇█', SILENT_DB = -50, SILENT_SECONDS = .5;
const db = (v: number) => v > 1e-6 ? 20 * Math.log10(v) : -120;
const signed = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10}`;

/** One clip's sound over [a, b] timeline seconds, as one line. Static gain only: gain keys and fades are not applied. */
export function levelLine(c: Clip, track: Track, asset: MediaAsset & { loudness?: number }, a: number, b: number, bars: number, fps: number, muted: string) {
  const name = `${track.kind === 'audio' ? 'A' : 'V'}${track.number} ${handle(c.id)} "${c.name}" ${secs(a)}–${secs(b)}`;
  const peaks = asset.waveform ?? [];
  if (!peaks.length || !asset.duration) return `${name} waveform not ready (${asset.status})`;
  const rate = peaks.length / asset.duration, srcA = sourceTime(c, a, fps, asset.duration), srcB = sourceTime(c, b, fps, asset.duration);
  const lo = Math.min(srcA, srcB), hi = Math.max(srcA, srcB), i0 = Math.floor(lo * rate), i1 = Math.max(i0 + 1, Math.ceil(hi * rate));
  // The preview's own gain: track + clip + Normalize loudness (playback.ts updateAudio).
  const normalize = c.properties.normalize && asset.loudness !== undefined ? loudnessTarget(c) - asset.loudness : 0;
  const gain = track.gain + Number(c.properties.gain ?? 0) + normalize;
  let peak = 0;
  for (let i = i0; i < Math.min(peaks.length, i1); i++) peak = Math.max(peak, peaks[i] || 0);
  // Silent stretches, mapped back onto the timeline (linear between the window's two source times).
  const silences: string[] = [], toTimeline = (src: number) => hi - lo < 1e-9 ? a : a + (src - srcA) / (srcB - srcA) * (b - a);
  for (let i = i0, run = -1; i <= i1; i++) {
    const quiet = i < i1 && i < peaks.length && db(peaks[i] || 0) + gain < SILENT_DB;
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) {
      if ((i - run) / rate >= SILENT_SECONDS) { const [x, y] = [toTimeline(run / rate), toTimeline(i / rate)].sort((p, q) => p - q); silences.push(`${secs(x)}–${secs(y)}`); }
      run = -1;
    }
  }
  const shape = waveformBars(peaks, bars, lo / asset.duration, hi / asset.duration, srcB < srcA).map(v => BARS[Math.min(8, Math.ceil(v * 8))]).join('');
  const keyed = c.keyframes?.['properties.gain']?.length ? ' (gain keyed: static value used)' : '';
  return `${name} pk ${signed(db(peak) + gain)}dB${asset.loudness !== undefined ? ` ${signed(asset.loudness + gain)}LUFS` : ''}${gain ? ` gain ${signed(gain)}dB` : ''}${muted} ${shape}${peak * 10 ** (gain / 20) >= .999 ? ' CLIP' : ''}${keyed}${silences.length ? `\n  silence ${silences.slice(0, 6).join(', ')}${silences.length > 6 ? ` +${silences.length - 6}` : ''}` : ''}`;
}

export const jobs: Record<string, JobDef> = {
  levels: {
    doc: '{clip?|track?, from?, to?, bars?, timeline?} audio peaks dB, LUFS, gain, waveform bars, CLIP, silences per clip (text, no render)',
    async start(params) {
      const s = store.getState(), asked = params.clip ? s.clips.find(c => c.id === params.clip) : undefined;
      if (params.clip && !asked) throw new Error(`No clip ${handle(String(params.clip))}. Look at the timeline again.`);
      const tl = timeline(params.timeline ?? asked?.timelineId), fps = s.projects.find(p => p.id === tl.projectId)?.fps ?? 24;
      const from = Number(params.from ?? 0), to = Number(params.to ?? tl.duration), bars = Math.max(8, Math.min(120, Math.round(Number(params.bars ?? 32))));
      const tracks = s.tracks.filter(t => t.timelineId === tl.id), solo = tracks.some(t => t.solo && !t.muted);
      const wantTrack = params.track ? tracks.find(t => t.id === params.track || `${t.kind === 'audio' ? 'A' : 'V'}${t.number}` === String(params.track).toUpperCase() || t.name === params.track) : undefined;
      if (params.track && !wantTrack) throw new Error(`No track ${params.track} on this timeline.`);
      const own = s.clips.filter(c => c.timelineId === tl.id && !c.disabled);
      // The same take at the same place: a video clip and the audio copy its sound plays from.
      const copy = (a: Clip, b: Clip) => a.mediaId === b.mediaId && a.start === b.start && a.sourceIn === b.sourceIn && a.duration === b.duration;
      const lines: string[] = [];
      for (const c of own.filter(c => (!asked || c.id === asked.id || copy(c, asked)) && c.start < to && c.start + c.duration > from).sort((x, y) => x.start - y.start)) {
        const track = tracks.find(t => t.id === c.trackId), asset = s.media.find(m => m.id === c.mediaId);
        if (isComposition(c)) { lines.push(`${handle(c.id)} "${c.name}" ${secs(c.start)}–${secs(c.start + c.duration)} composition: its sound is inside, levels{timeline:"${handle(String(c.properties.compositionId))}"}`); continue; }
        if (!track || !asset || !(asset.kind === 'audio' || asset.hasAudio) || (wantTrack && track.id !== wantTrack.id)) continue;
        // A video clip's sound plays from its linked audio copy when it has one (server/media.ts audible).
        if (track.kind === 'video' && (c.properties.audioDetached || own.some(o => o.id !== c.id && tracks.find(t => t.id === o.trackId)?.kind === 'audio' && copy(o, c)))) continue;
        const muted = track.muted ? ' MUTED' : solo && !track.solo ? ' (not soloed)' : c.properties.freeze ? ' (frozen: silent)' : '';
        lines.push(levelLine(c, track, asset, Math.max(from, c.start), Math.min(to, c.start + c.duration), bars, fps, muted));
        if (lines.length >= 60) { lines.push('… more clips; narrow with from/to or track'); break; }
      }
      if (!lines.length) return done(params.clip ? `${handle(params.clip)} has no sound here.` : `No sound between ${secs(from)} and ${secs(to)}s.`);
      return done(lines.join('\n'));
    },
  },
};

export const topics: Record<string, string> = {
  visual: [
    'visual: look at the edit. frame (picture) and job levels (sound). Both read only; check after every visual edit.',
    'frame{} = final picture at the playhead; frame{time} at timeline seconds. Rendered by the export renderer, so it is exactly what Export makes: grades, LUTs, titles, shapes, transitions, keyframes, blend modes, adjustment clips, captions, analyzed Smart Masks.',
    'frame saves pending edits first (the server renders its own copy). width default 512, max 1280; an image costs about w×h/750 tokens, so stay small unless judging detail.',
    'frame{n:6, from?, to?} = one contact sheet, timecode per cell, left→right then down. n 2–16, width = cell (default 256, max 512). Good for checking a whole cut in one look.',
    'frame{clip} = that clip\'s source file at time (timeline seconds; default playhead when over the clip, else its first frame), ungraded, no transform. A composition clip shows its inside; a title/shape/adjustment clip shows the timeline. frame{media, time} = a file at seconds into it, also ungraded.',
    'Fallbacks (the text line says which): a composition at the time shows its inside at the mapped time; Noise Reduction, Stabilize, optical flow, Depth and a stale dissolve render whole clips, so the top clip\'s ungraded source is shown ("… renders only in editor/Export"). Those are fine in the editor and in Export.',
    'A frame error that is not a fallback ("X: a transition cannot sit on a keyframed clip", "font missing") is what Export would refuse too: fix the edit.',
    'job levels{clip?|track?, from?, to?, bars?, timeline?}: per audible clip of the open timeline (or timeline): peak dBFS and LUFS after gain (track + clip + Normalize loudness), waveform bars ▁…█ over the used part, CLIP when the peak reaches 0 dBFS, silences < -50 dB ≥ 0.5 s in timeline seconds.',
    `levels uses the file's waveform (200 peaks/s; files over 2:43 get 32768 peaks in all) and the whole file's integrated loudness; gain keys, fades and the mix are not applied. A video clip whose sound plays from its linked audio copy reports the copy. Fix loud/clipping: act updateProperty(clip,"gain",dB) (-60..24); even out: updateProperty(clip,"normalize",true) and "normalizeTarget" ${loudnessTargets.map(t => t.lufs).join('|')}.`,
  ].join('\n'),
};
