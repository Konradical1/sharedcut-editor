// Color: the Color Assistant (a server job), 3D LUT import (a local .cube file) and a compact grade view. Grading itself
// is plain store edits (act); the "color" help topic has the node model, parameters, curve/CST/LUT/mask formats and
// the act recipes, generated from the app's own definitions where they are importable.
import { appFile } from '../env.ts';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { edit, handle, need, clip as clipOf, project, store, done, bytes, image, type Content, type JobDef, type Poller, type Step } from './kit.ts';
import { profiles, gamuts, primaryDefaults, rangeDefaults, parseCube, processingStages, interpretation, acesOutputUpgrade } from '../../src/services/color.ts';
import { eligibility, neutralLook, type LookValues } from '../../src/services/colorAssistant.ts';
import { assistantCapabilities, startAssistant, assistantJob, latestAssistantJob, cancelAssistant, type AssistantJob } from '../../src/services/colorAssistantClient.ts';
import { colorGroups, colorGroupOf, type AutoBalance, type NormalizeShot } from '../../src/services/colorGroups.ts';
import { startNormalize, normalizeJob, cancelNormalize, type NormalizeJob } from '../../src/services/colorNormalizeClient.ts';
import { createId } from '../../src/services/index.ts';
import { isDepthKey } from '../../src/services/smartMask.ts';
import { evaluateNodes } from '../../src/services/animation.ts';
import type { Clip, ColorEffect, ColorLutEffect, GradeNode } from '../../src/state/models.ts';

const num = (v: number) => String(Math.round(v * 1000) / 1000);
const quote = (text: string, max = 60) => JSON.stringify(text.length > max ? text.slice(0, max - 1) + '…' : text);
const assetOf = (c: Clip) => store.getState().media.find(m => m.id === c.mediaId);
const nodesOf = (c: Clip) => store.getState().nodes.filter(n => n.clipId === c.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
function gradeNode(id: string): GradeNode {
  const node = store.getState().nodes.find(n => n.id === id && n.projectId === store.getState().projectId);
  if (!node) throw new Error(`No grade node ${handle(id)}. job color-grade{clip} lists a clip's nodes.`);
  return node;
}

// ---- The grade view -------------------------------------------------------------------------------------------------

const fxText = (e: ColorEffect) => e.type === 'cst'
  ? `[cst ${e.inputGamma}/${e.inputGamut}→${e.outputGamma}/${e.outputGamut}${e.toneMapping !== 'none' ? ` ${e.toneMapping}` : ''}${e.gamutMapping !== 'none' ? ` ${e.gamutMapping}` : ''}${e.enabled ? '' : ' off'} ${handle(e.id)}]`
  : `[lut ${quote(e.name, 30)} ${e.cube.size}³ amount ${num(e.amount)} expects ${e.inputGamma}/${e.inputGamut}${e.enabled ? '' : ' off'} ${handle(e.id)}]`;
function nodeLine(node: GradeNode, c: Clip, managed: boolean) {
  const keyed = (field: string) => c.keyframes?.[`nodes.${node.id}.${field}`]?.length ? '~' : '';
  const defaults: Record<string, number> = { ...primaryDefaults, ...rangeDefaults, pivot: managed ? primaryDefaults.pivot : .5, curve25: .25, curve50: .5, curve75: .75 };
  const params = Object.entries(node.parameters).filter(([k, v]) => v !== (defaults[k] ?? defaults[k.toLowerCase()] ?? 0) || keyed(`parameters.${k}`)).map(([k, v]) => `${k}=${num(v)}${keyed(`parameters.${k}`)}`);
  const m = node.mask, mask = !m ? '' : `mask ${isDepthKey(m) ? `depth ${m.near}-${m.far} soft ${m.softness}` : `smart ${handle(m.id)}`}${m.invert ? ' inverted' : ''}${m.amount !== 100 ? ` ${m.amount}%` : ''}${m.enabled ? '' : ' off'}`;
  const curves = node.curves && Object.keys(node.curves).length ? `curves ${Object.entries(node.curves).map(([ch, cv]) => `${ch}${cv!.points.length}`).join(',')}${keyed('curves')}` : '';
  return [`${handle(node.id)} ${quote(node.name, 30)}${node.enabled ? '' : ' (off)'}${keyed('enabled')}`, node.group ? `[group ${node.group}]` : '', ...params, curves, ...(node.effects ?? []).map(fxText), mask].filter(Boolean).join(' ');
}
/** One clip's grade for the model: nodes in processing order with what differs from the defaults, plus what would break. */
export function gradeText(c: Clip, at?: number) {
  const s = store.getState(), asset = assetOf(c), managed = c.properties.colorPipeline === 'nodes-v2', stored = nodesOf(c);
  const animated = Object.keys(c.keyframes ?? {}).some(path => path.startsWith('nodes.'));
  const time = at !== undefined ? at : s.playhead >= c.start && s.playhead < c.start + c.duration ? s.playhead : c.start + c.duration / 2;
  const nodes = evaluateNodes(stored, c, time);
  let source = '?';
  try { const { profile, gamut } = interpretation(c, asset); source = `${profile}/${gamut}${asset?.inputProfile ? '' : ' (unverified)'}`; } catch (error) { source = `invalid: ${(error as Error).message}`; }
  const lines = [`${handle(c.id)} ${quote(c.name, 40)} ${managed ? 'nodes-v2' : 'legacy'} · source ${source} · ${nodes.length} node${nodes.length === 1 ? '' : 's'}${animated ? ` · values at ${num(time)}s (~ = keyframed; act at:${num(time)} writes there)` : ''}`];
  nodes.forEach((node, i) => lines.push(`${i + 1} ${nodeLine(node, c, managed)}`));
  // What preview and export will run: unknown keys, out-of-range values and broken ACES chains throw here.
  try {
    const src = interpretation(c, asset);
    processingStages(managed ? { ...c, properties: { ...c.properties, inputProfile: src.profile, inputGamut: src.gamut } } : c, nodes);
    lines.push('render check: ok');
  } catch (error) { lines.push(`render check FAILED: ${(error as Error).message}`); }
  const verdict = eligibility(c, asset, s.nodes);
  lines.push(`assistant: ${verdict.ok ? 'ready' : `no, ${verdict.text}`}`);
  if (!managed && !nodes.length) lines.push(`start: act{do:[["initializeColorGrade","${handle(c.id)}"]]}`);
  if (acesOutputUpgrade(c, s.nodes)) lines.push(`highlights clip at the output: act{do:[["useAcesOutput","${handle(c.id)}"]]} switches it to ACES 2`);
  if (c.properties.resolveLookUrl) lines.push(managed ? 'an imported DaVinci look is replaced by these nodes; restoreResolveGrade(clip) brings it back' : `imported DaVinci look ${c.properties.bypassResolveLook === true ? 'bypassed' : 'applied before the nodes'} (updateProperty bypassResolveLook)`);
  return lines.join('\n');
}

// ---- 3D LUTs --------------------------------------------------------------------------------------------------------

const MAX_LUT_FILE = 32 * 1024 * 1024, MAX_SAVE = 18 * 1024 * 1024;
async function loadLut(file: string, p: Record<string, any>, managed: boolean): Promise<ColorLutEffect> {
  if (!isAbsolute(file)) throw new Error('params.file must be an absolute path to a .cube file.');
  if ((await stat(file)).size > MAX_LUT_FILE) throw new Error('Use a LUT smaller than 32 MB.');
  const cube = parseCube(await readFile(file, 'utf8'));
  const inputGamma = p.inputGamma ?? (managed ? 'DaVinci Intermediate' : 'Gamma 2.4'), inputGamut = p.inputGamut ?? (managed ? 'DaVinci Wide Gamut' : 'Rec.709');
  if (!(profiles as readonly string[]).includes(inputGamma)) throw new Error(`inputGamma must be one of: ${profiles.join(', ')}.`);
  if (!(gamuts as readonly string[]).includes(inputGamut)) throw new Error(`inputGamut must be one of: ${gamuts.join(', ')}.`);
  const amount = p.amount === undefined ? 1 : need<number>(p, 'amount', 'number');
  if (amount < 0 || amount > 1) throw new Error('amount runs 0..1.');
  // ponytail: rounded to 6 decimals (the UI sends raw float32 digits); the data rides in the node, its history entry and
  // every save of that node, and the server takes 20 MB per save. Float noise below 1e-6 only.
  return { id: createId('lut'), type: 'lut', enabled: true, name: basename(file).slice(0, 100), amount, inputGamma, inputGamut, cube: { ...cube, data: Array.from(cube.data, v => Math.round(v * 1e6) / 1e6) } };
}

// ---- Color Assistant ------------------------------------------------------------------------------------------------

const seen = new Map<string, AssistantJob>();
const short = (id: string) => id.slice(0, 8);
async function findJob(text: string): Promise<AssistantJob> {
  if (text.length < 4) throw new Error('params.job: a job id (at least 4 characters) or "latest".');
  const projectId = project().id, known = [...seen.values()].find(j => j.id === text || j.id.startsWith(text));
  if (known) return assistantJob(known.projectId, known.id);
  if (/^[a-f0-9-]{36}$/.test(text)) return assistantJob(projectId, text);
  const latest = await latestAssistantJob(projectId);
  if (latest && (text === 'latest' || latest.id.startsWith(text))) return latest;
  throw new Error(`No Color Assistant job "${text}" in this project.`);
}
function lookText(l: LookValues) {
  const neutral = neutralLook(), out: string[] = [];
  for (const k of ['contrast', 'pivot', 'saturation', 'lift', 'gamma', 'gain', 'offset'] as const) if (Math.abs(l[k] - neutral[k]) > 1e-4) out.push(`${k} ${num(l[k])}`);
  for (const k of ['liftRgb', 'gammaRgb', 'gainRgb', 'offsetRgb'] as const) if (l[k].r || l[k].g || l[k].b) out.push(`${k} ${num(l[k].r)}/${num(l[k].g)}/${num(l[k].b)}`);
  const curves = Object.entries(l.curves).filter(([, points]) => points.length).map(([ch, points]) => `${ch}${points.length}`);
  if (curves.length) out.push(`curves ${curves.join(',')}`);
  return out.join(' ') || 'neutral';
}
function looksText(job: AssistantJob, preSkipped: string[] = []) {
  const looks = job.result?.looks ?? [], used = job.request.clipIds.filter(id => !job.skipped.some(k => k.clipId === id)), id = short(job.id);
  const skipped = [...preSkipped, ...job.skipped.map(k => `${handle(k.clipId)} ${k.text}`)];
  return [
    `Color Assistant job ${id}: ${looks.length} looks for ${used.length} shot${used.length === 1 ? '' : 's'} (${used.map(handle).join(',')})${job.request.prompt ? ` · ${quote(job.request.prompt, 60)}` : ''}`,
    ...(skipped.length ? [`skipped: ${skipped.join(' | ')}`] : []),
    ...(job.result?.shots?.length ? [`balance (applied with any look): ${job.result.shots.map(n => `${handle(n.clipId)} ${n.balance ? [n.balance.exposure ? `exp ${num(n.balance.exposure)}` : '', n.balance.temperature ? `temp ${num(n.balance.temperature)}` : '', n.balance.tint ? `tint ${num(n.balance.tint)}` : ''].filter(Boolean).join(' ') || 'neutral' : 'kept'}${n.warnings.length ? ' ' + n.warnings.map(w => w.code).join(',') : ''}`).join(' · ')}`] : []),
    ...looks.map((o, i) => `${i + 1} ${o.intensity} ${quote(o.name, 40)}${o.recipe ? ` = ${o.recipe} ${Math.round((o.strength ?? 1) * 100)}%${o.warmth ? ` warmth ${num(o.warmth)}` : ''}` : ''}: ${lookText(o.look)}${o.extraNodes.length ? ` +${o.extraNodes.length} node${o.extraNodes.length > 1 ? 's' : ''} (${o.extraNodes.map(lookText).join('; ')})` : ''}${o.description ? ` — ${quote(o.description, 120)}` : ''}${o.shots.length ? ' · ' + o.shots.map(n => `${handle(n.clipId)} ${Math.round(n.confidence * 100)}%${n.warnings.length ? ' ' + n.warnings.map(w => w.code).join(',') : ''}`).join(' · ') : ''}`),
    `apply one: job{kind:"color-looks", params:{job:"${job.id}", apply:N}} · pictures: same job + stills:true (before + each look) or stills:N (look N on up to 3 shots)`,
  ].join('\n');
}
/** The server's preview stills: before + the three looks on the first shot, or one look on up to three shots. */
async function stills(job: AssistantJob, which: unknown): Promise<{ text: string; content: Content[] }> {
  const shots = (job.result?.stills ?? []).filter((still, i, all) => all.findIndex(o => o.clipId === still.clipId) === i);
  if (!shots.length) return { text: 'No preview stills in this result.', content: [] };
  const option = which === true ? 0 : Number(which), one = Number.isInteger(option) && option >= 1 && option <= 3;
  const picks = one ? shots.slice(0, 3).map(s => ({ url: s.after[option - 1] ?? s.before, label: `look ${option} on ${handle(s.clipId)}${s.after[option - 1] ? '' : ' (no still; before)'}` }))
    : [{ url: shots[0].before, label: `before on ${handle(shots[0].clipId)}` }, ...shots[0].after.map((url, i) => ({ url: url ?? shots[0].before, label: `look ${i + 1}${url ? '' : ' (no still)'}` }))];
  return { text: `images: ${picks.map(p => p.label).join(', ')}`, content: await Promise.all(picks.map(async p => image(await bytes(p.url)))) };
}
function follow(projectId: string, jobId: string, which: unknown, preSkipped: string[]): Poller {
  return {
    label: `Color Assistant ${short(jobId)}`,
    async poll(): Promise<Step> {
      let job: AssistantJob;
      // Like the panel: a 4xx (job gone, access removed) ends the wait; a server or network hiccup retries.
      try { job = await assistantJob(projectId, jobId); }
      catch (error) { const status = (error as { status?: number }).status ?? 0; if (status >= 400 && status < 500) throw error; return { done: false, text: `Color Assistant ${short(jobId)}: server unreachable, retrying` }; }
      seen.set(job.id, job);
      if (job.status === 'waiting' || job.status === 'running') return { done: false, text: `Color Assistant ${short(job.id)}: ${job.stage || 'Waiting'} ${Math.round(job.progress)}%` };
      if (job.status === 'cancelled') return done(`Color Assistant ${short(job.id)} was cancelled.`);
      if (job.status === 'failed') throw new Error(`Color Assistant failed: ${job.error ?? 'no reason given'}${preSkipped.length ? `\nskipped: ${preSkipped.join(' | ')}` : ''}`);
      const text = looksText(job, preSkipped);
      if (!which) return done(text);
      const pictures = await stills(job, which);
      return done(`${text}\n${pictures.text}`, pictures.content);
    },
    async cancel() { await cancelAssistant(projectId, jobId); },
  };
}
/** Why a shot cannot be sent, with the one-step fix when the app has one (ColorAssistantPanel's skip list). */
function skipText(c: Clip, code: string, text: string) {
  const fix = code === 'legacy-pipeline' ? 'initializeColorGrade' : code === 'not-aces' && acesOutputUpgrade(c, store.getState().nodes) ? 'useAcesOutput' : '';
  return `${handle(c.id)} ${text}${fix ? ` (fix: act{do:[["${fix}","${handle(c.id)}"]]})` : ''}`;
}

// ---- Normalize & color groups ---------------------------------------------------------------------------------------

type GroupOption = { id: string } | { name: string } | null;
const projectGroups = () => { const s = store.getState(); return colorGroups(s.clips.filter(c => c.projectId === s.projectId), s.nodes); };
/** params.group as the store takes it: an existing group by id (cg-…; a prefix of 11+ characters will do) or name joins it, another name makes one, null takes the shots out. */
function groupOption(value: unknown): GroupOption | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim()) throw new Error('params.group: a group name, a cg-… group id, or null to take the shots out.');
  const text = value.trim().replace(/^@/, ''), groups = projectGroups();
  const found = groups.find(g => g.id === text || (text.length >= 11 && g.id.startsWith(text))) ?? groups.find(g => g.name.toLowerCase() === text.toLowerCase());
  if (found) return { id: found.id };
  if (text.startsWith('cg-')) throw new Error(`No color group ${text} in this project.`);
  return { name: text.slice(0, 60) };
}
const balanceText = (b: AutoBalance) => [b.exposure ? `exp ${num(b.exposure)}` : '', b.temperature ? `temp ${Math.round(b.temperature)}` : '', b.tint ? `tint ${num(b.tint)}` : '', b.lift ? `lift ${num(b.lift)}` : '', b.gamma ? `gamma ${num(b.gamma)} gain ${num(b.gain ?? 1)}` : ''].filter(Boolean).join(' ') || 'neutral';
const shotText = (n: NormalizeShot) => `${handle(n.clipId)} ${balanceText(n.balance)} ${Math.round(n.confidence * 100)}%${n.warnings.length ? ' ' + n.warnings.map(w => w.code).join(',') : ''}`;
/** Polls the Normalize job, then applies its balances (and the group) as one undo step, like the Color page. */
function followNormalize(projectId: string, jobId: string, targets: string[], options: { group?: GroupOption; clean?: boolean }): Poller {
  const label = `Normalize ${short(jobId)}`;
  return {
    label,
    async poll(): Promise<Step> {
      let job: NormalizeJob;
      try { job = await normalizeJob(projectId, jobId); }
      catch (error) { const status = (error as { status?: number }).status ?? 0; if (status >= 400 && status < 500) throw error; return { done: false, text: `${label}: server unreachable, retrying` }; }
      if (job.status === 'waiting' || job.status === 'running') return { done: false, text: `${label}: ${job.stage || 'Waiting'} ${Math.round(job.progress)}%` };
      if (job.status === 'cancelled') return done(`${label} was cancelled.`);
      const missed = job.skipped.map(k => `${handle(k.clipId)} ${k.text}`), skipped = missed.length ? `\nskipped: ${missed.join(' | ')}` : '';
      if (job.status === 'failed') throw new Error(`Normalize failed: ${job.error ?? 'no reason given'}${skipped}`);
      // Context shots (other group members) were measured for pooling only.
      const shots = (job.result?.shots ?? []).filter(n => targets.includes(n.clipId));
      if (!shots.length) return done(`${label}: no shot could be measured.${skipped}`);
      if (project().id !== projectId) throw new Error(`${label} finished, but another project is open now; open its project and run Normalize again.`);
      const groupOfShot = (n: NormalizeShot) => colorGroupOf(store.getState().clips.find(c => c.id === n.clipId)), before = shots.map(groupOfShot);
      const { text, value } = await edit(run => run('normalizeColorGroup', { shots, level: job.result!.level }, options));
      // The group asked for; a new one is the group a shot actually moved into (a skipped shot keeps its old one).
      const id = options.group ? ('id' in options.group ? options.group.id : shots.map(groupOfShot).find((g, i) => g && g !== before[i])) : undefined, group = id && projectGroups().find(g => g.id === id);
      return done([`Normalized ${value} of ${shots.length} shot${shots.length === 1 ? '' : 's'}${group ? ` into ${quote(group.name, 40)} ${group.id} (${group.clipIds.length} shot${group.clipIds.length === 1 ? '' : 's'})` : options.group === null ? ', out of their color groups' : ''}${options.clean ? ', grades rebuilt' : ''}; a snapshot keeps the old grades.`,
        `balance: ${shots.map(shotText).join(' · ')}${skipped}`, text].join('\n'));
    },
    async cancel() { await cancelNormalize(projectId, jobId); },
  };
}

export const jobs: Record<string, JobDef> = {
  'color-grade': {
    doc: '{clip, at?:timeline s} → the clip\'s grade nodes in order (@ids, changed values, curves, effects, masks), render check, hints. help color',
    async start(p) { return done(gradeText(clipOf(need(p, 'clip')), p.at === undefined ? undefined : need<number>(p, 'at', 'number'))); },
  },
  'color-lut': {
    doc: '{node, file?:abs .cube, amount?, inputGamma?, inputGamut?, effects?} adds a 3D LUT to a grade node; effects (from get) rewrites its list, LUT data kept by id',
    async start(p) {
      const id = need(p, 'node'), node = gradeNode(id), c = clipOf(node.clipId);
      if (p.file === undefined && p.effects === undefined) throw new Error('Give file (a .cube to add) and/or effects (the node\'s new effect list).');
      const old = node.effects ?? [];
      let effects: ColorEffect[] = old;
      if (p.effects !== undefined) {
        // get{} prints LUT data as "[N numbers]": take it back from the stored effect with the same id.
        const stored = new Map(old.map(e => [e.id, e]));
        effects = need<ColorEffect[]>(p, 'effects', 'array').map(e => {
          const was = stored.get(e?.id);
          return e?.type === 'lut' && !Array.isArray(e.cube?.data) && was?.type === 'lut' ? { ...e, cube: was.cube } : e;
        });
      }
      if (p.file !== undefined) effects = [...effects, await loadLut(need(p, 'file'), p, c.properties.colorPipeline === 'nodes-v2')];
      const size = JSON.stringify(effects).length * 2 + JSON.stringify(old).length;
      if (size > MAX_SAVE) throw new Error(`That is about ${Math.round(size / 1024 ** 2)} MB to save (the server takes 20 MB). Use a 33³ LUT or put LUTs on separate nodes.`);
      return done((await edit(run => run('updateNode', id, { effects }))).text);
    },
  },
  'color-looks': {
    doc: '{clips?, prompt?, stills?} Color Assistant: balances each shot, then 3 library looks (about a minute); {job, apply:1-3} applies balance + that look; {job, stills?} shows it again',
    async start(p) {
      if (p.job !== undefined) {
        const job = await findJob(need(p, 'job'));
        seen.set(job.id, job);
        if (p.apply === undefined) return follow(job.projectId, job.id, p.stills, []);
        if (job.projectId !== project().id) throw new Error('That job belongs to another project; open it first.');
        const looks = job.result?.looks;
        if (job.status !== 'done' || !looks) throw new Error(`Job ${short(job.id)} has no looks (${job.status}${job.error ? `: ${job.error}` : ''}).`);
        const option = need<number>(p, 'apply', 'number');
        if (!Number.isInteger(option) || option < 1 || option > looks.length) throw new Error(`apply must be 1 to ${looks.length}.`);
        // Apply touches only the shots the result was made from, never ones the server skipped (ColorAssistantPanel).
        const used = job.request.clipIds.filter(id => !job.skipped.some(k => k.clipId === id));
        const { text, value } = await edit(run => run('applyColorAssistant', { mode: job.mode, ...job.result }, option - 1, used));
        return done(`Applied ${quote(looks[option - 1].name, 40)} to ${value} shot${value === 1 ? '' : 's'}; a snapshot keeps the previous grade.\n${text}`);
      }
      const caps = await assistantCapabilities();
      if (!caps.available) throw new Error(caps.reason ?? 'The Color Assistant is not available on this server.');
      const s = store.getState(), timelineId = s.timelineId;
      const shots = p.clips !== undefined ? need<string[]>(p, 'clips', 'array').map(clipOf)
        : s.clips.filter(c => c.timelineId === timelineId && s.tracks.find(t => t.id === c.trackId)?.kind === 'video' && s.media.some(m => m.id === c.mediaId)).sort((a, b) => a.start - b.start);
      const ids: string[] = [], skipped: string[] = [];
      for (const c of shots) { const verdict = eligibility(c, assetOf(c), s.nodes); if (verdict.ok) ids.push(c.id); else skipped.push(skipText(c, verdict.code, verdict.text)); }
      if (!ids.length) throw new Error(`No shot can use the Color Assistant yet${shots.length ? `:\n${skipped.join('\n')}` : ' (no video shots on this timeline).'}`);
      const prompt = p.prompt === undefined ? '' : need(p, 'prompt').trim();
      if (prompt.length > 500) throw new Error('prompt holds at most 500 characters.');
      const projectId = project().id;
      // startAssistant saves first: the server grades what it has stored.
      const jobId = await startAssistant(projectId, { mode: 'looks', clipIds: ids, ...(prompt ? { prompt } : {}) });
      return follow(projectId, jobId, p.stills, skipped);
    },
  },
  'color-normalize': {
    doc: '{clips?=selected, group?:name|cg-id|null, clean?} measures shots, sets each Balance (exposure, white balance, black point); group joins or makes a color group, null leaves',
    async start(p) {
      const s = store.getState(), picked = p.clips !== undefined ? need<string[]>(p, 'clips', 'array') : s.selectedClipIds.length ? s.selectedClipIds : s.selectedClipId ? [s.selectedClipId] : [];
      const targets = [...new Set(picked.map(id => clipOf(id).id))];
      if (!targets.length) throw new Error('Give clips, or select shots first (act{select}).');
      if (targets.length > 200) throw new Error('Normalize takes at most 200 shots at a time.');
      const group = groupOption(p.group), clean = p.clean === undefined ? undefined : need<boolean>(p, 'clean', 'boolean');
      // The group being joined (no group given: the targets' own groups) is measured as a whole: its other members go along as context, like the Color page.
      const joined = new Set(group === undefined ? targets.map(id => colorGroupOf(clipOf(id))) : group && 'id' in group ? [group.id] : []);
      const context = projectGroups().filter(g => joined.has(g.id)).flatMap(g => g.clipIds).filter(id => !targets.includes(id)).slice(0, 300 - targets.length);
      const projectId = project().id, jobId = await startNormalize(projectId, { clipIds: targets, ...(context.length ? { contextIds: context } : {}), ...(clean ? { clean } : {}) });
      return followNormalize(projectId, jobId, targets, { ...(group !== undefined ? { group } : {}), ...(clean !== undefined ? { clean } : {}) });
    },
  },
};

// ---- Help ------------------------------------------------------------------------------------------------------------

const appSource = (path: string) => { try { return appFile(path.replace('../../', '')); } catch { return ''; } };
/** The Primaries sliders ([label, key, min, max, step] in ColorWorkspace.tsx, a .tsx the MCP cannot import) and the
 *  per-node render limits (colorStages in color.ts), read from the source so they never drift. */
export function primaryTable() {
  const sliders = [...appSource('../../src/workspaces/ColorWorkspace.tsx').matchAll(/\['\w+','(\w+)',(-?[\d.]+),(-?[\d.]+),[\d.]+\]/g)].map(m => ({ key: m[1], min: Number(m[2]), max: Number(m[3]) }));
  const limitText = /limits:Record<string,number>=\{([^}]*)\}/.exec(appSource('../../src/services/color.ts'))?.[1] ?? '';
  const limits = Object.fromEntries([...limitText.matchAll(/(\w+):([\d.]+)/g)].map(m => [m[1], Number(m[2])]));
  const notes: Record<string, string> = { exposure: 'stops', temperature: '+ warmer', tint: '+ magenta', pivot: 'nodes-v2; legacy .5', saturation: '100 = unchanged' };
  return sliders.map(({ key, min, max }) => {
    const limit = limits[key] === undefined ? '' : key === 'saturation' ? `; render ≤${limits[key] * 100}` : `; render ±${limits[key]}`;
    return `${key} ${primaryDefaults[key] ?? 0} (${min}..${max}${notes[key] ? `, ${notes[key]}` : ''}${limit})`;
  });
}

function colorTopic() {
    const defaults = JSON.stringify(primaryDefaults).replace(/"/g, '');
    return [
      'Color grading: act edits the grade; jobs: color-grade (view), color-lut (.cube files), color-looks (Color Assistant), color-normalize (Normalize & group).',
      'Model: each clip has grade nodes run in `order`: parameters → curves → node effects (cst/lut, in list order) → mask blend → next node. job color-grade{clip} lists them with @ids and says if preview/export would refuse the grade (an unknown key or out-of-range value saves fine but breaks rendering). get{id:"@node"} shows one node.',
      'Pipelines: a clip starts legacy (nodes work in Gamma 2.4/Rec.709). act initializeColorGrade(clip) makes it nodes-v2: Input CST (source → DaVinci Intermediate/DaVinci Wide Gamut) · Balance · Look · Output CST (→ Gamma 2.4/Rec.709; aces2 for log sources, none for Rec.709). It replaces every node (a snapshot keeps the old grade). Grade between the two CSTs.',
      'Parameters (key default (UI range; per-node render limit)), set with updateNode(node,{parameters:{key:value}}) (keys merge, others stay):',
      ...primaryTable(),
      'saturationShadows saturationMidtones saturationHighlights 100 (0..400, 100 = unchanged): saturation by luma after saturation; shadows fade out by luma .5, highlights fade in from .5.',
      'lift 0 · gamma 0 · offset 0 (−1..1); gain 1 (0..2); per channel liftR liftG liftB, gammaR…, gainR…, offsetR… 0 (−1..1, added to the master; render ±2). Any other key, or hue≠0, fails at render.',
      'Curves: updateNode(node,{curves:{RGB?,R?,G?,B?}}) replaces all curves ({} clears). Each {mode:"smooth"|"linear", points:[{id,x,y,slope?}]}: 2–64 points, unique ids, x ascending (gap ≥.0001), first x=0, last x=1, x/y 0..1, slope −20..20. RGB runs first, then the channel. S-curve: {RGB:{mode:"smooth",points:[{id:"a",x:0,y:0},{id:"b",x:.25,y:.2},{id:"c",x:.75,y:.8},{id:"d",x:1,y:1}]}}',
      'Effects: updateNode(node,{effects:[…]}) replaces the node\'s whole list (≤16); read it first with get{id:"@node",path:"effects"}. A node holding a LUT: change its list through job color-lut{node, effects} instead (act cannot carry LUT data).',
      'CST: {id:"fx-<any unique>",type:"cst",enabled:true,inputGamma,inputGamut,outputGamma,outputGamut,toneMapping:"none"|"shoulder"|"aces2",gamutMapping:"none"|"compress"}. Input = the signal at that point. aces2 (ACES 2 SDR 100 nits) needs output Gamma 2.4/Rec.709 and gamutMapping none, a nodes-v2 clip, one per grade, and the grade must end in Gamma 2.4/Rec.709.',
      `gammas: ${profiles.join(', ')} ("Rec.709" = legacy Gamma 2.4)`,
      `gamuts: ${gamuts.join(', ')}`,
      'LUT: job color-lut{node, file:"/abs/look.cube"} (2–65 per axis, ≤32 MB). inputGamma/inputGamut only label what the LUT expects (default: the working space); nothing is converted, so put a CST before it if they differ. amount 0..1.',
      'Masks (one per node; never on a node with an enabled CST): depth key updateNode(node,{mask:{source:"depth",enabled:true,invert:false,amount:100,near:50,far:100,softness:10}}) (distance 0 nearest..100 farthest, far ≥ near); a Smart Mask subject attachSmartMask(clip, maskId, node) (help masks); remove with updateNode(node,{mask:null}).',
      'Recipes:',
      `- new correction before the output (the UI's New Node defaults; pivot .5 on a legacy clip): act{select:["@clip"], do:[["selectNode",null],["addNode","Correction",${defaults}]]}; after a given node use ["selectNode","@node"]. The new node prints as "+ node @id". Without selectNode it lands after an arbitrary node (select picks one).`,
      '- adjust: act{do:[["updateNode","@node",{parameters:{exposure:.3,saturation:115}}]]}; bypass {enabled:false}; rename {name:"Skin"}.',
      '- order: reorderNode(node,-1|1) · moveColorNode(node, beforeNode|null=end) · removeNode(node) · arrangeColorNodes(clip) tidies the graph.',
      '- copy a grade: act{do:[["copyGrade","@from"],["pasteGrade","@to1"],["pasteGrade","@to2"]]} (replaces all nodes, source settings and node keyframes on each target; same project).',
      '- highlights clipping on a log grade: useAcesOutput(clip) (color-grade suggests it when it applies).',
      '- source: updateProperty(clip,"inputProfile",gamma) and updateProperty(clip,"inputGamut",gamut), both, from the lists above (nothing checks them; a bad one breaks every render), before initializeColorGrade, which builds the Input CST from them · "dataLevels" Auto|Full|Video. Legacy clips only: inputExposure −6..6, inputTemperature −2000..2000.',
      '- imported DaVinci look: restoreResolveGrade(clip) brings it back (removes the nodes); updateProperty(clip,"bypassResolveLook",true) turns it off.',
      '- normalize & group: job color-normalize{clips, group?:"Name"|"cg-…"|null, clean?} sets every shot\'s Balance so they match (clean:true rebuilds each grade; snapshot first). A color group is one shared node after Balance on every member ([group cg-…] in color-grade): updateColorGroup("cg-…",{parameters,curves?,enabled?}) or updateNode on any member\'s group node changes all; renameColorGroup(id,name); setColorGroup([clips],{id}|{name}|null).',
      'Gotchas: a keyframed field (~ in color-grade) gets a keyframe at the playhead instead of a new static value (act at:<timeline seconds> picks the frame). Resolve-imported nodes may store capitalised keys (Exposure): write that spelling (get{id:"@node",path:"parameters"}), or the two keys clash. Never use applyGrade (legacy; appends after the output). act undo takes an edit back.',
      'Color Assistant: job color-looks{clips?, prompt?} needs nodes-v2 shots with verified camera input, ACES 2 output and effect-free nodes named exactly Balance and Look; color-grade says "assistant: ready". It runs minutes (poll), returns 3 looks; {job, apply:N} applies one to every shot it used (snapshot first).',
    ].join('\n');
}
export const topics: Record<string, string> = { color: colorTopic() };
