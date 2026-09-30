import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import type { Clip, MediaAsset } from '../src/state/models.ts';
import { evaluateClip, fadeLevel } from '../src/services/animation.ts';
import { isCaption } from '../src/services/captions.ts';
import { effectEnabled } from '../src/services/effects.ts';
import { drawMotionPose, motionArtwork, transformMotion } from '../src/services/motionBlur.ts';
import { sourceTime } from '../src/services/playback.ts';
import { drawShape, getShape, isShape, validateShape } from '../src/services/shapes.ts';
import { drawText, getText, isTitle, validateText } from '../src/services/text.ts';
import { transitionName } from '../src/services/transitions.ts';

/**
 * An animated title or shape whose look is fully drawn by the canvas: position, zoom, rotation, anchor, crop, opacity
 * and fades, animated text and shape properties, typing. Those are drawn one frame at a time, exactly as the preview
 * draws them, and streamed into one alpha movie. Anything the FFmpeg graph must still do per pixel (effects, blend
 * modes, motion blur, transitions) keeps the per-frame bake.
 */
export function streamableGraphic(clip: Clip) {
  const p = clip.properties;
  return (isTitle(clip) || isShape(clip)) && !isCaption(clip) && !clip.disabled && Object.keys(clip.keyframes ?? {}).length > 0
    && p.motionBlur !== true && String(p.blendMode ?? 'Normal') === 'Normal'
    && !clip.effects.some(effect => effectEnabled(clip, effect) && Number(effect.amount) > 0)
    && !transitionName(clip, 'in') && !transitionName(clip, 'out');
}

type Request = {
  project: { id: string; resolution: string; fps: number }; timeline: { id: string; duration: number }; clips: Clip[];
  tracks: { id: string; hidden: boolean; kind: string }[]; assets: { asset: MediaAsset; path: string }[];
  settings: Record<string, string>; signal?: AbortSignal; onStage?: (stage: string) => void; onProgress?: (percent: number) => void;
};

const size = (resolution: string) => resolution.split(/[×x]/).map(value => Number(value.trim())) as [number, number];

/** Renders every streamable animated graphic on the timeline to its own alpha movie in `directory` and returns the
 *  request with those clips replaced (same track, frame-exact span, nothing left to transform), or null if none. */
export async function bakeAnimatedGraphics<T extends Request>(request: T, directory: string): Promise<T | null> {
  const fps = Number(request.settings.fps || request.project.fps), start = Number(request.settings.rangeIn || 0), end = Number(request.settings.rangeOut || request.timeline.duration);
  const [width, height] = size(request.settings.resolution || request.project.resolution), [projectWidth, projectHeight] = size(request.project.resolution);
  if (![fps, start, end, width, height, projectWidth, projectHeight].every(Number.isFinite) || end <= start) return null;
  // Placement is decided on whole output frames, the way the compositor decides it (media.ts onScreen).
  const count = Math.ceil((end - start) * fps - 1e-7), span = (clip: Clip) => [Math.max(0, Math.round((clip.start - start) * fps)), Math.min(count, Math.round((clip.start + clip.duration - start) * fps))] as const;
  const graphics = request.clips.filter(clip => {
    const track = request.tracks.find(t => t.id === clip.trackId);
    return clip.timelineId === request.timeline.id && streamableGraphic(clip) && !!track && !track.hidden && track.kind === 'video' && span(clip)[1] > span(clip)[0];
  });
  if (!graphics.length) return null;
  const baked: Clip[] = [], assets: T['assets'] = [], total = graphics.reduce((sum, clip) => sum + span(clip)[1] - span(clip)[0], 0);
  let done = 0;
  for (const [index, original] of graphics.entries()) {
    const [from, to] = span(original);
    if (isTitle(original)) for (const run of getText(original).runs) if (!GlobalFonts.has(run.style.fontFamily)) throw new Error(`${original.name}: font “${run.style.fontFamily}” is missing on the server. Upload it to Shared fonts before exporting.`);
    request.onStage?.(`Rendering animated graphics · ${original.name}`);
    const output = join(directory, `graphic-${index}.mov`);
    const encoder = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0', '-an', '-c:v', 'prores_ks', '-profile:v', '4', '-pix_fmt', 'yuva444p10le', output], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let errors = '', failure: Error | undefined;
    encoder.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    encoder.stdin.on('error', error => { failure = error; });
    const closed = new Promise<void>((resolve, reject) => { encoder.on('error', reject); encoder.on('close', code => code === 0 ? resolve() : reject(new Error(request.signal?.aborted ? 'Cancelled' : `Graphic render failed: ${errors.trim() || code}`))); });
    void closed.catch(() => {});
    const abort = () => encoder.kill('SIGKILL');
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      const layer = createCanvas(width, height), art = layer.getContext('2d') as unknown as CanvasRenderingContext2D;
      const frame = createCanvas(width, height), target = frame.getContext('2d') as unknown as CanvasRenderingContext2D;
      for (let n = from; n < to; n++) {
        if (request.signal?.aborted) throw new Error('Cancelled');
        if (failure) throw failure;
        // The same drawing the preview does for a title or shape layer (playback.ts), at the output size.
        const time = start + n / fps, clip = evaluateClip(original, time, fps), poses = transformMotion(clip, time, request.project.fps, projectWidth, projectHeight);
        art.clearRect(0, 0, width, height);
        const artwork = poses.length > 1 ? motionArtwork(clip) : clip;
        if (isTitle(clip)) { const doc = getText(artwork); validateText(doc); drawText(art, doc, width, height, projectWidth, projectHeight, sourceTime(original, time, request.project.fps || 24), clip.properties.animationTypingCount as number | undefined); }
        else { const doc = getShape(artwork); validateShape(doc); drawShape(art, doc, width, height, projectWidth, projectHeight); }
        target.clearRect(0, 0, width, height);
        target.save();
        target.globalAlpha = Math.max(0, Math.min(1, Number(clip.properties.opacity ?? 100) / 100)) * fadeLevel(clip, time);
        drawMotionPose(target, layer as unknown as CanvasImageSource, poses[0], clip, width, height, projectWidth, projectHeight);
        target.restore();
        if (!encoder.stdin.write(Buffer.from(target.getImageData(0, 0, width, height).data))) await Promise.race([once(encoder.stdin, 'drain'), closed.then(() => { throw new Error('Graphic encoder closed early'); })]);
        request.onProgress?.(++done / total * 40);
      }
      encoder.stdin.end();
      await closed;
    } finally { request.signal?.removeEventListener('abort', abort); encoder.kill('SIGKILL'); await closed.catch(() => {}); }
    const id = `graphic-bake-${index}`, duration = (to - from) / fps;
    baked.push({ id, projectId: original.projectId, timelineId: original.timelineId, trackId: original.trackId, mediaId: id, name: original.name, start: start + from / fps, duration, sourceIn: 0, color: original.color, disabled: false, properties: {}, effects: [] });
    assets.push({ path: output, asset: { id, projectId: request.project.id, name: original.name, kind: 'video', binId: '', thumbnail: '', duration, resolution: `${width} × ${height}`, fps, size: '', status: 'ready', progress: 100, hasAudio: false, inputProfile: 'Rec.709' } as MediaAsset });
  }
  const replaced = new Set(graphics.map(clip => clip.id));
  return { ...request, clips: [...request.clips.filter(clip => !replaced.has(clip.id)), ...baked], assets: [...request.assets, ...assets] };
}
