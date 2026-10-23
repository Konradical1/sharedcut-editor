// Color: the Color Assistant (a server job), 3D LUT import (a local .cube file), a compact grade view and color-measure
// (a graded frame's scope numbers, against a reference picture). Grading itself is plain store edits (act); the "color"
// help topic has the node model, every parameter (from the registry in grading.ts), formats, looks and act recipes.
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { edit, handle, need, clip as clipOf, project, store, done, bytes, image, sleep, ApiFailure, timeline as timelineOf, type Content, type JobDef, type Poller, type Step } from './kit.ts';
import { flush } from '../session.ts';
import { secs } from '../views.ts';
import { measure, content, statsLines, hints, regionText, regionHint, type Box, type GradeModel, type Pixels } from '../colorStats.ts';
import { profiles, gamuts, parseCube, processingStages, interpretation, acesOutputUpgrade, colorTransform } from '../../src/services/color.ts';
import { GRADE_PARAMS, PARAM, HSL_CURVES, FILM_AMOUNTS, on, hasWindow, hasQualifier, type GradeParam } from '../../src/services/grading.ts';
import { COLOR_LOOKS } from '../../src/services/colorPresets.ts';
import { sourceTime } from '../../src/services/playback.ts';
import { timecode } from '../../src/services/timecode.ts';
import { isComposition } from '../../src/services/compositions.ts';
import { eligibility, neutralLook, type LookValues } from '../../src/services/colorAssistant.ts';
import { assistantCapabilities, startAssistant, assistantJob, latestAssistantJob, cancelAssistant, type AssistantJob } from '../../src/services/colorAssistantClient.ts';
import { colorGroups, colorGroupOf, type AutoBalance, type NormalizeShot } from '../../src/services/colorGroups.ts';
import { startNormalize, normalizeJob, cancelNormalize, type NormalizeJob } from '../../src/services/colorNormalizeClient.ts';
import { createId } from '../../src/services/index.ts';
import { isDepthKey } from '../../src/services/smartMask.ts';
import { evaluateNodes } from '../../src/services/animation.ts';
import type { Clip, ColorEffect, ColorLutEffect, ColorTransformEffect, GradeNode, Timeline } from '../../src/state/models.ts';

const num = (v: number) => String(Math.round(v * 1000) / 1000);
/** num without the leading zero (.5, -.25): the grade view's compact numbers. */
const lean = (v: number) => num(v).replace(/^(-?)0\./, '$1.');
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
const OLD_CURVE_POINTS: Record<string, number> = { curve25: .25, curve50: .5, curve75: .75 };
const FILM_NAMES: Record<string, string> = { filmGrain: 'grain', filmHalation: 'hal', filmBloom: 'bloom', filmVignette: 'vig', filmWeave: 'weave', filmBreath: 'breath', filmAberration: 'aberr' };
/** Windows, qualifier, mixer and film as compact summaries; `shown` collects the keys they cover (left out of k=v). */
function toolText(p: Record<string, number>, value: (key: string) => string, shown: Set<string>, masked: boolean) {
  const out: string[] = [], stored = (prefix: string) => Object.keys(p).some(k => k.startsWith(prefix));
  const take = (group: GradeParam['group'], skip: string[] = []) => GRADE_PARAMS.filter(q => q.group === group && !skip.includes(q.key)).forEach(q => shown.add(q.key));
  const inv = (key: string) => on(p[key]) ? ' inv' : '', turned = (key: string) => (p[key] ?? 0) || value(key).endsWith('~') ? ` rot ${value(key)}` : '';
  const tool = (group: GradeParam['group'], prefix: string, onKey: string, text: () => string, skip?: string[]) => {
    if (!stored(prefix)) return;
    take(group, skip);
    out.push(on(p[onKey]) ? text() : `${prefix}(off)`);
  };
  tool('circle', 'circ', 'circOn', () => `circ(${value('circX')},${value('circY')} r${value('circW')}x${value('circH')}${turned('circAngle')} soft ${value('circSoft')}${inv('circInvert')})`);
  tool('rectangle', 'rect', 'rectOn', () => `rect(${value('rectX')},${value('rectY')} ${value('rectW')}x${value('rectH')}${turned('rectAngle')} soft ${value('rectSoft')}${(p.rectRound ?? 0) ? ` round ${value('rectRound')}` : ''}${inv('rectInvert')})`);
  tool('gradient', 'grad', 'gradOn', () => `grad(${value('gradX')},${value('gradY')} angle ${value('gradAngle')} soft ${value('gradSoft')}${inv('gradInvert')})`);
  // The soft edges of the sat and lum ranges are rarely changed: they stay in the k=v list.
  const range = (name: string, low: string, high: string) => (p[low] ?? 0) > 0 || (p[high] ?? 100) < 100 || /~/.test(value(low) + value(high)) ? `, ${name} ${value(low)}-${value(high)}` : '';
  tool('qualifier', 'qual', 'qualOn', () => `qual(${(p.qualHueWidth ?? 360) >= 360 ? 'any hue' : `hue ${value('qualHue')} w${value('qualHueWidth')} soft ${value('qualHueSoft')}`}${range('sat', 'qualSatLow', 'qualSatHigh')}${range('lum', 'qualLumLow', 'qualLumHigh')}${inv('qualInvert')})`, ['qualSatSoft', 'qualLumSoft']);
  if (stored('mix')) {
    take('mixer');
    const rows = ['R', 'G', 'B'].filter((row, r) => ['R', 'G', 'B'].some((col, c) => (p[`mix${row}${col}`] ?? (r === c ? 1 : 0)) !== (r === c ? 1 : 0) || value(`mix${row}${col}`).endsWith('~')));
    const text = [...rows.map(row => `${row} ${['R', 'G', 'B'].map(col => value(`mix${row}${col}`)).join('/')}`), on(p.mixMono) ? 'mono' : ''].filter(Boolean).join(' ');
    if (text) out.push(`mix(${text})`);
  }
  const film = FILM_AMOUNTS.filter(k => (p[k] ?? 0) !== 0 || value(k).endsWith('~'));
  film.forEach(k => shown.add(k));
  // Film runs on the whole frame after the node's blend: a window, key or mask on the same node never limits it.
  if (film.length) out.push(`film(${film.map(k => `${FILM_NAMES[k]} ${value(k)}`).join(' ')}${masked || hasWindow(p) || hasQualifier(p) ? ', unmasked' : ''})`);
  return out;
}
function nodeLine(node: GradeNode, c: Clip, managed: boolean) {
  const keyed = (field: string) => c.keyframes?.[`nodes.${node.id}.${field}`]?.length ? '~' : '';
  const p = node.parameters, value = (key: string) => `${lean(p[key] ?? PARAM[key].initial)}${keyed(`parameters.${key}`)}`;
  // A node without pivot contrasts around .5 (gradeValues), even on nodes-v2 where the UI's New Node stores .336.
  const initial = (key: string) => key === 'pivot' ? (managed ? PARAM.pivot.initial : .5) : PARAM[key]?.initial ?? OLD_CURVE_POINTS[key] ?? PARAM[key.toLowerCase()]?.initial ?? 0;
  const shown = new Set<string>(), tools = toolText(p, value, shown, !!node.mask?.enabled);
  // Changed = prints differently from the default (a stored pivot .336 is the default .336043).
  const params = Object.entries(p).filter(([k, v]) => !shown.has(k) && (num(v) !== num(initial(k)) || keyed(`parameters.${k}`))).map(([k, v]) => `${k}=${num(v)}${keyed(`parameters.${k}`)}`);
  if (managed && p.pivot === undefined && ((p.contrast ?? 1) !== 1 || p.shadows || p.highlights)) params.push('pivot=.5(unset)');
  const m = node.mask, mask = !m ? '' : `mask ${isDepthKey(m) ? `depth ${m.near}-${m.far} soft ${m.softness}` : `smart ${handle(m.id)}`}${m.invert ? ' inverted' : ''}${m.amount !== 100 ? ` ${m.amount}%` : ''}${m.enabled ? '' : ' off'}`;
  const curves = (hsl: boolean) => {
    const listed = Object.entries(node.curves ?? {}).filter(([ch, cv]) => cv && (HSL_CURVES as readonly string[]).includes(ch) === hsl);
    return listed.length ? `${hsl ? 'hsl' : 'curves'} ${listed.map(([ch, cv]) => `${ch}${cv!.points.length}`).join(',')}${keyed('curves')}` : '';
  };
  return [`${handle(node.id)} ${quote(node.name, 30)}${node.enabled ? '' : ' (off)'}${keyed('enabled')}`, node.group ? `[group ${node.group}]` : '', ...params, curves(false), curves(true), ...tools, ...(node.effects ?? []).map(fxText), mask].filter(Boolean).join(' ');
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

// ---- Measure ----------------------------------------------------------------------------------------------------------

const MEASURE_EDGE = 512, SHOW_EDGE = 384, MAX_REF_FILE = 64 * 1024 * 1024;
type Shot = { jpeg: Buffer; note: string };
/** Why /api/frames would not render a still alone (server/previewCache.ts STILL_LIVE), and what to do about it. */
const UNMEASURABLE: Record<string, string> = { cut: 'measure outside the transition (at)', denoise: 'bypass Noise Reduction while grading, measure, then turn it back on', bake: 'bypass Stabilize/optical flow while grading, measure, then turn it back on', depth: 'bypass the Depth effect or key while measuring' };

/** The topmost clip `pick` accepts that is drawn at `t` on the timeline (higher video track on top). */
function topAt(tl: Timeline, t: number, pick: (c: Clip) => boolean) {
  const s = store.getState(), number = new Map(s.tracks.filter(x => x.timelineId === tl.id && x.kind === 'video' && !x.hidden).map(x => [x.id, x.number]));
  return s.clips.filter(c => c.timelineId === tl.id && !c.disabled && number.has(c.trackId) && c.start <= t + 1e-6 && t < c.start + c.duration - 1e-6 && pick(c)).sort((a, b) => number.get(b.trackId)! - number.get(a.trackId)!)[0];
}
/** The graded timeline picture at `t`, rendered by Export's renderer (GET /api/frames, as the frame tool); a composition is
 *  looked inside. `ref` names the reference clip it is for, whose frame `at` cannot pick. */
async function gradedStill(tl: Timeline, t: number, depth = 0, ref = ''): Promise<Shot> {
  for (let attempt = 0; ; attempt++) {
    try { return { jpeg: await bytes(`/frames?${new URLSearchParams({ projectId: tl.projectId, timelineId: tl.id, t: String(t), w: String(MEASURE_EDGE) })}`), note: '' }; }
    catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      if (error.status === 429 && attempt < 3) { await sleep(3000); continue; }
      const live = String(error.data?.live ?? '');
      if (error.status === 409 && live === 'composition' && depth < 4) {
        const top = topAt(tl, t, isComposition), inner = top && store.getState().timelines.find(x => x.id === top.properties.compositionId);
        if (inner) { const at = sourceTime(top, t, project().fps, inner.duration), shot = await gradedStill(inner, at, depth + 1, ref); return { jpeg: shot.jpeg, note: `inside composition ${quote(inner.name, 30)} @${secs(at)}s${shot.note ? `; ${shot.note}` : ''}` }; }
      }
      const advice = ref && (live === 'cut' || !UNMEASURABLE[live]) ? 'use another shot as ref' : UNMEASURABLE[live] ?? 'measure another frame';
      if (error.status === 409) throw new Error(`The server cannot render ${ref ? `the ref ${ref} at its middle (${secs(t)}s)` : `the graded frame at ${secs(t)}s`} on its own (${error.data?.error ?? 'refused'}); ${advice}.`);
      if (error.status === 404 && error.data?.error === 'API endpoint not found.') throw new Error('This server has no /api/frames; update it to measure frames.');
      throw error;
    }
  }
}
/** A decoded picture scaled to `edge` px on its long side (never up). */
function pixels(picture: Image, edge = MEASURE_EDGE): Pixels {
  const scale = Math.min(1, edge / Math.max(picture.width, picture.height)), width = Math.max(1, Math.round(picture.width * scale)), height = Math.max(1, Math.round(picture.height * scale));
  const canvas = createCanvas(width, height), g = canvas.getContext('2d');
  g.drawImage(picture, 0, 0, width, height);
  return { width, height, data: g.getImageData(0, 0, width, height).data };
}
async function decode(data: Buffer, what: string) {
  try { return await loadImage(data); } catch { throw new Error(`${what} is not a picture this can read (PNG, JPEG, WebP, GIF or AVIF).`); }
}
/** The clip's timeline, the frame to measure (`at`, else the playhead when over the clip, else its middle), a title, and
 *  whether the picture's grade is nodes-v2 (its exposure and white balance work on linear light). */
function measuredFrame(p: Record<string, any>) {
  const s = store.getState(), fps = project().fps, at = p.at === undefined ? undefined : need<number>(p, 'at', 'number'), snap = (t: number) => Math.floor(t * fps + 1e-6) / fps;
  if (p.clip === undefined) {
    const tl = timelineOf(), end = Math.max(0, ...s.clips.filter(c => c.timelineId === tl.id && !c.disabled).map(c => c.start + c.duration));
    if (!end) throw new Error('The open timeline is empty: nothing to measure.');
    const t = snap(Math.max(0, Math.min(end - 1 / fps, at ?? s.playhead))), shown = topAt(tl, t, c => s.media.some(m => m.id === c.mediaId));
    return { tl, t, title: `"${tl.name}"`, over: [] as Clip[], disabled: false, hidden: false, linear: !shown || shown.properties.colorPipeline === 'nodes-v2', graded: shown as Clip | undefined };
  }
  const c = clipOf(need(p, 'clip')), track = s.tracks.find(x => x.id === c.trackId);
  if (track?.kind !== 'video') throw new Error(`${handle(c.id)} is not on a video track; measure a picture clip.`);
  const last = c.start + Math.max(0, c.duration - 1 / fps), t = snap(Math.max(c.start, Math.min(last, at ?? (s.playhead >= c.start && s.playhead <= last ? s.playhead : c.start + c.duration / 2))));
  // What the frame also shows over this clip (titles, captions, other video): it counts in the stats.
  const above = new Set(s.tracks.filter(x => x.timelineId === c.timelineId && x.kind === 'video' && !x.hidden && x.number > track.number).map(x => x.id));
  const over = s.clips.filter(o => above.has(o.trackId) && !o.disabled && o.start <= t + 1e-6 && t < o.start + o.duration - 1e-6);
  return { tl: timelineOf(c.timelineId), t, title: `${handle(c.id)} ${quote(c.name, 40)}`, over, disabled: c.disabled, hidden: track.hidden, linear: c.properties.colorPipeline === 'nodes-v2', graded: c as Clip | undefined };
}
/** params.ref as a picture: an image file (absolute path), a media item's own picture, or another clip's graded frame. */
async function reference(ref: string): Promise<{ picture: Image; title: string }> {
  const s = store.getState(), asset = s.media.find(m => m.id === ref && m.projectId === s.projectId), other = s.clips.find(c => c.id === ref && c.projectId === s.projectId);
  if (asset) {
    if (asset.kind === 'audio') throw new Error(`${handle(asset.id)} is audio; ref needs a picture.`);
    const t = asset.kind === 'image' ? 0 : Math.max(0, asset.duration / 2);
    return { picture: await decode(await bytes(`/frames?${new URLSearchParams({ projectId: asset.projectId, mediaId: asset.id, t: String(t), w: String(MEASURE_EDGE) })}`), `${handle(asset.id)}`), title: `${handle(asset.id)} ${quote(asset.name, 40)}${asset.kind === 'image' ? '' : ` @${secs(t)}s ungraded`}` };
  }
  if (other) {
    const frame = measuredFrame({ clip: other.id, at: other.start + other.duration / 2 }), shot = await gradedStill(frame.tl, frame.t, 0, handle(other.id));
    return { picture: await decode(shot.jpeg, handle(other.id)), title: `${frame.title} @${secs(frame.t)}s graded${shot.note ? ` (${shot.note})` : ''}` };
  }
  if (!isAbsolute(ref)) throw new Error('params.ref: an absolute path to an image file, or a media or clip @id of this project.');
  const info = await stat(ref).catch(() => { throw new Error(`No file at ${ref}.`); });
  if (!info.isFile() || info.size > MAX_REF_FILE) throw new Error('params.ref must be an image file of at most 64 MB.');
  return { picture: await decode(await readFile(ref), basename(ref)), title: quote(basename(ref), 40) };
}
const lumaOf = (rgb: number[]) => .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
/** The x in [lo, hi] where a rising f reaches `target` (bisection). */
function solve(f: (x: number) => number, target: number, lo: number, hi: number) {
  for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; if (f(mid) < target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
/** The 3×3 system m·v = b (Cramer). */
function solve3(m: number[][], b: number[]) {
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]), d = det(m);
  if (Math.abs(d) < 1e-12) throw new Error('No unique answer.');
  return [0, 1, 2].map(c => det(m.map((row, r) => row.map((v, k) => k === c ? b[r] : v))) / d);
}
/**
 * color-measure's amounts: the clip's grade on the CPU reference (which preview and export match) as a function of a change
 * made where Balance sits (after the Input CST on nodes-v2, before every node on legacy), probed on greys. ACES 2 runs only
 * in OpenColorIO, so the shoulder curve stands in for it; windows and masks count as off, and film (spatial) is left out.
 */
export function gradeModel(c: Clip, time: number): GradeModel | undefined {
  const managed = c.properties.colorPipeline === 'nodes-v2', own = evaluateNodes(nodesOf(c), c, time).filter(n => n.enabled);
  const first = managed ? own.findIndex(n => n.effects?.some(e => e.enabled && e.type === 'cst')) : -1;
  const input = first >= 0 ? own[first].effects!.find(e => e.enabled && e.type === 'cst') as ColorTransformEffect : undefined;
  if (managed && !input) return;
  const rest = own.slice(first + 1).map(n => ({ ...n, effects: n.effects?.map(e => e.type === 'cst' && e.toneMapping === 'aces2' ? { ...e, toneMapping: 'shoulder' as const, gamutMapping: 'compress' as const } : e) }));
  const clip: Clip = { ...c, keyframes: {}, properties: { ...c.properties, inputExposure: 0, inputTemperature: 0, ...(input ? { inputProfile: input.outputGamma, inputGamut: input.outputGamut } : {}) } };
  const graded = (patch: Record<string, number>) => {
    const probe: GradeNode = { id: 'probe', clipId: c.id, projectId: c.projectId, name: 'Probe', kind: 'probe', enabled: true, order: -1e6, parameters: { pivot: managed ? PARAM.pivot.initial : .5, ...patch } };
    const transform = colorTransform(clip, undefined, [probe, ...rest], undefined, () => 0);
    return (rgb: number[]) => transform(rgb).map(v => v * 100);
  };
  const plain = graded({}), grey = (level: number) => { const x = solve(v => lumaOf(plain([v, v, v])), level, 0, managed ? 1.2 : 1); return [x, x, x]; };
  const tint = (rgb: number[]) => [(rgb[0] - rgb[2]) / 2, (rgb[0] + rgb[2]) / 2 - rgb[1]], spread = managed ? .03 : .06;
  const chroma = (rgb: number[]) => { const l = lumaOf(rgb); return 2 * Math.hypot((rgb[2] - l) / 1.8556, (rgb[0] - l) / 1.5748); };
  return {
    exposure(from, to) { const x = grey(from); return solve(e => lumaOf(graded({ exposure: e })(x)), to, -6, 6); },
    contrast(low, high, wanted) { const a = grey(low), b = grey(high); return solve(k => { const g = graded({ contrast: k }); return lumaOf(g(b)) - lumaOf(g(a)); }, wanted, .2, 4); },
    balance(level, warm, mag) {
      const x = grey(level), base = tint(plain(x)), per = (patch: Record<string, number>, size: number) => tint(graded(patch)(x)).map((v, i) => (v - base[i]) / size);
      const [tw, tm] = per({ temperature: 300 }, 300), [kw, km] = per({ tint: 6 }, 6), det = tw * km - kw * tm;
      if (Math.abs(det) < 1e-9) throw new Error('White balance does not move this grade.');
      return [(warm * km - kw * mag) / det, (tw * mag - warm * tm) / det];
    },
    balanced(level, temperature, tint) { const x = grey(level), base = plain(x); return graded({ temperature, tint })(x).map((v, i) => v - base[i]); },
    saturation(level, ratio) {
      const [x] = grey(level), colours = [[spread, 0, -spread], [-spread, 0, spread], [0, spread, -spread], [0, -spread, spread]].map(o => o.map(v => x + v));
      const amount = (s: number) => { const g = graded({ saturation: s }); return colours.reduce((sum, rgb) => sum + chroma(g(rgb)), 0); }, base = amount(100);
      return solve(s => amount(s) / base, ratio, 0, 400);
    },
    channels(keys, level, need) {
      const x = grey(level), base = plain(x), size = .01, columns = keys.map(key => graded({ [key]: size })(x).map((v, i) => (v - base[i]) / size));
      return solve3([0, 1, 2].map(row => columns.map(col => col[row])), need);
    },
  };
}
type Region = { name: string; box: Box; ref: Box };
function regionsOf(value: unknown): Region[] {
  if (value === undefined) return [];
  const usage = 'params.regions: up to 8 boxes {name?, x, y, w, h} in fractions of the picture (top-left origin), each optionally ref:{x,y,w,h} where the reference shows it.';
  const box = (b: any): Box => {
    if (!b || typeof b !== 'object' || ![b.x, b.y, b.w, b.h].every(v => typeof v === 'number' && Number.isFinite(v)) || b.w <= 0 || b.h <= 0 || b.x < 0 || b.y < 0 || b.x + b.w > 1.001 || b.y + b.h > 1.001) throw new Error(usage);
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  };
  if (!Array.isArray(value) || value.length > 8) throw new Error(usage);
  return value.map((r, i) => { const own = box(r); return { name: String(r.name ?? `r${i + 1}`).replace(/\s+/g, '_').slice(0, 24), box: own, ref: r.ref === undefined ? own : box(r.ref) }; });
}
const boxText = (b: Box) => `${lean(b.x)},${lean(b.y)} ${lean(b.w)}x${lean(b.h)}`;
/** Frame and reference side by side, regions outlined, for the model to look at. */
async function sideBySide(shots: { picture: Image; label: string; boxes: [string, Box][] }[]) {
  const scaled = shots.map(s => { const k = Math.min(SHOW_EDGE / s.picture.width, SHOW_EDGE * 9 / 16 / s.picture.height); return { ...s, w: Math.round(s.picture.width * k), h: Math.round(s.picture.height * k) }; });
  const canvas = createCanvas(scaled.reduce((x, s) => x + s.w, 0) + (scaled.length - 1) * 4, Math.max(...scaled.map(s => s.h))), g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height); g.font = '11px sans-serif'; g.textBaseline = 'top';
  let x = 0;
  for (const s of scaled) {
    g.drawImage(s.picture, x, 0, s.w, s.h);
    g.strokeStyle = '#ffd400'; g.fillStyle = '#ffd400'; g.lineWidth = 1;
    for (const [name, b] of s.boxes) { g.strokeRect(x + b.x * s.w + .5, b.y * s.h + .5, b.w * s.w - 1, b.h * s.h - 1); g.fillText(name, x + b.x * s.w + 3, b.y * s.h + 2); }
    const width = g.measureText(s.label).width + 6;
    g.fillStyle = 'rgba(0,0,0,.65)'; g.fillRect(x, s.h - 15, width, 15); g.fillStyle = '#fff'; g.fillText(s.label, x + 3, s.h - 13);
    x += s.w + 4;
  }
  return image(Buffer.from(await canvas.encode('jpeg', 82)));
}
/** job color-measure: scope numbers of the graded frame, the reference's beside them, and what to change to match. */
async function colorMeasure(p: Record<string, any>) {
  const regions = regionsOf(p.regions), wantImages = p.images === undefined ? false : need<boolean>(p, 'images', 'boolean');
  const ref = p.ref === undefined ? undefined : need(p, 'ref');
  // The server renders what it holds: save first, as the frame tool does.
  await flush();
  const frame = measuredFrame(p), shot = await gradedStill(frame.tl, frame.t), picture = await decode(shot.jpeg, 'The rendered frame');
  const target = ref === undefined ? undefined : await reference(ref);
  const px = pixels(picture), rx = target && pixels(target.picture), fb = content(px), rb = rx && content(rx);
  const f = measure(px, fb), r = rx && measure(rx, rb);
  const bars = (b: Box) => b.w < 1 || b.h < 1 ? ` bars trimmed (picture ${boxText(b)})` : '';
  const notes = [shot.note, frame.disabled ? 'the clip is disabled: this is what plays instead' : '', frame.hidden ? 'its track is hidden: this is what shows instead (show the track to measure the clip)' : '', frame.over.length ? `drawn over it and counted: ${frame.over.map(o => `${handle(o.id)} ${quote(o.name, 24)}`).join(', ')}` : ''].filter(Boolean);
  const lines = [`${frame.title} ${timecode(frame.t, project().fps)} (${secs(frame.t)}s) graded frame ${px.width}×${px.height}${bars(fb)}${target ? ` · ref ${target.title} ${target.picture.width}×${target.picture.height}${bars(rb!)}` : ''}`, ...notes.map(n => `note: ${n}`)];
  lines.push(...statsLines(f, r));
  for (const region of regions) {
    const fs = measure(px, region.box), rs = rx && measure(rx, region.ref), hint = rs ? regionHint(fs, rs) : '';
    lines.push(`region ${region.name} (${boxText(region.box)}): ${regionText(fs)}${rs ? ` | ref${region.ref === region.box ? '' : ` (${boxText(region.ref)})`} ${regionText(rs)}` : ''}${hint ? ` → ${hint}` : ''}`);
  }
  if (r) {
    let model: GradeModel | undefined;
    try { model = frame.graded && gradeModel(frame.graded, frame.t); } catch { /* The display-gamma guesses stand in. */ }
    const todo = hints(f, r, { linear: frame.linear, model });
    lines.push(todo.length ? `to match the ref (+/− add to the current value, × multiplies it; ${model ? 'amounts from this grade, damped' : 'amounts are guesses'}; apply top-down to the first exposure or Balance hint, then measure again):` : 'matches the ref within the hint thresholds.', ...todo.map(h => `- ${h}`));
  }
  if (!wantImages) return done(lines.join('\n'));
  const boxes = (which: 'box' | 'ref') => regions.map(g => [g.name, g[which]] as [string, Box]);
  return done(lines.join('\n'), [await sideBySide([{ picture, label: 'frame', boxes: boxes('box') }, ...(target ? [{ picture: target.picture, label: 'ref', boxes: boxes('ref') }] : [])])]);
}

export const jobs: Record<string, JobDef> = {
  'color-grade': {
    doc: '{clip, at?:timeline s} → the clip\'s grade nodes in order (@ids, changed values, windows, qualifier, curves, mixer, film, effects, masks), render check, hints. help color',
    async start(p) { return done(gradeText(clipOf(need(p, 'clip')), p.at === undefined ? undefined : need<number>(p, 'at', 'number'))); },
  },
  'color-measure': {
    doc: '{clip?, at?:timeline s, ref?:abs image path|@media|@clip, regions?:[{name,x,y,w,h}], images?} graded frame scopes as numbers; with ref, its numbers + what to change. help color',
    start: colorMeasure,
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

const GROUPS: Record<GradeParam['group'], string> = {
  primaries: 'Primaries', wheels: 'Wheels: Shadows/Midtones/Highlights/Offset = DaVinci Lift/Gamma/Gain/Offset, stored as lift/gamma/gain/offset',
  log: 'Log wheels', mixer: 'RGB mixer', qualifier: 'Qualifier (HSL key of the node input)', circle: 'Circle window', rectangle: 'Rectangle window', gradient: 'Gradient window',
  film: 'Film (a whole-frame stage after the node)',
};
const unit = (q: GradeParam) => !q.unit || '%°×'.includes(q.unit) ? q.unit ?? '' : ` ${q.unit}`;
const span = (q: GradeParam) => q.min === 0 && q.max === 1 && q.step === 1 ? '0|1' : `${lean(q.initial)} (${lean(q.min)}..${lean(q.max)}${unit(q)}${q.limit ? `; render ${lean(q.limit[0])}..${lean(q.limit[1])}` : ''})`;
/** Every grade parameter from the registry (grading.ts GRADE_PARAMS) under its group: `key default (UI range unit; render limit) doc`. R/G/B triplets share a line. */
export function parameterLines() {
  const lines: string[] = [];
  for (let i = 0, group = ''; i < GRADE_PARAMS.length; i++) {
    const q = GRADE_PARAMS[i], base = q.key.slice(0, -1);
    if (q.group !== group) { group = q.group; lines.push(`## ${GROUPS[q.group]}`); }
    if (q.group === 'mixer' && q.key !== 'mixMono') {
      if (q.key === 'mixRR') lines.push(`mixRR mixRG mixRB mixGR mixGG mixGB mixBR mixBG mixBB 1 on the diagonal (RR GG BB), else 0 (${lean(q.min)}..${lean(q.max)}) RGB mixer: share of input <column> in output <row>.`);
      continue;
    }
    if (q.key.endsWith('R') && ['G', 'B'].every((c, k) => GRADE_PARAMS[i + 1 + k]?.key === base + c && span(GRADE_PARAMS[i + 1 + k]) === span(q))) { lines.push(`${base}R ${base}G ${base}B ${span(q)} ${q.doc.replace(/\bR\b/, 'R/G/B')}`); i += 2; continue; }
    lines.push(`${q.key} ${span(q)} ${q.doc}`);
  }
  return lines;
}

function colorTopic() {
  return [
    'Color grading, DaVinci-style nodes: act edits them (addNode, updateNode, applyColorLook…); jobs color-grade (a clip\'s nodes), color-measure (a graded frame as scope numbers vs a reference picture, with hints), color-lut (.cube), color-looks (Color Assistant), color-normalize (balance and group shots). help{topic:"color", filter:"qual"} narrows.',
    'Model: each clip has grade nodes run in `order`. In a node: exposure/temperature/tint → contrast around pivot, offset, gamma, gain, lift → log wheels → shadows/highlights → saturation (+ range sat) → hue, boost, density → custom curves → HSL curves → mixer → its cst/lut effects → blend over the node input by mask × windows × qualifier → film stage (whole frame) → next node. color-grade{clip} lists the nodes and says if preview/export would refuse the grade (an unknown key or out-of-range value saves but breaks rendering).',
    'Pipelines: a clip starts legacy (nodes work in Gamma 2.4/Rec.709). act initializeColorGrade(clip) makes it nodes-v2: Input CST (source → DaVinci Intermediate/DaVinci Wide Gamut) · Balance · Look · Output CST (→ Gamma 2.4/Rec.709; aces2 for log sources, none for Rec.709). It replaces every node (a snapshot keeps the old grade). Grade between the two CSTs.',
    'Values: updateNode(node,{parameters:{key:value}}) merges keys; an absent key is its default and does nothing; toggles are 0|1. A node without pivot contrasts around .5: on nodes-v2 store pivot .336 (the UI\'s New Node does; color-grade flags pivot=.5(unset)). All keys: Parameters below.',
    'Wheels: Shadows = lift (adds lift·(1−v)) · Midtones = gamma (v^(1/2^gamma): + brightens mids) · Highlights = gain (multiplies) · Offset (adds everywhere). Master = brightness, R/G/B = colour: warmer R+ B−, teal R− B+, magenta G−. Legacy (display signal): lift moves the blacks most and white not at all, gain white most. nodes-v2 runs them on the log signal (DaVinci Intermediate, white ~.51), so lift moves whites about as much as blacks (close to Offset) and gain reaches the mids: .01 on a lift or gain channel moves display ~2–3 units, gamma ~1 at mid grey. To colour one tonal band on nodes-v2, use the log wheels.',
    'Log wheels: logShadow/logMid/logHighlight (+R/G/B) offset one tonal band of the signal: Shadow below logLowRange, Highlight above logHighRange, Midtone between, edges feathered ±.1. On nodes-v2 mid grey is .336 and diffuse white ~.51: Shadow is everything below mid grey, Highlight mostly speculars (logHighRange ~.45 reaches bright skin and sky). The split-tone tool: teal shadows logShadowR− B+, warm highlights logHighlightR+ B−.',
    'shadows/highlights bend the tones below/above the node\'s pivot (black, white and pivot stay put): highlights −30..−60 recovers skies and windows, shadows +15..+30 opens faces in shade. boost = vibrance; density = film dye (saturated colours darker, richer).',
    'HSL curves (in node.curves, points as custom curves; updateNode curves replaces ALL of them, so resend RGB/R/G/B: get{id:"@node",path:"curves"}): HueHue HueSat HueLum take x = hue in turns (red 0, skin .08, yellow .2, green .35, cyan .5, blue .7, magenta .85) and wrap (first y = last y); LumSat x = luma; SatSat SatLum x = saturation (nodes-v2: most colours below .25). y .5 = no change. HueHue shifts hue y−.5 turns (.55 = +18°); HueSat/LumSat/SatSat scale chroma by 2y (0 greys); HueLum adds (y−.5)·.5 luma on saturated colours; SatLum adds (y−.5)·.5. Quieter greens: {HueSat:{mode:"smooth",points:[{id:"a",x:0,y:.5},{id:"b",x:.25,y:.5},{id:"c",x:.35,y:.3},{id:"d",x:.45,y:.5},{id:"e",x:1,y:.5}]}}',
    'Mixer: a row summing to 1 keeps greys grey. mixMono 1 = black and white from the R row: .3/.59/.11 neutral, .6/.35/.05 red filter (darker skies), .25/.65/.1 green filter (lighter foliage).',
    'Qualifier (qualOn 1): the node grades only what its HSL key selects, keyed on the node INPUT: hue within qualHue ± qualHueWidth/2 (skin ~25–40°), then the sat and lum ranges. On nodes-v2 that input is log: saturation reads ~1/5 of the display value (skin ~3–8, vivid red ~20), so keep qualSatLow ≤ 2; mid grey lum ~34. color-measure regions give a display hue and sat to start from; a window keeps the key off the background.',
    'Windows (circOn/rectOn/gradOn 1; several on a node = their union): source-picture coordinates, x 0 left..1 right, y 0 top..1 bottom, sizes in picture heights (16:9 is 1.78 wide). They do not follow motion: keyframe them (help keyframes; path nodes.<node id>.parameters.circX, key stored first).',
    'Blend: a node mixes over its input by mask × windows × qualifier, so give each isolated correction (sky, face, vignette) its own node between Balance and Look. A node with a window, qualifier or mask cannot hold a CST.',
    'Film: any film amount (filmHalation, filmBloom, filmGrain, filmVignette, filmWeave, filmBreath, filmAberration) ≠ 0 adds a film stage after the node on the whole frame, never masked, windowed or keyed. Put it on the Look node or a Film node just before the Output CST (thresholds are stops above mid grey there). Judge it with frame{}; color-measure barely sees it.',
    'color-measure{clip?, at?, ref?, regions?, images?}: the graded frame (rendered like Export, letterbox bars left out) as luma percentiles (display code 0–100), crushed/clipped %, zones shadows (luma <25)/mids/highlights (>75) with share, mean R/G/B, warm (R−B)/2, mag (R+B)/2−G (+ magenta) and sat, saturation (vectorscope 0–100) mean/p90 and main hues. ref (image file, media item or another clip) adds its numbers after " | ref " and hints: each names controls with amounts solved on this clip\'s own grade (+/− add to the value, × multiplies it; damped to undershoot). Apply them top-down; after an exposure or Balance (temperature/tint) hint, measure again before the rest, since brightness and white balance move every other number (a brightness hint comes alone). One zone gets a wheel hint a round (each wheel moves every zone). Saturation is told from a cast by the chroma spread; a hint\'s curve x is the hue the HSL curves read (working-space hue on nodes-v2, up to 13° off the display hue regions show). regions:[{name,x,y,w,h}] (fractions, top-left origin; ref:{x,y,w,h} if framed elsewhere) measures boxes; images:true shows both pictures with them.',
    'Looks: act applyColorLook(node, look, strength 0..1 = 1), on the Look node, replaces its primaries, wheels, log wheels, mixer and curves (and film keys when the look has film); exposure/temperature/tint, windows, qualifier, mask and effects stay. One undo; plain parameters after. Strength .5–.8 is often enough. Looks:',
    ...COLOR_LOOKS.map(l => `- ${l.id}${l.group === 'Looks' ? '' : l.group === 'Film stocks' ? ' (stock)' : ' (b&w)'}: ${l.about}`),
    'Recipes:',
    '- new node before the output: act{select:["@clip"], do:[["selectNode",null],["addNode","Sky",{pivot:.336,…parameters}]]} (legacy clips: no pivot); after a given node: ["selectNode","@node"] first. The reply prints "+ node @id".',
    '- adjust: act{do:[["updateNode","@node",{parameters:{exposure:.3,saturation:115}}]]}; bypass {enabled:false}; rename {name:"Skin"}.',
    '- sky: a node with {pivot:.336, gradOn:1, gradY:.45, gradSoft:.35, exposure:-.4, temperature:-300, saturation:110} darkens and cools above y .45; put gradY on the horizon and check with frame{}.',
    '- vignette: filmVignette 15–30 on the Look node (lens falloff); off-centre or shaped: a node with {pivot:.336, circOn:1, circInvert:1, circX:.5, circY:.45, circW:.8, circH:.55, circSoft:.4, exposure:-.5}.',
    '- skin: a node with {pivot:.336, qualOn:1, qualHue:35, qualHueWidth:30, qualHueSoft:20, qualSatLow:1, qualSatHigh:15, qualLumLow:10, qualLumHigh:80} (nodes-v2; legacy qualSatLow 8, qualSatHigh 55), then warm or calm it (logMidR .005, saturation 95, boost -10); add a circle around the face when the background has skin tones.',
    '- teal and orange: applyColorLook(node,"teal-amber",.7), or by hand on the Look node {logShadowR:-.012, logShadowB:.012, logHighRange:.45, logHighlightR:.01, logHighlightB:-.008, saturation:105} plus HueSat down at the greens (x .35); keep skin natural (color-measure a skin region).',
    '- film look: act{do:[["applyColorLook","@look","kodak-2383",.7]]}, then filmGrain, filmHalation, filmBloom by eye with frame{}.',
    '- black and white: applyColorLook(node,"tri-x") (red-filter mix, grain) or "soft-silver"; or mixMono 1 with your own R row.',
    '- match a reference picture: 1) job color-measure{clip, ref:"/abs/target.png", images:true}; 2) apply the hints top-down (Balance takes exposure, temperature, tint and the wheel amounts; Look contrast and saturation) and stop after an exposure or Balance hint; 3) frame{} to look, measure again, repeat until the hints are gone (on test scenes a +1 stop or +1500 temperature ref matched in two rounds, skin and a grey card within 2 units). By hand: exposure → white balance → contrast, shadows/highlights → colour per zone (log wheels) → saturation, boost, density → single hues (HSL curves, qualifier) → film texture by eye. A generated reference shows a direction: never clip skin or crush faces to hit its numbers. Then copyGrade/pasteGrade or a color group to similar shots and measure each (ref:"@clip" matches one shot to another).',
    '- order: reorderNode(node,-1|1) · moveColorNode(node, beforeNode|null=end) · removeNode(node) · arrangeColorNodes(clip) tidies the graph.',
    '- copy a grade: act{do:[["copyGrade","@from"],["pasteGrade","@to1"],["pasteGrade","@to2"]]} (replaces all nodes, source settings and node keyframes on each target, and its Noise Reduction when @from has one; same project).',
    '- highlights clipping on a log grade: useAcesOutput(clip) (color-grade suggests it when it applies).',
    '- source: updateProperty(clip,"inputProfile",gamma) and updateProperty(clip,"inputGamut",gamut), both, from the lists below (nothing checks them; a bad one breaks every render), before initializeColorGrade, which builds the Input CST from them · "dataLevels" Auto|Full|Video. Legacy clips only: inputExposure −6..6, inputTemperature −2000..2000.',
    '- imported DaVinci look: restoreResolveGrade(clip) brings it back (removes the nodes); updateProperty(clip,"bypassResolveLook",true) turns it off.',
    '- normalize & group: job color-normalize{clips, group?:"Name"|"cg-…"|null, clean?} sets every shot\'s Balance so they match (clean:true rebuilds each grade; snapshot first). A color group is one shared node after Balance on every member ([group cg-…] in color-grade): updateColorGroup("cg-…",{parameters,curves?,enabled?}) or updateNode on any member\'s group node changes all; renameColorGroup(id,name); setColorGroup([clips],{id}|{name}|null).',
    'Parameters (key default (UI range unit; render = what preview/export accept when wider) doc):',
    ...parameterLines(),
    '## Formats',
    'Curves: updateNode(node,{curves:{RGB?,R?,G?,B?, HSL keys?}}) replaces all curves ({} clears). Each {mode:"smooth"|"linear", points:[{id,x,y,slope?}]}: 2–64 points, unique ids, x ascending (gap ≥.0001), first x=0, last x=1, x/y 0..1, slope −20..20. RGB runs first, then the channel. S-curve: {RGB:{mode:"smooth",points:[{id:"a",x:0,y:0},{id:"b",x:.25,y:.2},{id:"c",x:.75,y:.8},{id:"d",x:1,y:1}]}}',
    'Effects: updateNode(node,{effects:[…]}) replaces the node\'s whole list (≤16); read it first with get{id:"@node",path:"effects"}. A node holding a LUT: change its list through job color-lut{node, effects} instead (act cannot carry LUT data).',
    'CST: {id:"fx-<any unique>",type:"cst",enabled:true,inputGamma,inputGamut,outputGamma,outputGamut,toneMapping:"none"|"shoulder"|"aces2",gamutMapping:"none"|"compress"}. Input = the signal at that point. aces2 (ACES 2 SDR 100 nits) needs output Gamma 2.4/Rec.709 and gamutMapping none, a nodes-v2 clip, one per grade, and the grade must end in Gamma 2.4/Rec.709.',
    `gammas: ${profiles.join(', ')} ("Rec.709" = legacy Gamma 2.4; "Apple Log" = iPhone 15 Pro+ log, gamut Rec.2020)`,
    `gamuts: ${gamuts.join(', ')}`,
    'LUT: job color-lut{node, file:"/abs/look.cube"} (2–65 per axis, ≤32 MB). inputGamma/inputGamut only label what the LUT expects (default: the working space); nothing is converted, so put a CST before it if they differ. amount 0..1.',
    'Masks (one per node): depth key updateNode(node,{mask:{source:"depth",enabled:true,invert:false,amount:100,near:50,far:100,softness:10}}) (distance 0 nearest..100 farthest, far ≥ near); a Smart Mask subject attachSmartMask(clip, maskId, node) (help masks); remove with updateNode(node,{mask:null}).',
    'Gotchas: a keyframed field (~ in color-grade) gets a keyframe at the playhead instead of a new static value (act at:<timeline seconds> picks the frame). Resolve-imported nodes may store capitalised keys (Exposure): write that spelling (get{id:"@node",path:"parameters"}), or the two keys clash. Never use applyGrade (legacy; appends after the output). act undo takes an edit back.',
    'Color Assistant: job color-looks{clips?, prompt?} needs nodes-v2 shots with verified camera input, ACES 2 output and effect-free nodes named exactly Balance and Look; color-grade says "assistant: ready". It runs minutes (poll), returns 3 looks; {job, apply:N} applies one to every shot it used (snapshot first).',
  ].join('\n');
}
export const topics: Record<string, string> = { color: colorTopic() };
