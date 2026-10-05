// Smart Mask: look at a clip's source frame (guides and matte drawn on it), guide one frame, analyze (track) the mask.
// Mask documents themselves (add, rename, range, attach, clear) are plain store actions: the "masks" help topic.
// The analyze loop is src/services/smartMaskClient.ts analyzeMask with a bounded wait (that module is not
// Node-importable: extensionless imports).
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { call, ApiFailure, refresh, edit, handle, need, clip as findClip, store, done, image, bytes, type JobDef, type Poller, type Content } from './kit.ts';
import { smartMaskFrame, smartMaskSignature, smartMaskSourceTime, type SmartMaskCapabilities, type SmartMaskDocument, type SmartMaskJob, type SmartMaskManifest, type SmartMaskPrompt, type SmartMaskRepair } from '../../src/services/smartMask.ts';
import { pictureTimeAt } from '../../src/services/motionTracker.ts';
import { createId } from '../../src/services/index.ts';
import { acceptsEffect, effectDefinitions } from '../../src/services/effects.ts';
import type { Clip, MediaAsset } from '../../src/state/models.ts';

const REPAIRS = { restore: 'foreground', remove: 'background', reset: 'unknown' } as const;
// SmartMaskOverlay.tsx guide colours.
const COLORS: Record<string, string> = { include: '#67e4bc', exclude: '#ff7791', foreground: '#85bdff', background: '#ffb879', unknown: '#d3a5ff' };
const RADIUS = .012; // smartMaskClient.ts default brush
const f2 = (v: number) => v.toFixed(2).replace(/^0(?=\.)/, '').replace(/^1\.00$/, '1');
const pid = (c: Clip) => encodeURIComponent(c.projectId);

// The UI reads timing from the tracker route: the Smart Mask one also warms the GPU preview model.
const timesCache = new Map<string, Promise<number[]>>();
function sourceTimes(c: Clip) {
  const key = `${c.id}:${c.mediaId}`;
  let known = timesCache.get(key);
  if (!known) {
    known = call<{ sourceTimes: number[] }>(`/motion-trackers/source-times?clipId=${encodeURIComponent(c.id)}`).then(v => v.sourceTimes);
    timesCache.set(key, known);
    known.catch(() => timesCache.delete(key));
  }
  return known;
}

type Ctx = { c: Clip; asset: MediaAsset; mask?: SmartMaskDocument; times: number[]; first: number; last: number; frame: number };
const currentMask = (x: Ctx) => x.mask && findClip(x.c.id).smartMasks?.find(m => m.id === x.mask!.id);
const onFrame = (x: Ctx, frame: number) => (p: { time: number }) => smartMaskFrame(p.time, x.mask!.source, x.times) === frame;

/** Clip, mask, source timing, the clip's visible source frames, and the frame asked for (SmartMaskOverlay bounds). */
export async function context(params: Record<string, any>, needMask: boolean): Promise<Ctx> {
  const c = findClip(need(params, 'clip')), h = handle(c.id);
  const s = store.getState(), asset = s.media.find(m => m.id === c.mediaId);
  if (!asset || !acceptsEffect(c, asset.kind, 'Smart Mask') || s.tracks.find(t => t.id === c.trackId)?.kind === 'audio') throw new Error(`Smart Mask works on video clips only (${h} is not one).`);
  const masks = c.smartMasks ?? [];
  const mask = params.mask ? masks.find(m => m.id === params.mask) : masks.length === 1 ? masks[0] : undefined;
  if (params.mask && !mask) throw new Error(`${h} has no mask ${handle(params.mask)}.`);
  if (!mask && masks.length > 1) throw new Error(`${h} has ${masks.length} masks; pass mask: ${masks.map(m => `${handle(m.id)} "${m.name}"`).join(', ')}.`);
  if (!mask && needMask) throw new Error(`${h} has no Smart Mask. act addSmartMask("${h}") makes one.`);
  const times = await sourceTimes(c);
  const fps = mask?.source.fps ?? (asset.fps || 24), src = mask?.source ?? { fps, duration: asset.duration };
  const a = smartMaskSourceTime(c, c.start, asset), b = smartMaskSourceTime(c, c.start + Math.max(0, c.duration - 1 / fps), asset);
  const first = smartMaskFrame(Math.min(a, b), src, times), last = smartMaskFrame(Math.max(a, b), src, times);
  let frame: number;
  if (params.frame !== undefined) frame = Math.round(need<number>(params, 'frame', 'number'));
  else if (params.at !== undefined) {
    const at = need<number>(params, 'at', 'number'), projectFps = store.getState().projects.find(p => p.id === c.projectId)?.fps || 24;
    frame = smartMaskFrame(pictureTimeAt(c, asset, Math.max(c.start, Math.min(c.start + c.duration - 1e-6, at)), projectFps), src, times);
  } else {
    const include = mask?.prompts.filter(p => p.kind === 'include').map(p => smartMaskFrame(p.time, src, times)).find(f => f >= first && f <= last);
    frame = include ?? Math.floor((first + last) / 2);
  }
  return { c, asset, mask, times, first, last, frame: Math.max(first, Math.min(last, frame)) };
}

/** Area share and bounding box of a matte (white = subject), read at 256 px wide. */
export function matteStats(matte: Image) {
  const w = 256, h = Math.max(1, Math.round(matte.height * w / matte.width)), canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  ctx.drawImage(matte, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let i = 0; i < w * h; i++) if (data[i * 4] > 127) { const x = i % w, y = (i / w) | 0; count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { area: count / (w * h), box: count ? [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h] : null };
}
const statText = (s: ReturnType<typeof matteStats>) => s.box ? `${(s.area * 100).toFixed(1)}% bbox x${f2(s.box[0])}–${f2(s.box[2])} y${f2(s.box[1])}–${f2(s.box[3])}` : 'empty';

/** An analyzed matte frame: the playback-size preview, else the native frame (older artifacts). */
async function analyzedMatte(c: Clip, key: string, frame: number) {
  try { return await bytes(`/smart-masks/${key}/preview/${frame}.png?projectId=${pid(c)}`); }
  catch (error) { if (!(error instanceof ApiFailure) || error.status !== 404) throw error; }
  return bytes(`/smart-masks/${key}/frames/${frame}.png?projectId=${pid(c)}`);
}

/** The matte the editor would show on this frame: a one-frame preview of fresh guides, else the analysis. */
async function matteFor(x: Ctx, frame: number): Promise<{ label: string; matte?: Image }> {
  const mask = x.mask;
  if (!mask) return { label: 'none' };
  const valid = !!mask.result && mask.result.signature === smartMaskSignature(mask);
  const guides = mask.prompts.filter(onFrame(x, frame));
  try {
    if (!valid && guides.some(p => p.kind === 'include')) {
      const { url } = await call<{ url: string }>('/smart-masks/preview', { method: 'POST', json: { clipId: x.c.id, maskId: mask.id, frame, prompts: guides.map(({ id, time, kind, points, radius }) => ({ id, time, kind, points, radius })) } });
      return { label: 'preview', matte: await loadImage(await bytes(url)) };
    }
    if (mask.result) return { label: valid ? 'analyzed' : 'last analysis (stale)', matte: await loadImage(await analyzedMatte(x.c, mask.result.key, frame)) };
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404 && !guides.length) return { label: 'not analyzed on this frame' };
    return { label: `unavailable (${error instanceof Error ? error.message : error})` };
  }
  return { label: guides.length ? 'none (add an include guide here)' : 'none' };
}

/** One line about the frame, plus the picture: source frame, 0.1 grid in full-frame coordinates, guides, matte tint. */
export async function view(x: Ctx, opts: { zoom?: unknown; matte?: boolean; width?: number; picture?: boolean }): Promise<{ text: string; content: Content[] }> {
  const { c, mask, frame } = x;
  const zoom = opts.zoom === undefined ? [0, 0, 1, 1] : opts.zoom;
  if (!Array.isArray(zoom) || zoom.length !== 4 || !zoom.every(v => typeof v === 'number' && v >= 0 && v <= 1) || zoom[2] <= zoom[0] || zoom[3] <= zoom[1]) throw new Error('zoom is [x0,y0,x1,y1] in 0–1 of the source frame, x0<x1, y0<y1.');
  const [zx0, zy0, zx1, zy1] = zoom as number[], zoomed = zx1 - zx0 < 1 || zy1 - zy0 < 1;
  const shown = opts.matte === false ? { label: 'not drawn' } : await matteFor(x, frame);
  const guides = mask ? [...mask.prompts, ...mask.repairs].filter(onFrame(x, frame)) : [];
  const status = !mask ? 'no mask yet' : !mask.result ? 'not analyzed' : mask.result.signature === smartMaskSignature(mask) ? 'analysis current' : 'analysis stale';
  const text = `${mask ? `${handle(mask.id)} "${mask.name}"` : handle(c.id)} frame ${frame} (clip ${frame - x.first + 1}/${x.last - x.first + 1}) t=${x.times[frame].toFixed(3)}s · ${guides.length} guides here · ${status} · matte ${shown.label}${shown.matte ? ` ${statText(matteStats(shown.matte))}` : ''}`;
  if (opts.picture === false) return { text, content: [] };

  const picture = await loadImage(await bytes(`/smart-masks/source?clipId=${encodeURIComponent(c.id)}&frame=${frame}${zoomed ? '' : '&size=display'}`));
  const sx = zx0 * picture.width, sy = zy0 * picture.height, sw = (zx1 - zx0) * picture.width, sh = (zy1 - zy0) * picture.height;
  const scale = Math.min(1280, Math.max(256, opts.width ?? 768)) / Math.max(sw, sh), w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  ctx.drawImage(picture, sx, sy, sw, sh, 0, 0, w, h);
  if (shown.matte) {
    // paintMatte's overlay view: teal at 45% of the matte's grey.
    const m = shown.matte, layer = createCanvas(w, h), lctx = layer.getContext('2d');
    lctx.drawImage(m, zx0 * m.width, zy0 * m.height, (zx1 - zx0) * m.width, (zy1 - zy0) * m.height, 0, 0, w, h);
    const pixels = lctx.getImageData(0, 0, w, h), d = pixels.data;
    for (let i = 0; i < d.length; i += 4) { const g = d[i]; d[i] = 0; d[i + 1] = 228; d[i + 2] = 188; d[i + 3] = g * .45; }
    lctx.putImageData(pixels, 0, 0);
    ctx.drawImage(layer, 0, 0);
  }
  const px = (v: number) => (v - zx0) / (zx1 - zx0) * w, py = (v: number) => (v - zy0) / (zy1 - zy0) * h;
  // Grid lines every .1 of the full frame (finer when zoomed), labelled along the top and left edges.
  const step = [.1, .05, .02, .01].find(s => Math.max(zx1 - zx0, zy1 - zy0) / s >= 5) ?? .01, digits = step < .1 ? 2 : 1;
  ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
  const label = (t: string, lx: number, ly: number) => { ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 3; ctx.strokeText(t, lx, ly); ctx.fillStyle = '#fff'; ctx.fillText(t, lx, ly); ctx.lineWidth = 1; };
  for (let k = Math.ceil(zx0 / step + 1e-9); k * step < zx1 - 1e-9; k++) { const gx = Math.round(px(k * step)) + .5; ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); label((k * step).toFixed(digits).replace(/^0/, ''), gx + 2, 11); }
  for (let k = Math.ceil(zy0 / step + 1e-9); k * step < zy1 - 1e-9; k++) { const gy = Math.round(py(k * step)) + .5; ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); label((k * step).toFixed(digits).replace(/^0/, ''), 2, gy - 2); }
  // Guides as the editor draws them: + include, − exclude, strokes as lines, numbered in order.
  guides.forEach((g, i) => {
    const color = COLORS[g.kind], pts = g.points.map(p => [px(p.x), py(p.y)]);
    ctx.strokeStyle = ctx.fillStyle = color;
    if (pts.length > 1) { ctx.globalAlpha = .7; ctx.lineWidth = Math.max(3, g.radius * Math.min(picture.width, picture.height) * scale * 2); ctx.lineCap = ctx.lineJoin = 'round'; ctx.beginPath(); pts.forEach(([a, b], j) => j ? ctx.lineTo(a, b) : ctx.moveTo(a, b)); ctx.stroke(); ctx.globalAlpha = 1; }
    for (const [a, b] of pts.length > 1 ? [pts[0], pts[pts.length - 1]] : pts) {
      ctx.lineWidth = 1.5; ctx.fillStyle = 'rgba(11,15,18,.6)'; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(a, b, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(a, b, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#111'; ctx.beginPath(); ctx.moveTo(a - 2.5, b); ctx.lineTo(a + 2.5, b); if (g.kind === 'include') { ctx.moveTo(a, b - 2.5); ctx.lineTo(a, b + 2.5); } ctx.stroke();
    }
    label(String(i + 1), pts[0][0] + 9, pts[0][1] - 7);
  });
  return { text, content: [image(await canvas.encode('jpeg', 80))] };
}

const point = (p: unknown) => {
  const [x, y] = Array.isArray(p) ? p : [(p as any)?.x, (p as any)?.y];
  if (!(typeof x === 'number' && typeof y === 'number' && x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new Error(`Point ${JSON.stringify(p)}: points are [x,y], each 0–1 of the source frame.`);
  return { x, y };
};
const radiusOf = (value: unknown, fallback: number) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !(value > 0 && value <= .25)) throw new Error('radius is a fraction of the short side of the frame, .002–.1 (default .012).');
  return value;
};

/** Default anchor: the inspector's range start for both ways; the first / last include guide for one way. */
function anchorOf(x: Ctx, direction: string, params: Record<string, any>) {
  const mask = x.mask!;
  if (params.frame !== undefined || params.at !== undefined) return x.times[x.frame];
  if (direction === 'both') return mask.range.start;
  const includes = mask.prompts.filter(p => p.kind === 'include' && p.time >= mask.range.start - 1 / mask.source.fps && p.time < mask.range.end).map(p => p.time);
  if (!includes.length) throw new Error(`${handle(mask.id)} has no include guide inside its range ${mask.range.start.toFixed(2)}–${mask.range.end.toFixed(2)}s.`);
  return direction === 'forward' ? Math.min(...includes) : Math.max(...includes);
}

/** Five evenly spaced analyzed frames: area and box, flagged when empty or jumping more than 2x. */
async function samples(c: Clip, key: string) {
  const manifest = await call<SmartMaskManifest>(`/smart-masks/${key}/manifest?projectId=${pid(c)}`), frames = manifest.frames, n = Math.min(5, frames.length);
  const picks = [...new Set(Array.from({ length: n }, (_, i) => frames[Math.round(i * (frames.length - 1) / Math.max(1, n - 1))]))];
  const parts: string[] = [];
  let previous: number | undefined, flagged = false;
  for (const f of picks) {
    const s = matteStats(await loadImage(await analyzedMatte(c, key, f.index)));
    const flag = !s.box ? ' !empty' : previous && (s.area > previous * 2 || s.area < previous / 2) ? ' !jump' : '';
    if (flag) flagged = true;
    parts.push(`f${f.index} ${(s.area * 100).toFixed(1)}%${flag}`);
    previous = s.area;
  }
  return `${frames.length} frames ${manifest.range.start.toFixed(2)}–${manifest.range.end.toFixed(2)}s · samples ${parts.join(' · ')}${flagged ? '\nFlagged frames: look with mask-view{frame}, add guides there with mask-guide, analyze again.' : ''}`;
}

export const jobs: Record<string, JobDef> = {
  'mask-view': {
    doc: '{clip, mask?, at?|frame?, zoom?:[x0,y0,x1,y1], matte?:true, width?:768} source frame JPEG with x,y grid, guides, matte tint + stats. help masks',
    async start(params) {
      const x = await context(params, false), { text, content } = await view(x, { zoom: params.zoom, matte: params.matte !== false, width: params.width });
      return done(text, content);
    },
  },
  'mask-guide': {
    doc: '{clip, mask?, at?|frame?, include?:[[x,y]], exclude?:[[x,y]], strokes?:[{kind,points,radius?}], radius?, replace?:true, clear?, image?:true} sets that frame\'s guides → preview matte',
    async start(params) {
      const x = await context(params, true), mask = x.mask!, time = x.times[x.frame], radius = radiusOf(params.radius, RADIUS);
      const prompts: SmartMaskPrompt[] = [], repairs: SmartMaskRepair[] = [];
      for (const kind of ['include', 'exclude'] as const) {
        if (params[kind] !== undefined && !Array.isArray(params[kind])) throw new Error(`${kind} is a list of [x,y] points.`);
        for (const p of params[kind] ?? []) prompts.push({ id: createId('stroke'), time, kind, points: [point(p)], radius });
      }
      for (const s of params.strokes ?? []) {
        if (!Array.isArray(s?.points) || !s.points.length) throw new Error('A stroke is {kind, points:[[x,y],…], radius?}.');
        const entry = { id: createId('stroke'), time, points: s.points.slice(0, 2048).map(point), radius: radiusOf(s.radius, radius) };
        if (s.kind === 'include' || s.kind === 'exclude') prompts.push({ ...entry, kind: s.kind });
        else if (Object.hasOwn(REPAIRS, s.kind)) repairs.push({ ...entry, kind: REPAIRS[s.kind as keyof typeof REPAIRS] });
        else throw new Error('Stroke kind is include, exclude, restore, remove or reset.');
      }
      // replace swaps this frame's guides (or repairs) for the new ones; clear:true first empties the frame, like its trash button.
      const clear = params.clear === true, replace = params.replace !== false, here = onFrame(x, x.frame);
      if (!prompts.length && !repairs.length && !clear) throw new Error('Give include, exclude or strokes, or clear:true to remove this frame\'s guides and repairs.');
      const merged = <T extends { time: number }>(list: T[], fresh: T[]) => [...(clear || replace && fresh.length ? list.filter(p => !here(p)) : list), ...fresh];
      const patch: Partial<SmartMaskDocument> = { prompts: merged(mask.prompts, prompts), repairs: merged(mask.repairs, repairs) };
      const ids = (list: { id: string }[]) => list.map(p => p.id).join();
      if (ids(patch.prompts!) !== ids(mask.prompts) || ids(patch.repairs!) !== ids(mask.repairs)) {
        const { text } = await edit(run => run('updateSmartMask', x.c.id, mask.id, patch));
        const now = currentMask(x);
        // updateSmartMask refuses some edits silently (a locked clip, another project open): check what was saved.
        if (!now || ids(now.prompts) !== ids(patch.prompts!) || ids(now.repairs) !== ids(patch.repairs!)) throw new Error(`The guides were not saved: ${text}`);
        x.mask = now;
      }
      const kinds = [...prompts, ...repairs].reduce<Record<string, number>>((n, p) => ({ ...n, [p.kind]: (n[p.kind] ?? 0) + 1 }), {});
      const added = [...(clear ? ['frame cleared'] : []), ...Object.entries(kinds).map(([k, n]) => `${n} ${k}`)].join(', ');
      const { text, content } = await view(x, { picture: params.image !== false, width: params.width });
      return done(`${added}${repairs.length ? ' (repairs apply at the next mask-analyze)' : ''}\n${text}`, content);
    },
  },
  'mask-analyze': {
    doc: '{clip, mask?, direction?:"both"|"forward"|"backward", at?|frame? anchor} tracks the mask through its range, saves the result → per-frame samples. Again = status',
    async start(params) {
      const x = await context(params, true), h = handle(x.mask!.id), c = x.c, maskId = x.mask!.id;
      const direction = params.direction ?? 'both';
      if (!['both', 'forward', 'backward'].includes(direction)) throw new Error('direction is both, forward or backward.');
      if (!x.mask!.prompts.some(p => p.kind === 'include')) throw new Error(`${h} has no include guide. Add one with mask-guide first.`);
      const caps = await call<SmartMaskCapabilities>('/smart-masks/capabilities');
      if (!caps.available) throw new Error(caps.reason ?? 'Smart Mask is not available on this server.');
      const anchorTime = anchorOf(x, direction, params);
      let signature = '', job: SmartMaskJob;
      // The server checks the signature against its saved copy; act saves first, so a 409 here means a save raced us.
      for (let attempt = 0; ; attempt++) {
        signature = smartMaskSignature(currentMask(x)!);
        try { job = await call<SmartMaskJob>('/smart-masks', { method: 'POST', json: { projectId: c.projectId, clipId: c.id, maskId, signature, direction, anchorTime } }); break; }
        catch (error) { if (attempt || !(error instanceof ApiFailure) || error.status !== 409 || !/saving/i.test(error.message)) throw error; await refresh(); }
      }
      const poller: Poller = {
        label: `analyze ${h}`,
        async poll() {
          if (job.status === 'queued' || job.status === 'processing') job = await call<SmartMaskJob>(`/smart-masks/${job.key}?projectId=${pid(c)}`);
          if (job.status === 'queued') return { done: false, text: `${h} queued behind other GPU work…` };
          if (job.status === 'processing') return { done: false, text: `${h} analyzing ${Math.round(job.progress)}%` };
          if (job.status !== 'ready') throw new Error(`${h} analysis ${job.status}: ${job.error ?? 'no reason given'}`);
          // Checked after edit's catch-up, so a collaborator's change during the analysis is seen (the UI's live store sees it too).
          await edit(async run => {
            const latest = currentMask(x);
            if (latest && smartMaskSignature(latest) === signature && latest.result?.key !== job.key) await run('updateSmartMask', c.id, maskId, { result: { key: job.key, signature } });
          });
          const now = currentMask(x);
          if (!now || now.result?.key !== job.key || smartMaskSignature(now) !== signature) return done(`${h} finished, but the mask changed during analysis: analyze again.`);
          let detail: string;
          try { detail = await samples(c, job.key); } catch (error) { detail = `(samples unavailable: ${error instanceof Error ? error.message : error})`; }
          return done(`${h} ready · ${detail}`);
        },
        async cancel() { await call(`/smart-masks/${job.key}?projectId=${pid(c)}`, { method: 'DELETE' }); },
      };
      return poller;
    },
  },
};

const fx = effectDefinitions['Smart Mask'];
export const topics: Record<string, string> = {
  masks: [
    'masks: Smart Mask (SAM 2.1). A mask is a document on the clip (clip.smartMasks, up to 32); a Smart Mask effect cuts it out, a grade node or a Depth effect uses it as its subject.',
    'add: act addSmartMask(clip) → mask id + a "Smart Mask" cutout effect. addSmartMask(clip, gradeNodeId) masks that node (not one with a CST); addSmartMask(clip, depthEffectId) sets the Depth subject.',
    'coordinates: x,y 0–1 of the FULL source frame, 0,0 top-left, before the clip\'s crop/flip/position/scale/grade. mask-view draws a grid in exactly these numbers (labels on top and left; finer when zoomed).',
    'frames: at = timeline seconds (the source frame shown there), frame = source frame index as mask-view prints it. Guides land on that exact frame. Default: the first include guide\'s frame, else the clip\'s middle.',
    'guide recipe: mask-view{clip} → mask-guide{clip, include:[[.48,.35]], exclude:[[.7,.4]]} → check the teal preview → mask-analyze{clip} → mask-view{frame} on a few frames.',
    'guides: 1–3 include points inside the subject, exclude points on nearby things it grabs. One click takes the largest plausible object (a shirt click = the whole person). strokes {kind:"include"|"exclude", points:[[x,y],…]} scribble along a part. No boxes; never outline a subject (the outline itself becomes subject).',
    `radius: brush as a fraction of the frame's short side, .002–.1, default ${RADIUS}. Up to 64 guides per frame preview; strokes up to 2048 points.`,
    'replace (default true) swaps that frame\'s guides (or its repairs) for the ones sent; replace:false adds. mask-guide{clip, frame, clear:true} empties the frame (guides and repairs) before adding anything sent.',
    'repairs: strokes kind restore (paint into subject) | remove (paint out) | reset (back to the estimate) fix one analyzed frame. They show after the next mask-analyze; with the same direction and anchor it only re-applies repairs (fast, no re-track).',
    'analyze: mask-analyze tracks from the frames with include guides through mask.range (both ways by default; forward/backward from the anchor: at|frame, else the first/last include guide; it must lie inside the range). Later guides correct the track. GPU jobs run one at a time; about .25 s per 4K frame, so poll. Flagged samples (!empty, !jump) = add guides on that frame, analyze again.',
    'stale: any change to guides, repairs, range or settings makes the analysis stale (mask-view says current/stale); export then fails "<name>: analyze the current mask before exporting". Changing the clip\'s input interpretation (data levels, matrix, log) also stales it ("…stale or belongs to another source"), which mask-view cannot see: mask-analyze again.',
    'rename: act updateSmartMask(clip, mask, {name:"Player"}). range (source seconds, max 600 s / 36000 frames): updateSmartMask(clip, mask, {range:{start, end}}); whole file {start:0, end:<source.duration from get{id:mask}>}. Keep it to the clip span: analysis needs about frames×width×height×4 bytes of disk.',
    'clear all guides: updateSmartMask(clip, mask, {prompts:[], repairs:[]}). See a mask\'s guides: get{id:mask, path:"prompts"}. updateSmartMask replaces whole arrays.',
    `cutout effect: updateEffect(clip, smartMaskEffectId, {amount, enabled, parameters:{${fx.parameters.filter(p => p.key !== 'amount').map(p => `${p.key}:${p.min}|${p.max}`).join(', ')}}}); remove it with updateEffect(clip, fxId, null) (the mask document stays and counts toward 32; nothing deletes a mask).`,
    'node mask: updateNode(nodeId, {mask:{id:maskId, enabled, invert, amount:0–100}}). attachSmartMask(clip, mask, effectOrNodeId) points an existing Smart Mask effect, node or Depth effect at a mask; mask "" clears a Depth subject.',
    'limits: tracked selections export fine; fine hair edges and source motion blur are not recovered (quality stays "preview"). A mask keeps its source size/fps: after a re-probe that changes them, make a new mask.',
  ].join('\n'),
};
