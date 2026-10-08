import assert from 'node:assert/strict';
import test from 'node:test';
import { assignFonts, checkFile, estimateSeconds, friendlyDuration, importCard, lanesFor, matchSources, measureSpeed, nameKey, places, walk, type Found } from './importer.ts';
import type { FcpImport } from '../state/models.ts';

const file = (name: string, size = 10, lastModified = 1) => new File([new Uint8Array(size)], name, { lastModified });
const found = (path: string, size?: number, lastModified?: number): Found => ({ path, file: file(path.split('/').at(-1)!, size, lastModified) });
const source = (id: string, sourcePath: string, extra = {}) => ({ id, name: sourcePath.split('/').at(-1)!, sourcePath, ...extra });

test('matchSources: the longest path suffix wins; copies are one file; real ties go to the chooser', () => {
  const card = '/Volumes/SD CARD/DCIM/100CANON/C0001.MP4';
  const [best] = matchSources([source('a', card)], [found('Desktop/Footage/C0001.MP4'), found('SD CARD/DCIM/100CANON/C0001.MP4')]);
  assert.deepEqual([best.state, best.found?.path, best.weak], ['found', 'SD CARD/DCIM/100CANON/C0001.MP4', undefined]);
  // macOS ignores case, and hands the browser decomposed names while the XML's are composed.
  const [accent] = matchSources([source('b', '/Users/maya/Movies/Café/Clip.mov')], [found('Café/CLIP.MOV'.normalize('NFD'))]);
  assert.deepEqual([accent.state, accent.weak], ['found', undefined]);
  // Two cards with the same layout: the volume name decides.
  const cards = matchSources([source('x', '/Volumes/CARD A/DCIM/100CANON/C0001.MP4'), source('y', '/Volumes/CARD B/DCIM/100CANON/C0001.MP4')],
    [found('CARD B/DCIM/100CANON/C0001.MP4', 20), found('CARD A/DCIM/100CANON/C0001.MP4', 10)]);
  assert.deepEqual(cards.map(m => [m.id, m.found?.path]), [['x', 'CARD A/DCIM/100CANON/C0001.MP4'], ['y', 'CARD B/DCIM/100CANON/C0001.MP4']]);
  const [copy] = matchSources([source('c', '/Users/maya/Desktop/A001.mov')], [found('Backup/A001.mov', 5, 7), found('Other/A001.mov', 5, 7)]);
  assert.deepEqual([copy.state, copy.found?.path, copy.weak], ['found', 'Backup/A001.mov', true], 'identical copies are picked silently; a name-only match is weak');
  // Two clips called C0001.MP4 from two cards never take one file: dragging card 1 alone finds only card 1's clip, and a
  // loose copy both claim equally goes to neither, so card 2's stays missing until card 2 is dropped.
  const two = [source('c1', '/Volumes/CARD 1/PRIVATE/M4ROOT/CLIP/C0001.MP4'), source('c2', '/Volumes/CARD 2/PRIVATE/M4ROOT/CLIP/C0001.MP4')];
  assert.deepEqual(matchSources(two, [found('CARD 1/PRIVATE/M4ROOT/CLIP/C0001.MP4')]).map(m => [m.id, m.state]), [['c1', 'found'], ['c2', 'missing']]);
  assert.deepEqual(matchSources(two, [found('C0001.MP4')]).map(m => m.state), ['missing', 'missing']);
  assert.deepEqual(matchSources(two, [found('C0001.MP4'), found('CARD 2/PRIVATE/M4ROOT/CLIP/C0001.MP4')]).map(m => [m.id, m.state, m.found?.path]), [['c1', 'missing', undefined], ['c2', 'found', 'CARD 2/PRIVATE/M4ROOT/CLIP/C0001.MP4']]);
  const [tie] = matchSources([source('d', '/Users/maya/Desktop/A001.mov')], [found('Backup/A001.mov', 5), found('Other/A001.mov', 6)]);
  assert.deepEqual([tie.state, tie.candidates?.map(c => c.path)], ['ambiguous', ['Backup/A001.mov', 'Other/A001.mov']]);
  const rest = matchSources([source('e', '/Users/maya/gone.mov'), source('f', '/Users/maya/here.mov', { uploaded: true })], []);
  assert.deepEqual(rest, [{ id: 'e', state: 'missing' }], 'what the server has is not looked for');
  assert.equal(nameKey('CLIP.MOV'.normalize('NFD')), 'clip.mov');
});

test('places: libraries, drives and home folders, at most 6 rows, with Finder breadcrumbs', () => {
  const rows = places([
    source('a', '/Users/maya/Movies/School Library.fcpbundle/4-10-26/Original Media/A001.mov'), source('b', '/Users/maya/Movies/School Library.fcpbundle/4-11-26/Original Media/A002.mov'),
    source('c', '/Volumes/Edit Drive/Libraries/Film.fcpbundle/E/Original Media/B001.mov'),
    source('d', '/Volumes/SD CARD/DCIM/100CANON/C0001.MP4'), source('e', '/Volumes/SD CARD/DCIM/101CANON/C0100.MP4'),
    source('f', '/Volumes/CARD 2/C0002.MP4'),
    source('g', '/Users/maya/Desktop/Footage/x.mov'), source('h', '/Users/maya/Documents/School/Music/song.wav'),
    source('i', '/Users/maya/Desktop/y.mov'),
  ]);
  const by = (id: string) => rows.find(r => r.ids.includes(id))!;
  assert.deepEqual(by('a'), { kind: 'library', label: 'Your Final Cut library **School Library**', hint: 'in Movies', path: '/Users/maya/Movies/School Library.fcpbundle',
    crumbs: ['Macintosh HD', 'Users', 'maya', 'Movies', 'School Library'], sidebar: 'Movies', item: 'School Library', ids: ['a', 'b'] });
  assert.deepEqual([by('c').label, by('c').hint, by('c').crumbs], ['Your Final Cut library **Film**', 'on the drive Edit Drive', ['Edit Drive', 'Libraries', 'Film']]);
  assert.deepEqual([by('d').kind, by('d').label, by('d').hint, by('d').path, by('d').ids], ['drive', 'The folder **DCIM** on the drive **SD CARD**', 'plug it in first', '/Volumes/SD CARD/DCIM', ['d', 'e']]);
  assert.equal(by('f').label, 'The drive **CARD 2**');
  // Desktop and Documents are two places; a group never rises above the top of the home folder.
  assert.deepEqual([by('g').label, by('g').ids, by('h').label, by('h').sidebar], ['Your **Desktop**', ['g', 'i'], 'The folder **Music** in Documents', 'Documents']);
  assert.equal(rows.length, 6);
  assert.equal(places([source('o', '/private/footage/a.mov')])[0].label, 'The folder **footage**');
  // A seventh place: libraries merge into their folder and the drive's places into the drive.
  const merged = places(Array.from({ length: 7 }, (_, i) => source(`l${i}`, `/Users/maya/Movies/L${i}.fcpbundle/E/Original Media/A.mov`)));
  assert.deepEqual(merged.map(r => [r.kind, r.label, r.ids.length]), [['folder', 'Your **Movies**', 7]]);
});

/** A dropped folder of fake FileSystemEntries; `reads` counts readEntries calls and `opened` the files opened. */
function tree(spec: Record<string, unknown>, log = { reads: 0, opened: [] as string[], walked: [] as string[] }, name = 'root'): any {
  const children = Object.entries(spec).map(([child, value]) => value && typeof value === 'object' ? tree(value as Record<string, unknown>, log, child)
    : { name: child, isFile: true, isDirectory: false, file: (ok: (f: File) => void, fail: (e: unknown) => void) => { log.opened.push(child); value === 'broken' ? fail(new DOMException('gone', 'NotFoundError')) : ok(file(child)); } });
  return { name, isFile: false, isDirectory: true, log, createReader: () => {
    log.walked.push(name); let at = 0;
    return { readEntries: (ok: (batch: unknown[]) => void) => { log.reads++; ok(children.slice(at, at += 100)); } };
  } };
}

test('walk: reads every batch, skips caches and hidden files, opens only wanted names', async () => {
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`f${i}.mov`, 'x']));
  const root = tree({ 'Original Media': { 'A001.mov': 'x', '._A001.mov': 'x', ...many }, 'Render Files': { 'A001.mov': 'x' }, '.Trashes': { 'A001.mov': 'x' }, 'B.mov': 'broken', 'C.mov': 'x' }, undefined, 'School Library.fcpbundle');
  const counts: number[] = [];
  const result = await walk([root], new Set(['a001.mov', 'b.mov', 'c.mov']), n => counts.push(n));
  assert.deepEqual(result.map(r => r.path).sort(), ['School Library.fcpbundle/C.mov', 'School Library.fcpbundle/Original Media/A001.mov']);
  assert.deepEqual(root.log.opened.sort(), ['A001.mov', 'B.mov', 'C.mov'], 'only wanted names are opened; a failing one is skipped');
  assert.deepEqual(root.log.walked, ['School Library.fcpbundle', 'Original Media'], 'caches and hidden folders are never walked');
  assert.equal(root.log.reads, 2 + 4, 'readEntries until an empty batch: 100 + 100 + 50 + 0 in the big folder');
  assert.deepEqual(counts, [100, 200, 255], "the hidden file and skipped folders count as nothing");
  // Too many entries: tell the person to drag a smaller folder.
  const endless = { name: 'Macintosh HD', isFile: false, isDirectory: true, createReader: () => ({ readEntries: (ok: (batch: unknown[]) => void) => ok(Array.from({ length: 100 }, (_, i) => ({ name: `n${i}`, isFile: true, isDirectory: false }))) }) };
  await assert.rejects(walk([endless as never], new Set()), /That's a lot of files/);
});

test('assignFonts follows fcp.sh: a file supplies every family that starts its name; a row pick forces the family', () => {
  const { uploads, unmatched } = assignFonts(['Futura PT', 'Barlow Condensed', 'Futura', '日本'], [file('FuturaPT-Bold.otf'), file('BarlowCondensed-Bold.ttf'), file('Arial-Bold.ttf')]);
  assert.deepEqual(uploads.map(u => [u.name, u.families]), [['FuturaPT-Bold', ['Futura PT', 'Futura']], ['BarlowCondensed-Bold', ['Barlow Condensed']]]);
  assert.deepEqual(unmatched.map(f => f.name), ['Arial-Bold.ttf'], 'a family with no letters or digits matches nothing');
  assert.deepEqual(assignFonts(['Futura PT'], [file('MyType.otf')], 'Futura PT').uploads.map(u => [u.name, u.families]), [['Futura PT', ['Futura PT']]]);
});

test('estimates: the worked example, one giant clip, a resume, lanes and friendly times', () => {
  assert.equal(Math.round(estimateSeconds([4.8e9], 6.1e6, 6.1e6, 4)), 850);
  assert.equal(friendlyDuration(estimateSeconds([4.8e9], 6.1e6, 6.1e6, 4)), 'about 14 minutes');
  // Evenly spread files keep the link full: 4.8 GB / 6 MB/s × 1.08. 5 GB with one 3 GB interview takes twice as long,
  // since the interview ends alone at one stream's 2 MB/s.
  assert.equal(Math.round(estimateSeconds(Array(48).fill(1e8), 2e6, 6e6, 4)), 864);
  assert.equal(Math.round(estimateSeconds([3e9, ...Array(20).fill(1e8)], 2e6, 6e6, 4)), 1728);
  assert.equal(friendlyDuration(estimateSeconds([1.1e9], 6.1e6, 6.1e6, 4)), 'about 3 minutes', 'a resume times only what is left');
  assert.deepEqual([lanesFor(4e5, 10), lanesFor(1e6, 10), lanesFor(1.49e6, 10), lanesFor(1.5e6, 10), lanesFor(6e6, 10), lanesFor(6e6, 2), lanesFor(6e6, 0)], [1, 2, 2, 3, 4, 2, 1]);
  assert.deepEqual([30, 60, 850, 5400, 7200, 7800].map(friendlyDuration), ['less than a minute', 'about 1 minute', 'about 14 minutes', 'about 1 hour 30 minutes', 'about 2 hours', 'about 2 hours 10 minutes']);
});

test('checkFile: unreadable, too big, a different clip, and lengths it cannot judge', async () => {
  const gone = { size: 5, slice: () => ({ arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError')) }) } as unknown as File;
  assert.deepEqual(await checkFile(gone, 'video', 48, 100), { state: 'unreadable' });
  assert.deepEqual(await checkFile(file('A.mov', 200), 'video', 48, 100), { state: 'tooBig' });
  const length = (seconds?: number) => async () => seconds;
  assert.deepEqual(await checkFile(file('C0001.MP4'), 'video', 48, 100, length(12)), { state: 'different', seconds: 12 });
  assert.deepEqual(await checkFile(file('C0001.MP4'), 'video', 100, 100, length(100.9)), { state: 'ok' }, 'within 1%');
  assert.deepEqual(await checkFile(file('C0001.MP4'), 'audio', 20, 100, length(20.4)), { state: 'ok' }, 'within half a second');
  assert.deepEqual(await checkFile(file('C0001.MXF'), 'video', 48, 100, length(undefined)), { state: 'ok' }, 'a codec the browser cannot read');
  assert.deepEqual(await checkFile(file('still.png'), 'image', 0, 100, length(3)), { state: 'ok' });
});

test('measureSpeed: one stream then up to four, warm-ups dropped; a failed probe assumes school Wi-Fi', async t => {
  let inFlight = 0, most = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.match(url, /^\/api\/uploads\/probe\?project=fcp-1$/);
    most = Math.max(most, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, 10));
    inFlight--;
    return Response.json({ bytes: 2 * 1024 * 1024, room: 5e9 });
  });
  const samples: number[] = [];
  const speed = await measureSpeed(3, { project: 'fcp-1', onSample: s => samples.push(s), phases: [60, 80] });
  assert.equal(speed.measured, true); assert.equal(speed.room, 5e9); assert.equal(most, 3);
  assert.ok(speed.single > 1e7 && speed.parallel > speed.single, JSON.stringify(speed));
  assert.ok(samples.length > 3 && samples.every(s => s > 0));
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(await measureSpeed(3), { single: 1.5e6, parallel: 1.5e6, room: undefined, measured: false });
});

test('importCard: what a Projects card says in each phase, and nothing a day after done', () => {
  const now = 1e12, base: FcpImport = { by: 'maya', phase: 'uploading', total: 4.8e9, received: 2.0e9, files: 38, uploaded: 10, ready: 0, failed: 0, rate: 5.2e6, startedAt: now - 6e5, updatedAt: now };
  const at = (patch: Partial<FcpImport>, who = 'Maya Chen') => importCard({ ...base, ...patch }, who, now);
  assert.deepEqual(at({}), { phase: 'uploading', title: '**Maya Chen** is importing a project from Final Cut', detail: '41% · 2.0 GB of 4.8 GB · about 9 min left', progress: 41, label: 'Maya Chen is importing a project from Final Cut, 41 percent' });
  assert.equal(at({ rate: 0, total: 3e8, received: 1.5e8 }, '')!.title, "You're importing a project from Final Cut");
  assert.equal(at({ rate: 0, total: 3e8, received: 1.5e8 }, '')!.detail, '50% · 150.0 MB of 300.0 MB', 'no time left without a measured rate');
  assert.equal(at({ rate: 0, total: 22_000, received: 11_000 })!.detail, '50% · 11 KB of 22 KB', 'sizes read as the importer page says them');
  assert.equal(at({ rate: 1e9 })!.detail, '41% · 2.0 GB of 4.8 GB · less than a minute left');
  assert.deepEqual(at({ phase: 'paused' }), { phase: 'paused', title: "Paused · waiting for Maya Chen's Mac", detail: '41%', progress: 41, label: "Import paused at 41 percent, waiting for Maya Chen's Mac" });
  assert.equal(at({ phase: 'paused' }, '')!.title, 'Paused · waiting for your Mac');
  assert.deepEqual(at({ phase: 'processing', received: 4.8e9, uploaded: 38, ready: 12 }), { phase: 'processing', title: 'Getting it ready', detail: '12 of 38 clips ready', progress: 1200 / 38, label: 'Getting it ready, 12 of 38 clips ready' });
  assert.deepEqual(at({ phase: 'stopped' }), { phase: 'stopped', title: 'Import stopped at 41%', detail: 'Maya Chen can finish it at sharedcut.com/importer', progress: undefined, label: 'Import stopped at 41 percent' });
  assert.equal(at({ phase: 'stopped' }, '')!.detail, 'You can finish it at sharedcut.com/importer');
  assert.deepEqual(at({ phase: 'ready', doneAt: now - 3_600_000, failed: 3 }), { phase: 'ready', title: 'New from Final Cut', detail: '3 clips need attention', progress: undefined, label: 'New from Final Cut, 3 clips need attention' });
  assert.equal(at({ phase: 'ready', doneAt: now - 3_600_000, failed: 1 })!.detail, '1 clip needs attention');
  assert.equal(at({ phase: 'ready', doneAt: now - 3_600_000 })!.label, 'New from Final Cut');
  assert.equal(at({ phase: 'ready', doneAt: now - 86_400_001 }), undefined, 'a day after it finished the card is an ordinary card');
  assert.equal(at({ phase: 'ready' }), undefined, 'ready without doneAt shows nothing');
  assert.equal(at({ total: 0, received: 0 })!.progress, 0);
});
