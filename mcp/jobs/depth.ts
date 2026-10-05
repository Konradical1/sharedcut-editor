// Depth: the clip's depth analysis (start or join, then wait) and a headless focus picker. Adding the Depth effect,
// its presets and parameters, subjects and depth keys on grade nodes are plain store edits (act); the "depth" help
// topic has their keys and the exact recipes.
//
// Nothing is saved for a run: POST /api/depth reads the saved clip and binds its run to it on the server, and every
// export of the clip reads (and waits for) that run on its own. The editor's run logic (ensureDepthRun) does the
// posting, polling and re-asking here exactly as in the browser; this module only drives and reports it.
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { call, edit, handle, need, clip, media, store, done, bytes, ApiFailure, type JobDef, type Poller } from './kit.ts';
import { clock, secs } from '../views.ts';
import { depthClipReady, depthState, ensureDepthRun, retryDepth, type DepthClipState } from '../../src/services/depthPreview.ts';
import { depthDistance, depthFrameAt, depthPresets, depthSegmentFor, type DepthCapabilities } from '../../src/services/depth.ts';
import { effectDefinitions } from '../../src/services/effects.ts';
import { isDepthKey } from '../../src/services/smartMask.ts';
import { timelineTransitions } from '../../src/services/transitions.ts';
import { clipSourceTime } from '../../src/services/motionTracker.ts';

const exec = promisify(execFile);
const PARAMS = effectDefinitions.Depth.parameters;
// A run someone else cancelled is not over: the editor's loop asks the server again at once (asking).
const over = (s: DepthClipState) => s.status === 'failed' || s.status === 'cancelled' && !s.asking;

/** Start or keep the clip's run, as the editor's timeline does for every Depth clip (watchDepthClips), and return its state. */
function track(id: string, retry = false) {
  const s = store.getState(), c = clip(id), asset = s.media.find(m => m.id === c.mediaId), h = handle(id);
  if (!asset || !['video', 'image'].includes(asset.kind)) throw new Error(`Depth works on video and image clips (${h} is not one).`);
  if (asset.status !== 'ready') throw new Error(`${h}'s media is ${asset.status}; depth starts once it is ready.`);
  // The transitions it takes part in, relative to its start: the run covers their handles (as depthPreview.ts does).
  const handles = timelineTransitions(s.clips.filter(x => x.projectId === c.projectId), c.timelineId, s.media)
    .filter(r => r.outgoingId === id || r.incomingId === id).map(r => [r.start - c.start, r.end - c.start] as [number, number]);
  const current = depthState(id);
  // A watch a job cancel stopped is started again; `retry` (a new job) also asks a failed run again, like the inspector's Retry.
  return current && (current.controller.signal.aborted || retry && over(current)) ? retryDepth(c, asset) : ensureDepthRun(c, asset, handles)!;
}

export const jobs: Record<string, JobDef> = {
  depth: {
    doc: '{clip} starts/joins the clip\'s depth analysis and waits → ready or %; again retries a failure. help depth',
    async start(params) {
      const id = need(params, 'clip'), h = handle(id), c = clip(id);
      if (!c.effects.some(e => e.name === 'Depth') && !store.getState().nodes.some(n => n.clipId === id && isDepthKey(n.mask)))
        throw new Error(`${h} has no Depth effect or depth key to analyze for. act addEffect("${h}","Depth") first (help depth).`);
      // A failed check (a dropped connection, a tunnel timeout on the first torch import) says nothing; the run's own status will.
      const caps = await call<DepthCapabilities>('/depth/capabilities').catch(() => undefined);
      if (caps?.available === false) throw new Error(caps.reason ?? 'Depth analysis is not available on this server.');
      let state = track(id, true), retries = 0;
      const poller: Poller = {
        label: `depth ${h}`,
        async poll() {
          // Follow the clip as it is now: a trim or speed change since the start asks the server for the new range.
          if (!store.getState().clips.some(x => x.id === id)) return done(`${h} is gone.`);
          state = track(id);
          const run = state.run;
          if (over(state)) {
            // The tunnel times out (524) on a slow first request; the request is idempotent, so ask again.
            if (/\(52\d\)/.test(state.error ?? '') && retries++ < 3) { state = retryDepth(state.clip, state.asset); return { done: false, text: `${h} depth: retrying after a gateway timeout` }; }
            throw new Error(`Depth failed on ${h}: ${(state.error ?? state.status).replace(/\s*Click Retry\.?$/, '').replace(/\.$/, '')}. job depth{clip:"${h}"} again retries.`);
          }
          if (state.status === 'ready' && run) {
            const t = run.telemetry;
            return done(`${h} depth ready · ${run.frames}f ${run.width}x${run.height}${t?.analysisFps ? ` · ${Math.round(t.analysisFps)}fps${t.device ? ` ${t.device}` : ''}` : ''}`);
          }
          const ready = run && depthClipReady(state.clip, run);
          const text = state.status === 'queued' ? 'queued (behind other GPU work)' : state.status === 'processing' ? `${Math.round(state.progress)}%${ready ? ` · ready to ${clock(ready)}` : ''}` : 'starting';
          return { done: false, text: `${h} depth ${text}${state.error ? ` (${state.error})` : ''}` };
        },
        async cancel() {
          // Stop watching first: the editor's loop asks again for a run someone else cancelled.
          const live = depthState(id) ?? state;
          live.controller.abort('keep');
          const key = live.run?.key;
          if (!key || !['queued', 'processing'].includes(live.status)) return;
          // A split sibling still reads the same run.
          if (store.getState().clips.some(x => x.id !== id && depthState(x.id)?.run?.key === key && !depthState(x.id)!.controller.signal.aborted)) return;
          // A viewer may only stop watching: the run is an editor's.
          await call(`/depth/${key}?projectId=${encodeURIComponent(live.projectId)}`, { method: 'DELETE' }).catch(error => { if (!(error instanceof ApiFailure && error.status === 403)) throw error; });
        },
      };
      return poller;
    },
  },
  'depth-probe': {
    doc: '{clip, x, y (0–1 of the frame), at? (timeline s, default playhead), focus?} → distance 0 near–100 far there; focus:true sets Depth Focus to it',
    async start(params) {
      const id = need(params, 'clip'), x = need<number>(params, 'x', 'number'), y = need<number>(params, 'y', 'number'), h = handle(id), c = clip(id);
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new Error('x and y are fractions of the frame: 0 (left/top) to 1.');
      const state = depthState(id), run = state?.run;
      if (!state || !run?.times.length) throw new Error(`No depth analysis for ${h} here yet: job depth{clip:"${h}"} first.`);
      const t = params.at === undefined ? store.getState().playhead : need<number>(params, 'at', 'number');
      if (t < c.start || t >= c.start + c.duration) throw new Error(`${h} plays ${secs(c.start)}–${secs(c.start + c.duration)} s, not at ${secs(t)} s. Pass at.`);
      const at = depthSegmentFor(run, depthFrameAt(run, clipSourceTime(c, t, media(c.mediaId))));
      if (!at) throw new Error(state.status === 'ready' ? `${secs(t)} s of ${h} is outside its depth analysis (changed since?): job depth{clip:"${h}"} again.` : `Depth for ${h} at ${secs(t)} s is not analyzed yet (${state.status} ${Math.round(state.progress)}%).`);
      // The preview segment the viewer decodes: full-range luma = stored depth, at the run's size (scripts/depth.py).
      const file = join(tmpdir(), `sharedcut-depth-${process.pid}-${run.key.slice(0, 12)}-${at.segment.n}.mp4`);
      let gray: Buffer;
      try {
        const segment = await bytes(`/depth/${run.key}/preview/${at.segment.n}.mp4?projectId=${encodeURIComponent(c.projectId)}`).catch(error => {
          // The server evicted the run (or lost it): analyze it again, as the viewer does on a missing segment.
          if (error instanceof ApiFailure && error.status === 404 && state.status === 'ready') { retryDepth(state.clip, state.asset); throw new Error(`The depth analysis of ${h} is gone from the server; it is running again: job depth{clip:"${h}"} waits for it.`); }
          throw error;
        });
        await writeFile(file, segment);
        // The frame number goes in as a value, not a path, so no filterPath escaping is needed (only the comma).
        gray = (await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${at.offset})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 64 << 20 })).stdout;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`depth-probe needs ffmpeg on this machine (FFMPEG_PATH). Set Focus as a number instead: act updateEffect("${h}", fx, {parameters:{focus:0–100}}).`);
        throw error;
      } finally { await rm(file, { force: true }); }
      if (gray.length < run.width * run.height) throw new Error(`The depth frame for ${h} did not decode.`);
      const px = Math.min(run.width - 1, Math.floor(x * run.width)), py = Math.min(run.height - 1, Math.floor(y * run.height));
      const distance = Math.round(depthDistance(run, gray[py * run.width + px] / 255));
      const text = `${h} distance ${distance} at (${x}, ${y}) t=${secs(t)}s`;
      if (params.focus !== true) return done(text);
      const fx = c.effects.find(e => e.name === 'Depth');
      if (!fx) return done(`${text} · no Depth effect to focus`);
      // As the viewer's picker: at the probed time, so a keyframed Focus gets its key there.
      return done(`${(await edit(async run => { if (params.at !== undefined) store.getState().setPlayhead(t); await run('updateEffect', id, fx.id, { parameters: { focus: distance } }); })).text}\n${text} · focus set`);
    },
  },
};

const json = (value: unknown) => JSON.stringify(value);
const param = (p: (typeof PARAMS)[number]) => `${p.key}=${p.initial}${p.min === 0 && p.max === 100 ? '' : ` ${p.min}–${p.max}`}${p.step && p.step !== 1 ? ` step ${p.step}` : ''}${p.label.replace(/\s/g, '').toLowerCase().startsWith(p.key.toLowerCase()) ? '' : ` (${p.label})`}`;
// The first key of each inspector section (DepthInspector.tsx) switches it on; export uses the same rule.
const SECTIONS = ['blur', 'fog', 'glow', 'light'];

export const topics: Record<string, string> = {
  depth: [
    'depth: the Depth effect (AI depth map: lens blur, fog, glow, background light), its analysis, subjects and depth keys on grade nodes. act unless a job is named.',
    'add: act addEffect(clip,"Depth"): video or image clips only (not titles, shapes, adjustment, compositions, captions), one per clip. The timeline line shows its id as fx Depth@….',
    'set: act updateEffect(clip,fx,{amount, enabled, parameters:{key:value}}). amount = Mix 0–100 (starts at 100), never inside parameters. One unknown key or non-number drops the whole patch; values clamp.',
    `keys (key=default, range 0–100 unless shown): ${PARAMS.filter(p => p.key !== 'amount').map(param).join(', ')}`,
    `sections: each does nothing until its first key (${SECTIONS.join(', ')}) is above 0. Mix 0, or all four at 0, is no effect and export skips it. followSubject is 0|1.`,
    'distances: 0 = the nearest point of the shot, 100 = the farthest, scaled per clip analysis. focus, fogStart, glowStart, lightStart, depth-key near/far are distances.',
    'presets (the inspector buttons): act updateEffect(clip,fx,{amount:100, parameters:{every key but focus/followSubject at its default, then the values below}}). Focus and followSubject stay; the inspector also focuses on the frame centre when blur>0 and Focus was never set: job depth-probe{clip,x:.5,y:.5,focus:true}.',
    ...depthPresets.map(p => `  ${p.name}: ${p.description} ${json(p.values)}`),
    'focus: headless there is no auto-centre and no viewer picker; Focus stays 30 until you set parameters.focus, or job depth-probe{clip,x,y,focus:true} reads the distance at a point and sets it.',
    'analysis: job depth{clip} starts or joins the clip\'s run and waits (queued → % → ready). Editors start runs, viewers only join. Nothing to save: the server binds the run to the saved clip, and export waits for it itself ("Waiting for depth analysis · N%"). After a trim, speed or input-profile change, job depth again shows the new run.',
    'subject (video): act addSmartMask(clip,fx) → mask id, then draw and analyze it with the Smart Mask jobs (help masks). attachSmartMask(clip,maskId,fx) picks one, "" clears. Lens blur keeps it sharp; followSubject 1 makes Focus track it (Focus keyframes ignored). Export with Lens blur fails unless the subject is analyzed and current.',
    `depth key (Color page "Depth Key"): act updateNode(node,{mask:${json({ source: 'depth', enabled: true, invert: false, amount: 100, near: 50, far: 100, softness: 10 })}}) grades only distances near..far, easing out over softness; amount = node influence. Always send all 7 keys, each 0–100, near <= far ("Invalid depth key." otherwise). Remove: updateNode(node,{mask:null}). Replaces a Smart Mask on the node; refused while the node has an enabled color-space transform. Then job depth{clip}.`,
    'keyframes: effects.<fx>.amount, effects.<fx>.parameters.<key>. Once a key is keyframed, updateEffect writes a keyframe at the playhead: act{at:<timeline s>, do:[…]}.',
    'export refuses: Depth with optical flow; a depth key with Stabilize or optical flow, or on an adjustment clip; a variable-frame-rate source; a picture over 4096 px or with an odd size; keyframed grades or effects above Depth; Depth keyframes on a still. depth-probe ignores a Stabilize warp.',
  ].join('\n'),
};
