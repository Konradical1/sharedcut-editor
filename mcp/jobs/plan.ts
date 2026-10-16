// Plan: the open project's scripts, shot list and mood board as token-lean reads (job plan), and the script files. The
// .docx/.fountain/.html are built from the store with the editor's own src/services/screenplay.ts (no server route, like
// subtitles), and a Fountain or plain-text import runs as one batch. Every line, shot and card edit is act; see help plan.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { store, edit, handle, shown, need, project, done, type JobDef } from './kit.ts';
import { cap } from '../edit.ts';
import { quote } from '../views.ts';
import { ordered, sceneNumbers, SCRIPT_BLOCK_KINDS, SCRIPT_FORMATS } from '../../src/services/plan.ts';
import { pageCount, parseFountain, toDocx, toFountain, toHtml, type ScriptDoc } from '../../src/services/screenplay.ts';
import { groupShots, shotTakes, SHOT_MOVES, SHOT_SIZES } from '../../src/services/shots.ts';
import type { Script, ScriptFormat } from '../../src/state/models.ts';

const EXTENSIONS: Record<string, string[]> = { docx: ['docx'], fountain: ['fountain', 'txt'], html: ['html', 'htm'] };
const local = (raw: string) => resolve(raw.replace(/^~(?=$|[\\/])/, homedir()));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const own = <T extends { projectId: string }>(rows: T[]) => { const id = project().id; return rows.filter(x => x.projectId === id); };
const scriptsOf = () => ordered(own(store.getState().scripts));
const linesOf = (script: Script) => ordered(own(store.getState().scriptBlocks).filter(b => b.scriptId === script.id));
const summary = (x: Script) => `${handle(x.id)} ${quote(x.name, 60)} ${x.format} · ${plural(linesOf(x).length, 'line')}`;

/** The script a job names (@handle or name), else the project's only one. */
function pick(wanted: unknown): Script {
  const scripts = scriptsOf();
  if (wanted !== undefined && wanted !== '') {
    const text = String(wanted), hit = scripts.find(x => x.id === text) ?? scripts.find(x => x.name.toLowerCase() === text.toLowerCase());
    if (!hit) throw new Error(`No script ${JSON.stringify(shown(text))} in this project. job plan{} lists them.`);
    return hit;
  }
  if (scripts.length === 1) return scripts[0];
  throw new Error(scripts.length ? `This project has ${scripts.length} scripts; pass script:@handle (job plan{} lists them).` : 'No script yet. act addScript(name?, format?) makes one; help plan.');
}
/** What the exports print: the script's lines in order, by its author line, else the signed-in user. */
function docOf(script: Script): ScriptDoc {
  const s = store.getState(), author = script.author ?? s.users.find(u => u.id === s.currentUserId)?.name;
  return { name: script.name, format: script.format, ...(script.credit ? { credit: script.credit } : {}), ...(author ? { author } : {}), blocks: linesOf(script).map(({ kind, text }) => ({ kind, text })) };
}

function scriptView(wanted: unknown, scene?: number) {
  const scripts = scriptsOf();
  if (!scripts.length) return 'No script yet. act addScript(name?, format?) makes one; help plan.';
  if ((wanted === undefined || wanted === '') && scripts.length > 1) return [`${scripts.length} scripts; job plan{script:@handle} shows one:`, ...scripts.map(summary)].join('\n');
  const script = pick(wanted), blocks = linesOf(script), numbers = sceneNumbers(blocks);
  // Lines before the first heading are scene 0.
  let at = 0;
  const rows = blocks.map(b => ({ b, scene: b.kind === 'scene' ? at = numbers.get(b.id)! : at })).filter(r => scene === undefined || r.scene === scene);
  const head = `${summary(script)} · ~${plural(pageCount(docOf(script)), 'page')}${script.credit ? ` · credit ${quote(script.credit)}` : ''}${scene !== undefined ? ` · scene ${scene}${rows.length ? '' : ' (none)'}` : ''}`;
  return cap([head, ...rows.map(({ b }) => `${handle(b.id)} ${b.kind.toUpperCase()}${b.kind === 'scene' ? ` ${numbers.get(b.id)}` : ''} ${quote(b.text, 120)}`)].join('\n'), 'narrow with scene:n; get{id:@line} has a line in full');
}

function shotsView() {
  const s = store.getState(), shots = own(s.shots), groups = groupShots(shots, own(s.scripts), own(s.scriptBlocks));
  if (!groups.length) return 'No shots or scenes yet. act addShot({sceneId?, text?, size?, movement?}) adds one; help plan.';
  const finished = shots.filter(x => x.done).length, takesOf = shotTakes(shots, s.media), out = [`${plural(shots.length, 'shot')}${finished ? ` · ${finished} done` : ''}`];
  for (const group of groups) {
    out.push(`${group.label}${group.sceneId ? ` ${handle(group.sceneId)}` : ''}${group.shots.length ? '' : ' (no shots)'}`);
    for (const x of group.shots) {
      const takes = takesOf.get(x.id) ?? [];
      out.push(`  ${handle(x.id)} ${[x.number, x.size, x.movement].filter(Boolean).join(' ')}${x.text ? ` ${quote(x.text, 80)}` : ''}${x.cast ? ` · cast ${quote(x.cast, 30)}` : ''}${x.location ? ` · at ${quote(x.location, 30)}` : ''}${x.notes ? ` · notes ${quote(x.notes, 40)}` : ''}${takes.length ? ` · takes ${takes.map(handle).join(' ')}` : ''}${x.done ? ' · done' : ''}`);
    }
  }
  return cap(out.join('\n'), 'get{id:@shot} has a shot in full');
}

function boardView() {
  const s = store.getState(), cards = own(s.boardItems).sort((a, b) => a.z - b.z), name = (id: string) => s.media.find(m => m.id === id)?.name ?? '?';
  if (!cards.length) return 'The mood board is empty. act addBoardItems([{kind, …}]) adds cards; help plan.';
  const r = Math.round;
  return cap([`${plural(cards.length, 'board card')}, bottom to top:`, ...cards.map(c => `${handle(c.id)} ${c.kind}${c.mediaId ? ` ${handle(c.mediaId)} ${quote(name(c.mediaId), 30)}` : ''}${c.text ? ` ${quote(c.text, 60)}` : ''}${c.color ? ` ${c.color}` : ''} at ${r(c.x)},${r(c.y)} ${r(c.w)}x${r(c.h)}`)].join('\n'), 'get{id:@card} has a card in full');
}

export const jobs: Record<string, JobDef> = {
  plan: {
    doc: '{view?:script|shots|board, script?, scene?:n} reads the open project\'s Plan with @handles: script lines (scene narrows), shots by scene with their takes, or board cards. help plan',
    async start(params) {
      const view = params.view ?? 'script';
      if (view === 'shots') return done(shotsView());
      if (view === 'board') return done(boardView());
      if (view !== 'script') throw new Error('params.view is script, shots or board.');
      return done(scriptView(params.script, params.scene === undefined ? undefined : need<number>(params, 'scene', 'number')));
    },
  },
  'script-export': {
    doc: '{path, format?:docx|fountain|html, script?} writes a script to a local file (a folder gets "<name>.<ext>"); docx opens in Word or Google Docs, html prints to PDF',
    async start(params) {
      const raw = need(params, 'path'), ext = extname(raw).slice(1).toLowerCase();
      const format = params.format === undefined ? Object.keys(EXTENSIONS).find(f => EXTENSIONS[f].includes(ext)) ?? 'docx' : String(params.format).toLowerCase();
      if (!EXTENSIONS[format]) throw new Error('params.format is docx, fountain or html.');
      const script = pick(params.script), doc = docOf(script);
      let path = local(raw);
      if (/[\\/]$/.test(raw) || existsSync(path) && statSync(path).isDirectory()) path = join(path, `${script.name.replace(/[\\/:*?"<>|]/g, '_') || 'Script'}.${format}`);
      else if (!EXTENSIONS[format].includes(ext)) path += `.${format}`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, format === 'docx' ? toDocx(doc) : format === 'fountain' ? toFountain(doc) : toHtml(doc, { page: true }));
      return done(`Wrote ${handle(script.id)} ${quote(script.name)} (${plural(doc.blocks.length, 'line')}, ~${plural(pageCount(doc), 'page')}) to ${path}`);
    },
  },
  'script-import': {
    doc: '{path|text, script?, name?, format?:screenplay|stage} reads Fountain or plain text: appended to script, else a new script (name, else its title or file name); all or nothing → @script',
    async start(params) {
      if ((params.path === undefined) === (params.text === undefined)) throw new Error('Give params.path (a local .fountain or .txt file) or params.text, not both.');
      const file = params.path === undefined ? undefined : local(need(params, 'path'));
      const raw = file ? await readFile(file, 'utf8') : need<string>(params, 'text');
      // A .docx (a zip) or .pdf reads as bytes, and would save one junk line of them to the shared project.
      if (raw.includes('\u0000') || raw.startsWith('%PDF')) throw new Error('That is not a Fountain or plain-text file (.docx and .pdf do not import).');
      const parsed = parseFountain(raw);
      if (!parsed.blocks.length) throw new Error('No script text found to import.');
      const format = (params.format ?? 'screenplay') as ScriptFormat;
      if (!SCRIPT_FORMATS.includes(format)) throw new Error(`params.format is ${SCRIPT_FORMATS.join(' or ')}.`);
      const into = params.script === undefined ? undefined : pick(params.script);
      const name = params.name === undefined ? parsed.title ?? (file && basename(file, extname(file))) : need(params, 'name');
      // "@@x" is the literal "@x" to act: a line or name that reads like a handle stays text.
      const literal = (text: string) => /^@[@\w-]+$/.test(text) ? `@${text}` : text;
      const blocks = parsed.blocks.map(b => ({ kind: b.kind, text: literal(b.text) }));
      const { text, value: id } = await edit(async run => {
        const id = into?.id ?? await run('addScript', name === undefined ? undefined : literal(name), format) as string | undefined;
        if (!id) throw new Error('Could not create the script.');
        const starter = into ? undefined : store.getState().scriptBlocks.find(b => b.scriptId === id);
        // ponytail: addScriptBlocks takes 5000 lines a call (store.ts); a longer import is several steps of this one batch.
        for (let i = 0; i < blocks.length; i += 5000) await run('addScriptBlocks', id, blocks.slice(i, i + 5000));
        // A new script starts with one empty scene heading; the import brings its own.
        if (starter) await run('deleteScriptBlocks', [starter.id]);
        if (!into && (parsed.credit || parsed.author)) await run('updateScript', id, { ...(parsed.credit ? { credit: literal(parsed.credit) } : {}), ...(parsed.author ? { author: literal(parsed.author) } : {}) });
        return id;
      });
      const kinds = SCRIPT_BLOCK_KINDS.map(k => [k, blocks.filter(b => b.kind === k).length] as const).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`);
      const script = store.getState().scripts.find(x => x.id === id);
      return done([`${handle(id)} ${quote(script?.name ?? '?', 60)} · ${into ? 'added' : 'new script,'} ${plural(blocks.length, 'line')} (${kinds.join(', ')})`, ...text.split('\n').filter(line => line.startsWith('notes:'))].join('\n'));
    },
  },
};

export const topics: Record<string, string> = {
  plan: [
    'plan: the Plan workspace of the open project: scripts, a shot list and a mood board. Read with job plan{view}; edit with act; files with job script-export / script-import. Each act step is one undo.',
    `script: act addScript(name?, format?:"screenplay"|"stage") → @script holding one empty scene heading. addScriptBlocks(@script, [{kind, text}, …], afterId?) appends (null: at the top, @line: after it) → their ids. kinds: ${SCRIPT_BLOCK_KINDS.join('|')}.`,
    'a scene, one block per element: [{"kind":"scene","text":"INT. TENT – DAY"},{"kind":"action","text":"Maya wakes."},{"kind":"character","text":"MAYA"},{"kind":"parenthetical","text":"(groggy)"},{"kind":"dialogue","text":"What time is it?"},{"kind":"transition","text":"CUT TO:"}]',
    'lines: updateScriptBlock(@line, {kind?, text?}) · splitScriptBlock(@line, at) · mergeScriptBlock(@line) joins it onto the line above · deleteScriptBlocks([@line]). Script: updateScript(@script, {name?, format?, credit?, author?}) · deleteScript(@script).',
    `shots: addShot({sceneId?:@scene heading, text?, size?, movement?, cast?, location?, notes?, done?}, afterId?) numbers itself (1A, 1B under scene 1). updateShot(@shot, patch) ('' or sceneId null clears) · moveShot(@shot, afterId|null) · deleteShots([@shot]). size: ${SHOT_SIZES.join(', ')}. movement: ${SHOT_MOVES.join(', ')}.`,
    'takes: media named for a shot is its take with no step (3A_take2.mov, Shot 3A, sh03a match shot 3A); or act linkShotMedia(@shot, @media), false as a 3rd argument unlinks. job plan{view:"shots"} lists takes; the media list marks them shot 3A @….',
    'board: an image card needs an image or video in the project: job upload{paths:[image], bin:"board"} → @media in the Mood board bin like the editor, then addBoardItems([{kind:"image", mediaId:@media, x, y, w?, h?}]). Others: {kind:"note"|"text", text} · {kind:"swatch", color:"#rrggbb"}. updateBoardItems([{id, patch:{x,y,w,h,z,text,color}}]) · deleteBoardItems([ids]). x,y,w,h are board pixels.',
    'files: job script-export{path, format?} writes .docx (default; Google Docs opens it from Drive), .fountain (Highland, WriterDuet, Final Draft) or .html (print to PDF). job script-import{path|text} reads Fountain or plain text (plain paragraphs become action).',
  ].join('\n'),
};
