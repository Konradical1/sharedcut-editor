// Noise Reduction: picture denoise on the camera original, before the grade. Its settings are an effect on the clip; the
// server's denoise worker makes the editor's preview chunks (browser playback only) and the export bake, so the MCP checks
// the worker and edits the effect, and never asks for chunks.
import { call, edit, handle, need, clip, store, done, type JobDef } from './kit.ts';
import { acceptsEffect, effectDefinitions, effectEnabled, initialAmount } from '../../src/services/effects.ts';
import { denoiseKeys, denoiseSettings } from '../../src/services/denoise.ts';
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

export const topics: Record<string, string> = {
  denoise: [
    'denoise: picture Noise Reduction (job denoise). It measures each source\'s own noise, aligns neighbouring frames with motion, then cleans spatially what they could not; it runs on the camera original before the grade, whatever its place in the effect stack.',
    `Settings: ${PARAMS.map(p => `${p.key}${p.key === 'amount' ? ` (${p.label})` : ''} ${p.key === 'amount' ? initialAmount('Noise Reduction') : p.initial} (${p.min}–${p.max}${p.suffix?.trim() ?? ''})`).join(', ')}. amount 50 removes the measured noise, 100 is aggressive, 0 bypasses. chroma = colour noise. frames = neighbours each side (0 = spatial only). detail gives fine texture back.`,
    'One per clip, video only; keyframes on its settings are refused by export. Remove: act updateEffect(clip, fxId, null). Off: job denoise{clip, off:true}.',
    'frame{} cannot render a Noise Reduction clip alone (it bakes whole clips) and shows its ungraded source instead; the editor previews the real result and Export bakes it (minutes per clip), before Stabilize, Smart Mask, Depth and optical flow.',
    'Sound: picture only. Audio Noise Reduction is a separate audio effect (help audio).',
  ].join('\n'),
};
