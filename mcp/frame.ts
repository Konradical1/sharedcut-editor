// The frame tool: the real picture, rendered by the server's export renderer (GET /api/frames), so grades, titles,
// transitions, keyframes and masks look exactly as Export draws them. Read-only; pending edits are saved first because
// the server renders from its own copy. What it cannot render alone (a composition renders its whole timeline;
// Stabilize, optical flow and depth bake whole clips) falls back to the composition's inside or the clip's source.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { useEditorStore as store } from '../src/state/store.ts';
import type { Clip, MediaAsset, Timeline } from '../src/state/models.ts';
import { sourceTime, projectSize } from '../src/services/playback.ts';
import { timecode } from '../src/services/timecode.ts';
import { isComposition } from '../src/services/compositions.ts';
import { isTitle } from '../src/services/text.ts';
import { isShape } from '../src/services/shapes.ts';
import { isAdjustment } from '../src/services/adjustment.ts';
import { call, flush, ApiFailure } from './session.ts';
import { handle, secs } from './views.ts';
import { image, sleep, project, timeline as openTimeline, type Content } from './jobs/kit.ts';

type Shot = { jpeg: Buffer; note: string };
const OLD_SERVER = 'API endpoint not found.', SHEET_BUDGET_MS = 40_000;
/** Why /api/frames skipped a still (server/previewCache.ts STILL_LIVE), in a few words. */
const LIVE: Record<string, string> = { composition: 'a composition under the top clip', bake: 'Stabilize/optical flow', depth: 'Depth', cut: 'this dissolve' };

/** One JPEG from /api/frames; a busy queue (429) is waited out a few times. */
async function render(query: Record<string, string | number>): Promise<Buffer> {
  const path = `/frames?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await call<Buffer>(path);
      if (!Buffer.isBuffer(data)) throw new Error('The server answered /api/frames without a picture.');
      return data;
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 429 && attempt < 3) { await sleep(3000); continue; }
      throw error;
    }
  }
}
const oldServer = (error: unknown) => error instanceof ApiFailure && error.status === 404 && error.data?.error === OLD_SERVER;
const assetOf = (c: Clip) => store.getState().media.find(m => m.id === c.mediaId);

/** The topmost clip drawn at `t` (higher video track on top) that `pick` accepts. */
function topClip(timelineId: string, t: number, pick: (c: Clip) => boolean = () => true) {
  const s = store.getState(), number = new Map(s.tracks.filter(x => x.timelineId === timelineId && x.kind === 'video' && !x.hidden).map(x => [x.id, x.number]));
  return s.clips.filter(c => c.timelineId === timelineId && !c.disabled && number.has(c.trackId) && c.start <= t + 1e-6 && t < c.start + c.duration - 1e-6 && pick(c))
    .sort((a, b) => number.get(b.trackId)! - number.get(a.trackId)!)[0];
}

/** A file's own picture at `seconds` into it (untouched: no grade, transform or effect). Old servers: its thumbnail. */
async function mediaShot(asset: MediaAsset, seconds: number, width: number): Promise<Shot> {
  if (asset.kind === 'audio') throw new Error(`${handle(asset.id)} is audio; job levels shows its sound.`);
  const at = asset.kind === 'image' ? 0 : Math.max(0, Math.min(seconds, asset.duration - 1 / (asset.fps || 24)));
  try { return { jpeg: await render({ projectId: asset.projectId, mediaId: asset.id, t: at, w: width }), note: `source "${asset.name}" @${secs(at)}s, ungraded` }; }
  catch (error) {
    if (!oldServer(error) || !asset.thumbnail) throw error;
    return { jpeg: await call<Buffer>(asset.thumbnail.replace(/^\/api/, '')), note: `thumbnail of "${asset.name}" (server has no /api/frames; update it)` };
  }
}
async function sourceShot(c: Clip, t: number, width: number): Promise<Shot> {
  const asset = assetOf(c);
  if (!asset) throw new Error(`${handle(c.id)} has no media file to show.`);
  return mediaShot(asset, sourceTime(c, t, asset.fps || project().fps, asset.duration), width);
}

/** The timeline's final picture at `t`, or the closest honest stand-in when the server cannot render it alone. */
async function timelineShot(tl: Timeline, t: number, width: number, depth = 0): Promise<Shot> {
  try { return { jpeg: await render({ projectId: tl.projectId, timelineId: tl.id, t, w: width }), note: '' }; }
  catch (error) {
    if (!(error instanceof ApiFailure) || !(error.status === 409 || oldServer(error))) throw error;
    // Titles, shapes and adjustment clips draw over a picture, never one of their own: look through them.
    const s = store.getState(), drawn = (c: Clip) => !isTitle(c) && !isShape(c) && !isAdjustment(c), top = topClip(tl.id, t, drawn);
    if (error.data?.live === 'composition' && top && isComposition(top) && depth < 4) {
      const inner = s.timelines.find(x => x.id === top.properties.compositionId);
      if (inner) {
        const at = sourceTime(top, t, project().fps, inner.duration), shot = await timelineShot(inner, at, width, depth + 1);
        const over = topClip(tl.id, t)?.id !== top.id ? ' (overlays above it not drawn)' : '';
        return { jpeg: shot.jpeg, note: `inside composition "${inner.name}" @${secs(at)}s${over}${shot.note ? `; ${shot.note}` : ''}` };
      }
    }
    const shown = topClip(tl.id, t, c => drawn(c) && !isComposition(c) && !!assetOf(c));
    if (!shown) throw new Error(`Nothing to show at ${secs(t)}s: ${oldServer(error) ? 'the server has no /api/frames (update it)' : error.data?.error}`);
    const shot = await sourceShot(shown, t, width);
    const why = oldServer(error) ? '' : `${LIVE[error.data?.live as string] ?? error.data?.error} renders only in editor/Export; `;
    return { jpeg: shot.jpeg, note: `${why}${handle(shown.id)} ${shot.note}` };
  }
}

/** One cell per time, `cell` px on the long edge, timecode on each; failed cells say so in the notes. */
async function sheet(times: number[], cell: number, shoot: (t: number) => Promise<Shot>) {
  const [pw, ph] = projectSize(project().resolution), w = pw >= ph ? cell : Math.round(cell * pw / ph), h = pw >= ph ? Math.round(cell * ph / pw) : cell;
  const cols = Math.min(4, Math.ceil(Math.sqrt(times.length))), rows = Math.ceil(times.length / cols), fps = project().fps;
  const canvas = createCanvas(cols * w, rows * h), g = canvas.getContext('2d'), notes: string[] = [];
  g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height);
  g.font = '11px sans-serif'; g.textBaseline = 'bottom';
  // ponytail: one cell at a time; the server renders two at once, so pairs would halve a long sheet.
  // A budget keeps a sheet on a busy host inside an MCP client's tool timeout (Codex: 60 s).
  const deadline = Date.now() + SHEET_BUDGET_MS, late: number[] = [];
  for (const [i, t] of times.entries()) {
    const x = (i % cols) * w, y = Math.floor(i / cols) * h;
    let label = timecode(t, fps);
    if (Date.now() > deadline) { label += ` ×${i + 1}`; late.push(i + 1); }
    else try {
      const shot = await shoot(t), picture = await loadImage(shot.jpeg), scale = Math.min(w / picture.width, h / picture.height);
      g.drawImage(picture, x + (w - picture.width * scale) / 2, y + (h - picture.height * scale) / 2, picture.width * scale, picture.height * scale);
      if (shot.note) { label += ` *${i + 1}`; notes.push(`*${i + 1} ${shot.note}`); }
    } catch (error) { label += ` ×${i + 1}`; notes.push(`×${i + 1} ${error instanceof Error ? error.message : error}`); }
    const box = g.measureText(label).width + 6;
    g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x, y + h - 15, box, 15);
    g.fillStyle = '#fff'; g.fillText(label, x + 3, y + h - 2);
  }
  if (late.length) notes.push(`×${late.join(',')} not rendered: out of time; ask fewer frames or a shorter from/to`);
  return { jpeg: Buffer.from(await canvas.encode('jpeg', 80)), size: `${cols}×${rows} of ${w}×${h}`, notes };
}

export async function frame(args: { time?: number; clip?: string; media?: string; width?: number; from?: number; to?: number; n?: number }): Promise<string | Content[]> {
  // The server renders what it holds: save first, as the editor does before a preview.
  await flush();
  const s = store.getState(), p = project(), fps = p.fps, n = Math.max(1, Math.min(16, Math.round(args.n ?? 1)));
  const width = Math.round(Math.max(64, Math.min(n > 1 ? 512 : 1280, args.width ?? (n > 1 ? 256 : 512))));
  let span: [number, number], sheetSpan: [number, number] | undefined, shoot: (t: number) => Promise<Shot>, title: string;
  if (args.media) {
    const asset = s.media.find(m => m.id === args.media);
    if (!asset) throw new Error(`No media ${handle(args.media)}. Look at the media list again.`);
    span = [0, Math.max(0, asset.duration - 1 / (asset.fps || fps))]; title = handle(asset.id);
    shoot = t => mediaShot(asset, t, width);
  } else if (args.clip) {
    const c = s.clips.find(x => x.id === args.clip);
    if (!c) throw new Error(`No clip ${handle(args.clip)}. Look at the timeline again.`);
    const tl = s.timelines.find(x => x.id === c.timelineId)!, inner = isComposition(c) ? s.timelines.find(x => x.id === c.properties.compositionId) : undefined;
    span = [c.start, c.start + Math.max(0, c.duration - 1 / fps)]; title = `${handle(c.id)} "${c.name}"`;
    shoot = async t => {
      if (inner) { const at = sourceTime(c, t, fps, inner.duration), shot = await timelineShot(inner, at, width); return { jpeg: shot.jpeg, note: `inside "${inner.name}" @${secs(at)}s${shot.note ? `; ${shot.note}` : ''}` }; }
      if (assetOf(c)) return sourceShot(c, t, width);
      // Titles, shapes and adjustment clips have no file: show what they do to the timeline.
      const shot = await timelineShot(tl, t, width);
      return { jpeg: shot.jpeg, note: `no source file; the timeline @${secs(t)}s${shot.note ? `; ${shot.note}` : ''}` };
    };
  } else {
    const tl = openTimeline(), end = Math.max(0, ...s.clips.filter(c => c.timelineId === tl.id && !c.disabled).map(c => c.start + c.duration));
    span = [0, Math.max(0, tl.duration - 1 / fps)]; title = `"${tl.name}"`;
    // A sheet covers the edit, not the empty timeline after it.
    if (end) sheetSpan = [0, Math.min(span[1], end - 1 / fps)];
    shoot = t => timelineShot(tl, t, width);
  }
  const clamp = (t: number) => Math.max(span[0], Math.min(span[1], t));
  if (n > 1) {
    // Past the edit there is only black: keep even an explicit from/to inside it.
    const [lo, hi] = sheetSpan ?? span, inside = (t: number) => Math.max(lo, Math.min(hi, t));
    const from = inside(args.from ?? lo), to = inside(args.to ?? hi);
    const times = Array.from({ length: n }, (_, i) => Math.floor((from + (to - from) * i / (n - 1)) * fps + 1e-6) / fps);
    const out = await sheet(times, width, shoot);
    return [{ type: 'text', text: [`${title} ${n} frames ${secs(from)}–${secs(to)}s, ${out.size}, left→right then down`, ...out.notes].join('\n') }, image(out.jpeg)];
  }
  // A clip's frame defaults to the playhead when it is over the clip, else the clip's first frame; media to its start.
  const asked = args.time ?? (args.media ? 0 : args.clip && (s.playhead < span[0] || s.playhead > span[1] + 1 / fps) ? span[0] : s.playhead);
  const t = Math.floor(clamp(asked) * fps + 1e-6) / fps, shot = await shoot(t);
  // Past the last clip there is only black; say so rather than present it as the picture.
  const past = sheetSpan && t > sheetSpan[1] + 1e-6 ? ` · past the end of the edit (last frame ${secs(sheetSpan[1])}s)` : '';
  return [{ type: 'text', text: `${title} ${timecode(t, fps)} (${secs(t)}s) ${shot.note || 'final picture'}${past}` }, image(shot.jpeg)];
}
