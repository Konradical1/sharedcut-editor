// Noise Reduction: picture denoise on the camera original, before the grade. Its settings are an effect on the clip; the
// server's denoise worker makes the editor's preview chunks (browser playback only) and the export bake, so the MCP checks
// the worker and edits the effect, and never asks for chunks.
import { call, edit, handle, need, clip, store, done, project, type JobDef, type Poller } from './kit.ts';
import { acceptsEffect, effectDefinitions, effectEnabled, initialAmount } from '../../src/services/effects.ts';
import { denoiseKeys, denoiseSettings, type DenoiseAllStatus } from '../../src/services/denoise.ts';
import type { Clip } from '../../src/state/models.ts';

const PARAMS = effectDefinitions['Noise Reduction'].parameters;
// The picture half of a linked A/V pair; its audio half points at the same video asset.
const assetOf = (c: Clip) => store.getState().tracks.find(t => t.id === c.trackId)?.kind === 'video' ? store.getState().media.find(m => m.id === c.mediaId) : undefined;
const effectOf = (c: Clip) => c.effects.find(e => e.name === 'Noise Reduction');
const summary = (c: Clip) => { const fx = effectOf(c); return fx ? Object.entries(denoiseSettings(c, fx)).map(([k, v]) => `${k} ${v}`).join(' ') : ''; };

export const jobs: Record<string, JobDef> = {
  denoise: {
    doc: `{clip, off?, ${denoiseKeys.map(k => `${k}?`).join(', ')}} adds/updates picture Noise Reduction (checks the server's denoise worker); runs on the original before the grade, export bakes it. help denoise`,
    async start(params) {
      const id = need(params, 'clip'), h = handle(id), c = clip(id), existing = effectOf(c);
      // Off always works, like the Inspector's checkbox.
      if (params.off === true) {
        if (!existing || !effectEnabled(c, existing)) return done(`Noise Reduction is already off for ${h}.`);
        return done((await edit(run => run('updateEffect', id, existing.id, { enabled: false }))).text);
      }
      const asset = assetOf(c);
      if (!existing && (!asset || !acceptsEffect(c, asset.kind, 'Noise Reduction'))) throw new Error(`Noise Reduction works on video clips only (${h} is not one).`);
      const caps = await call<{ available: boolean; reason?: string; device?: string }>('/denoise/capabilities');
      if (!caps.available) throw new Error(caps.reason ?? 'Noise Reduction is not available on this server.');
      const parameters: Record<string, number> = {};
      for (const key of denoiseKeys) if (key !== 'amount' && params[key] !== undefined) parameters[key] = key === 'frames' ? Math.round(need<number>(params, key, 'number')) : need<number>(params, key, 'number');
      const amount = params.amount === undefined ? undefined : need<number>(params, 'amount', 'number');
      const patch = { ...(existing && !effectEnabled(c, existing) ? { enabled: true } : {}), ...(amount !== undefined ? { amount } : {}), ...(Object.keys(parameters).length ? { parameters } : {}) };
      let text = '';
      // The same values again would only add an undo step.
      if (!existing || Object.keys(patch).length) text = (await edit(async run => {
        if (!existing) await run('addEffect', id, 'Noise Reduction');
        const fx = effectOf(clip(id));
        if (!fx) throw new Error(`Noise Reduction could not be added to ${h}.`);
        if (Object.keys(patch).length) await run('updateEffect', id, fx.id, patch);
      })).text + '\n';
      return done(`${text}${h} Noise Reduction (${summary(clip(id))}) · engine ${caps.device ?? 'unknown'}`);
    },
  },
};

/** `3/7 clips, 41/96 chunks` plus each failed clip. */
const progress = (r: DenoiseAllStatus) => {
  const clips = Object.entries(r.clips), chunks = clips.reduce((n, [, c]) => n + c.done, 0), total = clips.reduce((n, [, c]) => n + c.total, 0);
  const failed = clips.filter(([, c]) => c.error).map(([id, c]) => `${handle(id)} ${c.error}`);
  return `${r.status} · ${clips.filter(([, c]) => c.done === c.total).length}/${clips.length} clips, ${chunks}/${total} chunks${failed.length ? ` · failed: ${failed.join('; ')}` : ''}`;
};
jobs['denoise-all'] = {
  doc: `{${denoiseKeys.map(k => `${k}?`).join(', ')}, quality?, stop?} Noise Reduction on every video clip of the open timeline, then the server denoises all of it for playback (Denoise page). help denoise`,
  async start(params): Promise<Poller | ReturnType<typeof done>> {
    const p = project(), path = `/denoise/all?projectId=${encodeURIComponent(p.id)}`;
    if (params.stop === true) return done(`Denoise all stopped: ${progress(await call<DenoiseAllStatus>(path, { method: 'DELETE' }))}`);
    const caps = await call<{ available: boolean; reason?: string }>('/denoise/capabilities');
    if (!caps.available) throw new Error(caps.reason ?? 'Noise Reduction is not available on this server.');
    // Unset settings keep the timeline's first Noise Reduction, else the defaults.
    const s = store.getState(), first = s.clips.find(c => c.timelineId === s.timelineId && effectOf(c)), base = first ? denoiseSettings(first, effectOf(first)!) : Object.fromEntries(PARAMS.map(q => [q.key, q.key === 'amount' ? initialAmount('Noise Reduction') : q.initial]));
    const settings = Object.fromEntries(denoiseKeys.map(k => [k, params[k] === undefined ? base[k] : k === 'frames' ? Math.round(need<number>(params, k, 'number')) : need<number>(params, k, 'number')])) as Record<typeof denoiseKeys[number], number>;
    const { text, value: count } = await edit(run => run('denoiseAll', settings) as Promise<number>);
    if (!count) throw new Error('No video clip on this timeline could take Noise Reduction (locked tracks and audio are skipped).');
    const quality = params.quality === undefined ? 'Stream' : need(params, 'quality');
    await call(`/denoise/all`, { method: 'POST', json: { projectId: p.id, timelineId: s.timelineId, quality } });
    return { label: 'denoise all', poll: async () => { const r = await call<DenoiseAllStatus>(path); return { done: r.status !== 'running', text: `${text}\nDenoise all ${quality}: ${progress(r)}` }; }, cancel: async () => { await call(path, { method: 'DELETE' }); } };
  },
};

export const topics: Record<string, string> = {
  denoise: [
    'denoise: picture Noise Reduction (job denoise). It measures each source\'s own noise, aligns neighbouring frames with motion, then cleans spatially what they could not; it runs on the camera original before the grade, whatever its place in the effect stack.',
    `Settings: ${PARAMS.map(p => `${p.key}${p.key === 'amount' ? ` (${p.label})` : ''} ${p.key === 'amount' ? initialAmount('Noise Reduction') : p.initial} (${p.min}–${p.max}${p.suffix?.trim() ?? ''})`).join(', ')}. amount 50 removes the measured noise, 100 is aggressive, 0 bypasses. chroma = colour noise. frames = neighbours each side (0 = spatial only). detail gives fine texture back.`,
    'One per clip, video only; keyframes on its settings are refused by export. Remove: act updateEffect(clip, fxId, null). Off: job denoise{clip, off:true}.',
    'frame{} cannot render a Noise Reduction clip alone (it bakes whole clips) and shows its ungraded source instead; the editor previews the real result and Export bakes it (minutes per clip), before Stabilize, Smart Mask, Depth and optical flow.',
    'Denoise all (job denoise-all, the Denoise page): one set of settings on every video clip of the open timeline, then the server denoises every chunk they show at one quality (Stream default; Full, 1/4) so playback is clean everywhere; it keeps going without the editor open. stop:true stops it.',
    'Sound: picture only. Audio Noise Reduction is a separate audio effect (help audio).',
  ].join('\n'),
};
