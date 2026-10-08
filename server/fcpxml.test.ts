import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fcpProjectId, fcpTime, fileUrlPath, importFcpxml, locateSource, parseXml, readFcpBundle } from './fcpxml.ts';
import { createFrameLineServer } from './index.ts';

// A 25 fps edit whose timeline starts at 01:00:00:00, exercising each structure the converter handles.
export const sample = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <resources>
    <format id="r1" name="FFVideoFormat1080p25" frameDuration="100/2500s" width="1920" height="1080"/>
    <format id="r2" name="FFVideoFormat2160p25" frameDuration="100/2500s" width="3840" height="2160"/>
    <asset id="r3" name="A" start="0s" duration="60s" hasVideo="1" hasAudio="1" format="r2"><media-rep kind="original-media" src="file:///Volumes/Shoot/Day%201/A&amp;B.mov"/></asset>
    <asset id="r4" name="B" start="3600s" duration="30s" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="file:///Volumes/Shoot/B.mov"/></asset>
    <asset id="r5" name="music" start="0s" duration="120s" hasAudio="1"><media-rep kind="original-media" src="file:///Users/editor/Music/song.wav"/></asset>
    <asset id="r9" name="photo" start="0s" duration="0s" hasVideo="1" format="r1"><media-rep kind="original-media" src="file:///Users/editor/photo.png"/></asset>
    <effect id="r6" name="Basic Title" uid=".../Titles.localized/Basic Title.moti"/>
    <effect id="r7" name="Cross Dissolve" uid="FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265"/>
    <media id="r8" name="Compound 1"><sequence format="r1" tcStart="0s" duration="4s"><spine>
      <asset-clip ref="r3" offset="0s" name="A inside" start="10s" duration="4s"/>
    </spine></sequence></media>
  </resources>
  <library><event name="Day 1"><project name="Edit" uid="P1"><sequence format="r1" duration="20s" tcStart="3600s">
    <spine>
      <asset-clip ref="r3" offset="3600s" name="A" start="5s" duration="10s">
        <adjust-transform position="10 -5" scale="1.5 1.5" rotation="15"/>
        <adjust-volume amount="-6dB"><param name="amount"><fadeIn type="easeIn" duration="1s"/></param></adjust-volume>
        <marker start="6s" duration="100/2500s" value="Beat"/>
        <asset-clip ref="r5" lane="-1" offset="5s" name="song" start="0s" duration="15s">
          <adjust-volume><param name="amount"><keyframeAnimation><keyframe time="0s" value="-96dB"/><keyframe time="2s" value="-12dB" interp="ease"/></keyframeAnimation></param></adjust-volume>
        </asset-clip>
        <title ref="r6" lane="1" offset="6s" name="Hello" start="0s" duration="2s">
          <param name="Position" key="9999/999166631/999166633/1/100/101" value="0 -300"/>
          <text><text-style ref="ts1">Hello &amp; welcome</text-style></text>
          <text-style-def id="ts1"><text-style font="Futura" fontSize="80" fontFace="Bold" fontColor="1 0 0 1" alignment="center"/></text-style-def>
        </title>
      </asset-clip>
      <transition name="Cross Dissolve" offset="3609.6s" duration="0.8s"><filter-video ref="r7" name="Cross Dissolve"/></transition>
      <asset-clip ref="r4" offset="3610s" name="B" start="3602s" duration="4s">
        <timeMap><timept time="3602s" value="3602s" interp="linear"/><timept time="3606s" value="3604s" interp="linear"/></timeMap>
      </asset-clip>
      <ref-clip ref="r8" offset="3614s" name="Compound 1" start="1s" duration="3s"/>
      <gap offset="3617s" name="Gap" start="0s" duration="3s">
        <asset-clip ref="r9" lane="1" offset="0.6s" name="photo" duration="2s"/>
      </gap>
    </spine>
  </sequence></project></event></library>
</fcpxml>`;

const near = (actual: unknown, expected: number, message?: string) => assert.ok(Math.abs(Number(actual) - expected) < 1e-6, `${message ?? ''} ${actual} ≠ ${expected}`);

test('FCPXML reading: times, file URLs, entities and damage', () => {
  near(fcpTime('1001/30000s'), 1001 / 30000); near(fcpTime('3600s'), 3600); near(fcpTime(undefined, 2), 2);
  assert.throws(() => fcpTime('10 frames'), /Unreadable/);
  assert.equal(fileUrlPath('file:///Volumes/Shoot/Day%201/A&B%20100%25.mov'), '/Volumes/Shoot/Day 1/A&B 100%.mov');
  assert.equal(fileUrlPath('file://localhost/Users/x/a.mov'), '/Users/x/a.mov');
  assert.equal(fileUrlPath('https://example.com/a.mov'), undefined);
  const [note, parsed] = parseXml('<?xml version="1.0"?><!DOCTYPE a><!-- note --><a x="&lt;&#65;&#x42;&apos;"><b>t &amp; u</b><![CDATA[<raw>]]></a>').children;
  assert.deepEqual([note.name, note.text], ['#comment', ' note '], 'comments are kept: Final Cut writes color CDLs in them');
  assert.equal(parsed.attrs.x, "<AB'"); assert.equal(parsed.children[0].text, 't & u'); assert.equal(parsed.text, '<raw>');
  assert.throws(() => parseXml('<a><b></a>'), /damaged/);
  assert.throws(() => parseXml('<a>'), /ends early/);
  assert.throws(() => importFcpxml('<fcpxml version="1.11"><resources/></fcpxml>', 'fcp-x', 'u'), /No project/);
  assert.throws(() => importFcpxml('<xmeml/>', 'fcp-x', 'u'), /not Final Cut XML/);
});

test('FCPXML → SharedCut: storyline, lanes, transforms, sound, retime, transitions, compounds, titles', () => {
  const r = importFcpxml(sample, 'fcp-test', 'owner');
  assert.equal(r.project.name, 'Edit'); assert.equal(r.project.resolution, '1920 × 1080'); near(r.project.fps, 25); near(r.project.duration, 20);
  const [edit, compound] = r.timelines;
  assert.ok(!edit.composition && compound.composition, 'the edit is listed before its composition');
  assert.deepEqual(r.media.map(m => [m.name, m.kind, m.sourcePath]), [
    ['A&B.mov', 'video', '/Volumes/Shoot/Day 1/A&B.mov'], ['song.wav', 'audio', '/Users/editor/Music/song.wav'], ['B.mov', 'video', '/Volumes/Shoot/B.mov'], ['photo.png', 'image', '/Users/editor/photo.png']]);
  const tracks = new Map(r.tracks.map(t => [t.id, t]));
  const on = (name: string, kind: string) => r.clips.filter(c => c.timelineId === edit.id && c.name === name && tracks.get(c.trackId)!.kind === kind);
  const track = (c: { trackId: string }) => tracks.get(c.trackId)!.name;

  const [aVideo] = on('A', 'video'), [aAudio] = on('A', 'audio');
  near(aVideo.start, 0); near(aVideo.duration, 10); near(aVideo.sourceIn, 5); assert.equal(track(aVideo), 'V1');
  near(aVideo.properties.x, 108, 'x = 10% of 1080'); near(aVideo.properties.y, 54, 'y flips'); near(aVideo.properties.zoom, 150); near(aVideo.properties.rotation, -15, 'counterclockwise → clockwise');
  assert.equal(aVideo.properties.audioDetached, true); assert.equal(aVideo.properties.linkGroup, aAudio.properties.linkGroup);
  near(aAudio.properties.gain, -6); near(aAudio.properties.audioFadeIn, 1); assert.equal(track(aAudio), 'A1');
  // The cross dissolve sits centred on the cut at 10 s; the sounds overlap into their handles and crossfade there.
  near(aAudio.duration, 10.4); near(aAudio.properties.audioFadeOut, .8);

  const [bVideo] = on('B', 'video'), [bAudio] = on('B', 'audio');
  near(bVideo.start, 10); near(bVideo.duration, 4); near(bVideo.sourceIn, 2, 'timecode-based asset start'); near(bVideo.properties.speed, 50);
  assert.equal(bVideo.transition, 'Cross dissolve'); near(bVideo.properties.transitionDuration, .8); assert.equal(bVideo.properties.transitionAlign, 'center');
  near(bAudio.start, 9.6); near(bAudio.duration, 4.4); near(bAudio.sourceIn, 1.8, '0.4 s earlier at half speed'); near(bAudio.properties.audioFadeIn, .8);
  assert.equal(track(bAudio), 'A2', 'the overlapping crossfade half takes its own track');

  const [song] = on('song', 'audio');
  near(song.start, 0); near(song.duration, 15); assert.equal(track(song), 'A3', 'lane -1 audio follows the storyline tracks');
  assert.deepEqual(song.keyframes!['properties.gain'].map(k => [k.time, k.value, k.interpolation]), [[0, -60, 'linear'], [2, -12, 'bezier']]);

  const [hello] = r.clips.filter(c => c.mediaId === 'frameline-title');
  near(hello.start, 1); near(hello.duration, 2); assert.equal(track(hello), 'V2');
  const doc = JSON.parse(String(hello.properties.textDocument));
  assert.equal(doc.runs[0].text, 'Hello & welcome'); assert.deepEqual([doc.runs[0].style.fontFamily, doc.runs[0].style.fontSize, doc.runs[0].style.fontWeight, doc.runs[0].style.color], ['Futura', 80, 700, '#ff0000']);
  assert.ok(doc.y > .5, 'a title placed below centre stays below centre');

  const [comp] = r.clips.filter(c => c.mediaId === 'frameline-composition');
  near(comp.start, 14); near(comp.duration, 3); near(comp.sourceIn, 1); assert.equal(comp.properties.compositionId, compound.id);
  const inner = r.clips.filter(c => c.timelineId === compound.id);
  assert.equal(inner.length, 2); near(inner[0].sourceIn, 10);

  const [photo] = r.clips.filter(c => c.name === 'photo');
  near(photo.start, 17.6); near(photo.duration, 2); near(photo.sourceIn, 0); assert.equal(track(photo), 'V2');
  assert.deepEqual(edit.markers!.map(m => [m.time, m.name]), [[1, 'Beat']]);
  assert.ok(r.warnings.some(w => /Basic Title/.test(w)), 'titles say what they lose');
  for (const t of r.timelines) for (const kind of ['video', 'audio']) {
    const clips = r.clips.filter(c => c.timelineId === t.id && tracks.get(c.trackId)?.kind === kind).sort((a, b) => a.start - b.start);
    for (const a of clips) for (const b of clips) if (a !== b && a.trackId === b.trackId) assert.ok(a.start + a.duration <= b.start + 1e-6 || b.start + b.duration <= a.start + 1e-6, `${a.name} overlaps ${b.name}`);
  }
});

// Shapes from a real Final Cut 11 export (BoySoccer, FCPXML 1.13): an audition, sub-frame audio edits, a split edit
// running past the picture, -96 dB camera sound, two stacked color board corrections with their ASC CDL comments.
const fieldExport = `<fcpxml version="1.13"><resources>
  <format id="r1" frameDuration="100/2400s" width="1920" height="1080"/>
  <format id="r13" frameDuration="1001/60000s" width="3840" height="2160"/>
  <asset id="r12" start="2038126090/60000s" duration="378378/60000s" hasVideo="1" hasAudio="1" format="r13"><media-rep kind="original-media" src="file:///M/7V5A6132.mp4"/></asset>
  <asset id="r4" start="0s" duration="5410816/44100s" hasAudio="1"><media-rep kind="original-media" src="file:///M/Lithe.mp3"/></asset>
  <asset id="r7" start="7385s" duration="33075/44100s" hasAudio="1"><media-rep kind="original-media" src="file:///M/Beep.wav"/></asset>
  <effect id="r9" name="Noise Reduction" uid="HENoiseReduction"/><effect id="r14" name="Color Correction" uid="FFColorCorrectionHDREffect"/><effect id="r8" name="Title Over Footage"/>
</resources><library><event name="E"><project name="BoySoccer"><sequence format="r1" duration="27870000/720000s" tcStart="0s"><spine>
  <gap offset="0s" duration="25200/2400s" start="658900/2400s">
    <asset-clip ref="r7" lane="-2" offset="9996389011/35280000s" start="260546094466/35280000s" duration="22229095/35280000s"/>
    <title ref="r8" lane="2" offset="680700/2400s" start="3600s" duration="13000/2400s">
      <param name="Position" value="-1029.11 -41.0994"/><param name="Bottom Margin" value="-171.255"/><param name="Position" value="-1033 58.5005"/><param name="Bottom Margin" value="-349.323"/>
      <param name="Alignment" value="0 (Left) 2 (Bottom)"/>
      <text><text-style ref="ts1">Jack matthews #15</text-style></text><text><text-style ref="ts3">Mens soccer</text-style></text>
      <text-style-def id="ts1"><text-style font="Bebas Neue" fontSize="278.9" fontFace="Regular" fontColor="1 1 1 1" lineSpacing="-95"/></text-style-def>
      <text-style-def id="ts3"><text-style font="Bebas Neue" fontSize="91.9" fontFace="Regular" fontColor="1 1 1 1"/></text-style-def>
    </title>
  </gap>
  <audition offset="25200/2400s">
    <asset-clip ref="r12" start="81531444/2400s" duration="4100/2400s">
      <conform-rate scaleEnabled="0" srcFrameRate="59.94"/>
      <adjust-volume amount="-96dB"/>
      <asset-clip ref="r4" lane="-2" offset="24459373200/720000s" start="29393612/720000s" duration="19830000/720000s" audioStart="29393612/720000s" audioDuration="20370000/720000s"/>
      <filter-video ref="r9" name="Noise Reduction"/>
      <filter-video ref="r14" name="Color Correction">
        <!-- info-asc-cdl: slope="1.1527 1.1527 1.1527" offset="-0.0627263 -0.0623002 -0.0638536" power="1.02651 0.993983 0.936511" -->
        <param name="Saturation Global" key="2004" value="0.852376"/>
      </filter-video>
      <filter-video ref="r14" name="Color Correction" enabled="0"><!-- info-asc-cdl: slope="2 2 2" offset="0 0 0" power="1 1 1" --></filter-video>
    </asset-clip>
    <title ref="r8" start="3600s" duration="2s"><text><text-style ref="x">ALTERNATE</text-style></text></title>
  </audition>
</spine></sequence></project></event></library></fcpxml>`;

test('a real Final Cut export: audition timing, sample-accurate sound, split edits, silence, color board CDLs, fonts', () => {
  const r = importFcpxml(fieldExport, 'fcp-field', 'owner', [{ id: 'FL-bebas', name: 'BebasNeue-Regular' }]);
  const tracks = new Map(r.tracks.map(t => [t.id, t])), kind = (c: { trackId: string }) => tracks.get(c.trackId)!.kind;
  const pick = r.clips.find(c => c.name === '7V5A6132.mp4' && kind(c) === 'video')!, pickSound = r.clips.find(c => c.name === '7V5A6132.mp4' && kind(c) === 'audio')!;
  near(pick.start, 10.5, 'the audition carries the pick\'s position'); near(pick.duration, 4100 / 2400); near(pick.sourceIn, 81531444 / 2400 - 2038126090 / 60000);
  assert.equal(r.clips.some(c => c.name === 'ALTERNATE'), false, 'only the active pick is imported');
  assert.equal(pickSound.disabled, true, '-96 dB is silence: the clip arrives switched off');
  assert.deepEqual(pick.effects.map(e => [e.name, e.amount]), [['Noise Reduction', 50]]);
  const grades = r.nodes.filter(n => n.clipId === pick.id).sort((a, b) => a.order! - b.order!);
  assert.deepEqual(grades.map(g => g.enabled), [true, false], 'stacked corrections keep their order and bypass state');
  // (slope·v + offset)^power must equal the node's (v + offsetC)^(1/2^gammaC) · (1 + gainC) for every input.
  const p = grades[0].parameters, slope = 1.1527, offset = [-0.0627263, -0.0623002, -0.0638536], power = [1.02651, 0.993983, 0.936511];
  for (const v of [.1, .45, .9]) for (const [i, c] of [...'RGB'].entries()) near(Math.max(0, v + p['offset' + c]) ** (1 / 2 ** p['gamma' + c]) * (1 + p['gain' + c]), (slope * v + offset[i]) ** power[i], `CDL ${c} at ${v}`);
  near(p.saturation, 170.4752, 'color board saturation 0.5 = unchanged, ±0.5 = ±100%');
  const lithe = r.clips.find(c => c.name === 'Lithe.mp3')!;
  near(lithe.start, 10.5 + (24459373200 / 720000 - 81531444 / 2400)); near(lithe.duration, 20370000 / 720000, 'the split edit runs to audioDuration, past the picture');
  const beep = r.clips.find(c => c.name === 'Beep.wav')!;
  near(beep.start, 9996389011 / 35280000 - 658900 / 2400, 'sound alone is cut to the sample, not the frame'); near(beep.sourceIn, 260546094466 / 35280000 - 7385);
  const title = r.clips.find(c => c.mediaId === 'frameline-title')!, doc = JSON.parse(String(title.properties.textDocument));
  assert.equal(doc.runs[0].style.fontFamily, 'FL-bebas', 'title fonts resolve to the font library'); assert.equal(doc.align, 'left');
  near(doc.y + doc.height, .5 + 290.8225 / 1080, 'bottom-aligned text ends at the lowest text box');
  assert.ok(!r.warnings.some(w => /Bebas/.test(w)), 'a font found in the library is not reported');
});

test('bundle reading maps original paths to the copied files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sharedcut-fcp-bundle-'));
  try {
    await mkdir(join(dir, 'media'));
    await writeFile(join(dir, 'Edit.fcpxml'), sample);
    await writeFile(join(dir, 'media', 'A&B.mov'), 'a');
    await writeFile(join(dir, 'sources.tsv'), '/Volumes/Shoot/Day 1/A&B.mov\tmedia/A&B.mov\n');
    const bundle = readFcpBundle(dir);
    assert.equal(bundle.xml, sample);
    assert.equal(locateSource({ name: 'A&B.mov', sourcePath: '/Volumes/Shoot/Day 1/A&B.mov' }, bundle.sources), join(dir, 'media', 'A&B.mov'));
    assert.equal(locateSource({ name: 'song.wav', sourcePath: '/nowhere/song.wav' }, bundle.sources, ['/x/song.wav']), '/x/song.wav');
    assert.equal(locateSource({ name: 'song.wav', sourcePath: '/nowhere/song.wav' }, bundle.sources, ['/x/song.wav', '/y/song.wav']), undefined, 'two candidates: ambiguous');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('POST /api/fcp/import creates, resumes, rebuilds and accepts uploads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sharedcut-fcp-test-'));
  const app = createFrameLineServer({ dataDir: dir });
  await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  try {
    const signup = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'FCP Test', email: 'fcp@example.test', password: 'fcp-import-test-password' }) });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0], id = fcpProjectId(sample);
    const post = (xml: string, query = '') => fetch(`${base}/fcp/import?projectId=${id}${query}`, { method: 'POST', headers: { cookie }, body: xml });
    assert.equal((await fetch(`${base}/fcp/import?projectId=${id}`, { method: 'POST', body: sample })).status, 401);
    assert.equal((await post('<fcpxml version="1.11"/>')).status, 400);
    const created = await post(sample);
    assert.equal(created.status, 201, await created.clone().text());
    const body = await created.json() as { media: { id: string; name: string }[]; warnings: string[] };
    assert.equal(body.media.length, 4);
    assert.equal((await post(sample)).status, 200, 'the same XML resumes');
    assert.equal((await post(sample.replace('name="Edit"', 'name="Edit 2"'))).status, 409, 'different XML under the same id is refused');
    const state = async () => (await (await fetch(base + '/state', { headers: { cookie } })).json() as any).state;
    const before = await state();
    assert.equal(before.clips.filter((c: any) => c.projectId === id).length, 10, '8 in the edit, 2 in the compound');
    // Rebuild keeps the media records, replaces the edit and keeps the old one as a snapshot.
    const rebuilt = await post(sample.replace('name="Edit"', 'name="Edit v2"'), '&rebuild=1');
    assert.equal(rebuilt.status, 200, await rebuilt.clone().text());
    const after = await state();
    assert.equal(after.projects.find((p: any) => p.id === id).name, 'Edit', 'rebuild keeps the project and its name');
    assert.equal(after.media.filter((m: any) => m.projectId === id).length, 4);
    assert.ok(after.snapshots.some((s: any) => s.projectId === id && s.name === 'Before Final Cut rebuild'));
    // The footage upload path the import scripts drive.
    const asset = body.media.find(m => m.name === 'song.wav')!, chunk = Buffer.from('not really audio');
    const begin = await fetch(`${base}/media/${asset.id}/upload`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ size: chunk.length, fingerprint: 'song.wav:16' }) });
    assert.equal(begin.status, 200);
    const sent = await fetch(`${base}/media/${asset.id}/upload`, { method: 'PUT', headers: { cookie, 'upload-offset': '0', 'upload-checksum': createHash('sha256').update(chunk).digest('hex') }, body: chunk });
    assert.equal(sent.status, 202);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
