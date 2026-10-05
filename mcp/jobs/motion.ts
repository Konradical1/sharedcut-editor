// Motion: Stabilize's camera analysis and the optical-flow switch. Speed, reverse, freeze, ramps and motion blur are
// plain store edits (act); the "motion" help topic has their keys, ranges and recipes.
//
// Neither feature stores a result on the clip. POST /api/stabilize warms the analysis + solve cache that export reuses
// (data/stabilize) and reports the zoom; optical-flow preview chunks only feed browser playback (export bakes its own
// from the original), so the MCP never requests them.
import { call, ApiFailure, refresh, edit, handle, need, clip, store, done, type JobDef, type Poller } from './kit.ts';
import { acceptsEffect, effectDefinitions, effectEnabled, initialAmount } from '../../src/services/effects.ts';
import { stabilizeEffect, stabilizeKeys, stabilizeRange, stabilizeSettings, type StabilizePreview } from '../../src/services/stabilize.ts';
import { timingPaths } from '../../src/services/opticalFlow.ts';
import { boundedAnimationValue } from '../../src/services/animation.ts';
import { activeSmartMasks } from '../../src/services/smartMaskPreview.ts';
import { activeDepthKeys } from '../../src/services/smartMask.ts';
import { defaultProperties } from '../../src/state/demo.ts';
import type { Clip } from '../../src/state/models.ts';

const STAB = effectDefinitions.Stabilize.parameters;
const range = (path: string) => `${boundedAnimationValue(path, -1e9)}–${boundedAnimationValue(path, 1e9)}`;
// The picture half of a linked A/V pair; its audio half points at the same video asset.
const assetOf = (c: Clip) => store.getState().tracks.find(t => t.id === c.trackId)?.kind === 'video' ? store.getState().media.find(m => m.id === c.mediaId) : undefined;
const stabilizeOf = (c: Clip) => stabilizeEffect(c) ?? c.effects.find(e => e.name === 'Stabilize');

/** What export refuses on one clip (server/media.ts renderStabilizedTimeline / renderFlowTimeline / Depth). */
function clash(c: Clip, adding: 'flow' | 'stabilize'): string | undefined {
  const nodes = store.getState().nodes, fix = `act updateProperty("${handle(c.id)}","opticalFlow",false)`;
  if (adding === 'stabilize') {
    if (c.properties.opticalFlow) return `Optical flow is on for ${handle(c.id)}; export cannot combine it with Stabilize. Turn it off first: ${fix}.`;
    if (activeDepthKeys(c, nodes).length) return `${handle(c.id)} has a depth key; export cannot combine it with Stabilize yet.`;
    return;
  }
  if (stabilizeEffect(c)) return `Stabilize is on for ${handle(c.id)}; export cannot combine it with optical flow. Remove or disable Stabilize first.`;
  if (activeSmartMasks(c, nodes).length) return `${handle(c.id)} has an active Smart Mask; export cannot retime it with optical flow.`;
  if (activeDepthKeys(c, nodes).length) return `${handle(c.id)} has a depth key; export cannot retime it with optical flow.`;
  if (c.effects.some(e => e.name === 'Depth' && effectEnabled(c, e))) return `${handle(c.id)} has Depth; export cannot combine it with optical flow.`;
}

const zoomText = (r: StabilizePreview) => r.zoom ? `zoom ${r.zoomMin && r.zoomMin < r.zoom - .0005 ? `${((r.zoomMin - 1) * 100).toFixed(1)}–` : ''}${((r.zoom - 1) * 100).toFixed(1)}%` : '';

export const jobs: Record<string, JobDef> = {
  stabilize: {
    doc: `{clip, ${STAB.map(p => `${p.key}?`).join(', ')}} adds/updates Stabilize, runs its camera analysis → zoom %. Again = status. help motion`,
    async start(params) {
      const id = need(params, 'clip'), h = handle(id);
      let c = clip(id);
      const asset = assetOf(c);
      if (!asset || !acceptsEffect(c, asset.kind, 'Stabilize')) throw new Error(`Stabilize works on video clips only (${h} is not one).`);
      const blocked = clash(c, 'stabilize'); if (blocked) throw new Error(blocked);
      const caps = await call<{ available: boolean; reason?: string }>('/stabilize/capabilities');
      if (!caps.available) throw new Error(caps.reason ?? 'Stabilize is not available on this server.');
      const parameters: Record<string, number> = {};
      for (const key of stabilizeKeys) if (key !== 'amount' && params[key] !== undefined) parameters[key] = key === 'lock' ? Number(params.lock === true || Number(params.lock) >= .5) : need<number>(params, key, 'number');
      const amount = params.amount === undefined ? undefined : need<number>(params, 'amount', 'number');
      const existing = stabilizeOf(c);
      const patch = { ...(existing && !effectEnabled(c, existing) ? { enabled: true } : {}), ...(amount !== undefined ? { amount } : {}), ...(Object.keys(parameters).length ? { parameters } : {}) };
      let changed = '';
      if (!existing || Object.keys(patch).length) {
        changed = (await edit(async run => {
          if (!existing) await run('addEffect', id, 'Stabilize');
          const fx = stabilizeOf(clip(id));
          if (!fx) throw new Error(`Stabilize could not be added to ${h}.`);
          if (Object.keys(patch).length) await run('updateEffect', id, fx.id, patch);
        })).text + '\n';
        c = clip(id);
      }
      const fx = stabilizeEffect(c);
      if (!fx) return done(`${changed}Stabilize is off on ${h} (Strength 0). Raise it: job stabilize{clip, amount}.`);
      const fps = asset.fps || store.getState().projects.find(p => p.id === c.projectId)?.fps || 24;
      // The server answers a bad speed curve with a bare 500; say why here.
      stabilizeRange(c, fps, asset.duration || Infinity);
      let key = '';
      const poller: Poller = {
        label: `stabilize ${h}`,
        async poll() {
          // Follow the clip as it is now: a settings edit since the start is a new analysis, like the editor's.
          const now = store.getState().clips.find(x => x.id === id), current = now && stabilizeEffect(now);
          if (!now || !current) return done(`Stabilize is no longer on ${h}.`);
          const settings = stabilizeSettings(now, current);
          let r: StabilizePreview;
          try { r = await call<StabilizePreview>('/stabilize', { method: 'POST', json: { clipId: id, fps, settings } }); }
          catch (error) {
            if (!(error instanceof ApiFailure) || ![409, 429].includes(error.status) || /missing/i.test(error.message)) throw error;
            if (error.status === 409) await refresh();
            return { done: false, text: `${h} stabilize: ${error.status === 429 ? 'server queue full, waiting' : 'settings still saving'}…` };
          }
          key = r.key;
          if (r.status === 'failed') throw new Error(`Stabilize failed on ${h}: ${r.error ?? 'unknown error'}`);
          if (r.status === 'ready') return done(`${changed}${h} stabilized (${stabilizeKeys.map(k => `${k} ${settings[k]}`).join(' ')})${r.zoom ? ` · ${zoomText(r)}` : ''}`);
          return { done: false, text: `${changed}${h} analyzing camera motion ${r.progress}%` };
        },
        async cancel() { if (key) await call(`/stabilize/${key}?projectId=${encodeURIComponent(c.projectId)}`, { method: 'DELETE' }); },
      };
      return poller;
    },
  },
  flow: {
    doc: '{clip, off?} optical-flow retiming on (checks the server can) or off; export bakes it',
    async start(params) {
      const id = need(params, 'clip'), on = params.off !== true, c = clip(id);
      // Off always works, like the Inspector's checkbox.
      if (on && assetOf(c)?.kind !== 'video') throw new Error(`Optical flow works on video clips only (${handle(id)} is not one).`);
      const blocked = on && clash(c, 'flow'); if (blocked) throw new Error(blocked);
      // The same value again would only add an undo step.
      if (Boolean(c.properties.opticalFlow) === on) return done(`Optical flow is already ${on ? 'on' : 'off'} for ${handle(id)}.`);
      let engine = '';
      if (on) {
        const caps = await call<{ available: boolean; engine?: string; error?: string }>('/optical-flow/capabilities');
        if (!caps.available) throw new Error(caps.error ?? 'Optical flow is not available on this server.');
        engine = `\nflow engine: ${caps.engine}`;
      }
      return done((await edit(run => run('updateProperty', id, 'opticalFlow', on))).text + engine);
    },
  },
};

export const topics: Record<string, string> = {
  motion: [
    'motion: speed, reverse, freeze, ramps, optical flow, motion blur, Stabilize. All live on the clip; act unless a job is named.',
    `speed: act updateProperty(clip,"speed",%) ${range('properties.speed')}, default ${defaultProperties.speed}. 50 = half speed: the clip gets longer but stops at the next clip on its track (then less footage plays). Linked A/V clips follow.`,
    'reverse / freeze: updateProperty(clip,"reverse"|"freeze",true|false). Length unchanged.',
    `ramp channels: ${timingPaths.join(', ')}. setKeyframes(clip, channel, keys) recomputes the length and copies to linked clips; [] removes the ramp.`,
    'ramp recipe: act setKeyframes(clip,"properties.speed",[{id:"k1",time:0,value:100,interpolation:"linear"},{id:"k2",time:1.5,value:25,interpolation:"bezier",curve:[.4,0,.2,1]},{id:"k3",time:3,value:25,interpolation:"linear"}]).',
    'keys: time = seconds from the clip start, strictly increasing; ids unique strings; interpolation linear|hold|bezier shapes the segment AFTER that key; curve [x1,y1,x2,y2], x in 0–1. reverse/freeze keys are true/false with "hold".',
    'Once speed is keyframed, updateProperty(clip,"speed",v) sets a key at the playhead instead: act{at:<timeline s>, do:[["updateProperty",clip,"speed",40]]}. keyframeProperty(clip,"properties.speed") keys the current value at the playhead.',
    'optical flow: job flow{clip} (checks the server first) / job flow{clip,off:true}. Smooth in-between frames for slow motion and ramps. Export bakes it from the original (slow, minutes per clip). Not with Stabilize, Smart Mask, a depth key or Depth on the same clip.',
    `motion blur: updateProperty(clip,"motionBlur",true); "motionBlurStrength" ${range('properties.motionBlurStrength')} (default 50 = half-frame shutter); "motionBlurSamples" 16|32|64 (default 32). A value outside these ranges (samples ${range('properties.motionBlurSamples')}) makes the server refuse the save. Not keyframable.`,
    'motion blur only smears keyframed properties.x / y / zoom, text.x / y, shape.x / y / width / height. No such keys = no blur.',
    `Stabilize: job stabilize{clip} adds it (Strength ${initialAmount('Stabilize')}) and runs the analysis; pass settings to change them, then it re-solves. Settings: ${STAB.map(p => `${p.key}${p.key === 'amount' ? ` (${p.label})` : ''} ${p.key === 'amount' ? initialAmount('Stabilize') : p.initial} (${p.min}–${p.max}${p.suffix?.trim() ?? ''})`).join(', ')}. lock 1 = tripod.`,
    'Stabilize values are read at the clip start; keyframes on them are ignored. Disabled or Strength 0 = off. Remove: act updateEffect(clip, fxId, null). Analysis runs on the original, once, cached; export reuses it. A failed analysis is answered again until nobody asks for 10 s; changing a setting starts a fresh one.',
  ].join('\n'),
};
