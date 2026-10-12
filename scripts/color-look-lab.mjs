// Look lab: runs the Three looks pipeline on real shots with a scripted answer instead of the model, to tune the look library
// (src/services/colorLooks.ts) by eye. Read-only on the data folder; clips not on an ACES 2 grade get the starter grade in memory.
//   node --experimental-strip-types scripts/color-look-lab.mjs <answer.json|-> <sheet.jpg> <clipId>... [--data dir] [--out dir]
// answer.json: { balance?: {exposure, temperature, tint, keepBalance} | [one per shot], options: [{recipe, strength, warmth?}] x3 }
// "-" asks the real model (FRAME_LINE_AI_PROVIDER, e.g. with --env-file=.env). Prints the shot lines the model reads, the
// engine's checks on the rendered looks, and writes a contact sheet: one row per previewed shot, before then looks 1-3.
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readWorkspace } from './workspace-db.mjs';
import { colorAssistantService } from '../server/colorAssistant.ts';
import { starterGrade } from '../src/services/color.ts';
import { eligibility } from '../src/services/colorAssistant.ts';

const args = process.argv.slice(2), flag = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const data = resolve(flag('data') ?? process.env.FRAME_LINE_DATA ?? 'data'), work = resolve(flag('out') ?? join(tmpdir(), 'sharedcut-look-lab'));
const [answerFile, sheetPath, ...ids] = args;
if (!answerFile || !sheetPath || !ids.length) { console.error('Usage: color-look-lab.mjs <answer.json|-> <sheet.jpg> <clipId>... [--data dir] [--out dir]'); process.exit(2); }
const db = new DatabaseSync(join(data, 'frameline.sqlite'), { readOnly: true }), s = readWorkspace(db).state; db.close();
const spec = answerFile === '-' ? null : JSON.parse(readFileSync(answerFile, 'utf8'));
let n = 0; const clips = [], media = [], nodes = [];
for (const id of ids) {
  const clip = structuredClone(s.clips.find(c => c.id === id)), asset = structuredClone(s.media.find(m => m.id === clip?.mediaId));
  if (!clip || !asset) { console.error(`No clip ${id} with media.`); process.exit(2); }
  let own = structuredClone(s.nodes.filter(x => x.clipId === id));
  if (!eligibility(clip, asset, own).ok) {
    clip.properties = { ...clip.properties, colorPipeline: 'nodes-v2', inputProfile: asset.inputProfile, inputGamut: asset.inputGamut };
    asset.cameraMetadataVersion = 2;
    own = starterGrade(clip, asset, () => `lab-${++n}`);
    for (const node of own) for (const e of node.effects ?? []) if (e.type === 'cst' && e.outputGamma === 'Gamma 2.4') Object.assign(e, { toneMapping: 'aces2', gamutMapping: 'none' });
  }
  clip.projectId = asset.projectId = 'lab'; for (const node of own) node.projectId = 'lab';
  clips.push(clip); media.push(asset); nodes.push(...own);
}
const balance = i => ({ exposure: 0, temperature: 0, tint: 0, keepBalance: false, ...(Array.isArray(spec.balance) ? spec.balance[i] : spec.balance) });
const answer = labels => ({ shots: labels.map((clipId, i) => ({ clipId, rationale: '', confidence: 1, warnings: [], ...balance(i) })),
  options: spec.options.map((o, i) => ({ intensity: ['natural', 'bold', 'extreme'][i], warmth: 0, name: o.recipe, description: '', ...o })) });
let calls = 0;
const service = colorAssistantService(work, ...(spec ? [async ({ prompt, schema }) => {
  if (calls++ === 0) console.log(prompt.split('\n').filter(l => /^S\d+ |^  (stops|white balance|now)/.test(l)).join('\n'));
  else console.log(prompt.split('\n').find(l => l.startsWith('REVIEW:'))?.replace(/^.*?\): /, 'checks: ').replace(/ \| /g, '\n  '));
  return answer(schema.properties.shots.items.properties.clipId.enum);
}] : []));
const started = Date.now(), { jobId } = service.start({ projectId: 'lab', body: { mode: 'looks', clipIds: ids, ...(process.env.STYLE && { prompt: process.env.STYLE }) }, clips, media, nodes, source: id => join(data, 'media', id, 'original') });
let job; for (;;) { job = service.get('lab', jobId); if (!['waiting', 'running'].includes(job.status)) break; await new Promise(r => setTimeout(r, 200)); }
await service.close();
if (job.status !== 'done') { console.error(job.status, job.error, JSON.stringify(job.skipped)); process.exit(1); }
console.log(`done in ${Math.round((Date.now() - started) / 1000)} s`);
for (const shot of job.result.shots ?? []) console.log('balance', ids.indexOf(shot.clipId) + 1, shot.balance ? `exposure ${shot.balance.exposure} temperature ${shot.balance.temperature} tint ${shot.balance.tint}` : 'kept', '|', shot.rationale);
for (const l of job.result.looks) console.log(`${l.intensity}: ${l.name} = ${l.recipe} ${l.strength} warmth ${l.warmth} | ${l.description}`);
const folder = join(work, 'color-assistant', 'lab', jobId), file = url => join(folder, url.split('/').at(-1));
const rows = job.result.stills.map(st => [st.before, ...st.after.map(a => a ?? st.before)].map(file));
const graph = rows.map((_, r) => `${[0, 1, 2, 3].map(c => `[${r * 4 + c}]`).join('')}hstack=4[r${r}]`).join(';') + (rows.length > 1 ? `;${rows.map((_, r) => `[r${r}]`).join('')}vstack=${rows.length}` : ';[r0]null');
execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', ...rows.flat().flatMap(i => ['-i', i]), '-filter_complex', graph, '-q:v', '2', resolve(sheetPath)]);
console.log('sheet', resolve(sheetPath), job.skipped.length ? JSON.stringify(job.skipped) : '');
