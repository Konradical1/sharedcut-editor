import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fcpProjectId, fcpTime, fileUrlPath, importFcpxml, importStatus, locateSource, parseXml, readFcpBundle } from './fcpxml.ts';
import type { FcpImport } from '../src/state/models.ts';
import { createFrameLineServer } from './index.ts';
import { evaluateClip } from '../src/services/animation.ts';
import { getText, validateText } from '../src/services/text.ts';
import { timelineTransitions } from '../src/services/transitions.ts';

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
        <param name="Saturation Shadows" key="2005" value="0.75"/>
        <param name="Saturation Midtones" key="2006" value="0.5"/>
        <param name="Saturation Highlights" key="2007" value="0.6"/>
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
  assert.deepEqual([p.saturationShadows, p.saturationMidtones, p.saturationHighlights], [150, undefined, 120], 'range pucks import as range saturation, unchanged ones stay out');
  assert.ok(!r.warnings.some(w => /saturation/i.test(w)), 'range saturation imports exactly');
  const lithe = r.clips.find(c => c.name === 'Lithe.mp3')!;
  near(lithe.start, 10.5 + (24459373200 / 720000 - 81531444 / 2400)); near(lithe.duration, 20370000 / 720000, 'the split edit runs to audioDuration, past the picture');
  const beep = r.clips.find(c => c.name === 'Beep.wav')!;
  near(beep.start, 9996389011 / 35280000 - 658900 / 2400, 'sound alone is cut to the sample, not the frame'); near(beep.sourceIn, 260546094466 / 35280000 - 7385);
  // One title per text object, stacked in order and linked: the renderer sets each line at least as tall as a title's first run.
  const docs = (clips: typeof r.clips) => clips.filter(c => c.mediaId === 'frameline-title').map(c => ({ clip: c, doc: JSON.parse(String(c.properties.textDocument)) }));
  const [name, subtitle] = docs(r.clips);
  assert.deepEqual([name.doc.runs[0].text, subtitle.doc.runs[0].text], ['Jack matthews #15', 'Mens soccer']);
  assert.equal(name.doc.runs[0].style.fontFamily, 'FL-bebas', 'title fonts resolve to the font library'); assert.equal(name.doc.align, 'left');
  assert.ok(name.clip.properties.linkGroup && name.clip.properties.linkGroup === subtitle.clip.properties.linkGroup, 'the parts of one title move together');
  near(name.doc.y + name.doc.runs[0].style.fontSize / 1080, subtitle.doc.y, 'the subtitle sits right under the name\'s line');
  near(subtitle.doc.y + subtitle.doc.height, .5 + 290.8225 / 1080, 'bottom-aligned text ends at the lowest text box');
  assert.ok(!r.warnings.some(w => /Bebas/.test(w)), 'a font found in the library is not reported');

  // A line wider than its box shrinks the whole title (Final Cut's Auto-Shrink) instead of wrapping; tracking is % of size.
  const measure = (text: string, style: { fontSize: number; letterSpacing: number }) => [...text].length * (style.fontSize * .5 + style.letterSpacing);
  const [fittedName, fittedSubtitle] = docs(importFcpxml(fieldExport, 'fcp-field', 'owner', [], measure).clips).map(d => d.doc);
  const big = fittedName.runs[0], small = fittedSubtitle.runs[0], widest = measure('Jack matthews #15', big.style);
  assert.ok(widest <= fittedName.width * 1920 + 1e-6 && widest > .95 * fittedName.width * 1920, `the widest line fills its box: ${widest} of ${fittedName.width * 1920}`);
  near(big.style.fontSize / small.style.fontSize, 278.9 / 91.9, 'every run shrinks by the same factor');
  near(name.doc.runs[0].style.letterSpacing, 0, 'no tracking, no spacing');
});

test('a non-uniform Final Cut scale imports per axis as Scale X / Scale Y, static and keyed', () => {
  const clip = (name: string, offset: number, transform: string) => `<asset-clip ref="r2" offset="${offset}s" name="${name}" start="0s" duration="2s">${transform}</asset-clip>`;
  const keyed = (a: string, b: string) => `<adjust-transform><param name="scale"><keyframeAnimation><keyframe time="0s" value="${a}"/><keyframe time="1s" value="${b}"/></keyframeAnimation></param></adjust-transform>`;
  const xml = `<fcpxml version="1.11"><resources><format id="r1" frameDuration="100/2500s" width="1920" height="1080"/>
    <asset id="r2" start="0s" duration="60s" hasVideo="1" format="r1"><media-rep kind="original-media" src="file:///M/a.mov"/></asset></resources>
    <library><event name="E"><project name="Stretch"><sequence format="r1" duration="12s" tcStart="0s"><spine>
    ${clip('stretched', 0, '<adjust-transform scale="1.309 1.004"/>')}${clip('uniform keys', 2, keyed('1 1', '2 2'))}${clip('stretched keys', 4, keyed('1 1', '1.5 0.75'))}${clip('flipped', 6, '<adjust-transform scale="-2 1"/>')}${clip('widening', 8, keyed('1 1', '2 1'))}${clip('extreme', 10, '<adjust-transform scale="0.1 10"/>')}
    </spine></sequence></project></event></library></fcpxml>`;
  const r = importFcpxml(xml, 'fcp-stretch', 'owner'), byName = (name: string) => r.clips.find(c => c.name === name)!;
  const stretched = byName('stretched'), uniform = byName('uniform keys'), keys = byName('stretched keys'), flipped = byName('flipped');
  near(stretched.properties.scaleX, 130.9); near(stretched.properties.scaleY, 100.4); assert.equal(stretched.properties.zoom, undefined);
  assert.deepEqual(uniform.keyframes?.['properties.zoom']?.map(k => k.value), [100, 200]); assert.equal(uniform.keyframes?.['properties.scaleY'], undefined, 'a uniform keyed scale gets no Scale Y channel');
  assert.deepEqual(keys.keyframes?.['properties.scaleX']?.map(k => k.value), [100, 150]); assert.deepEqual(keys.keyframes?.['properties.scaleY']?.map(k => k.value), [100, 75]); assert.equal(keys.keyframes?.['properties.zoom'], undefined);
  // Between keys each axis follows Final Cut's own straight line, not a product of two ramps.
  for (const [name, t, w, h] of [['stretched keys', .5, 1.25, .875], ['stretched keys', .25, 1.125, .9375], ['widening', .5, 1.5, 1]] as const) {
    const c = byName(name), p = evaluateClip(c, c.start + t).properties, zoom = Number(p.zoom ?? 100) / 100;
    near(zoom * Number(p.scaleX ?? 100) / 100, w, `${name} width at ${t}s`); near(zoom * Number(p.scaleY ?? 100) / 100, h, `${name} height at ${t}s`);
  }
  near(flipped.properties.scaleX, 200); assert.equal(flipped.properties.scaleY, undefined); assert.equal(flipped.properties.flipH, true);
  assert.deepEqual([byName('extreme').properties.scaleX, byName('extreme').properties.scaleY], [10, 800]);
  assert.ok(r.warnings.some(w => /Scale beyond 1–800% is clamped \(extreme\)/.test(w)), r.warnings.join('; '));
  assert.ok(!r.warnings.some(w => /uniform|clamped \((?!extreme)/i.test(w)), r.warnings.join('; '));
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
    assert.equal(bundle.name, basename(dir), 'the bundle folder names the project when Final Cut left it untitled');
    assert.equal(importFcpxml(sample.replace('name="Edit"', 'name="Untitled Project"'), 'fcp-u', 'u', [], undefined, 'BoySoccer').project.name, 'BoySoccer');
    assert.equal(importFcpxml(sample, 'fcp-u', 'u', [], undefined, 'BoySoccer').project.name, 'Edit', 'a name the editor chose is kept');
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
    const cookie = signup.headers.get('set-cookie')!.split(';')[0], id = fcpProjectId(sample, 'any importer');
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

// Synthetic Final Cut exports for shapes the BoySoccer export does not have: a 25 fps 1080p project, footage on /M.
const media = (id: string, file: string, attrs = 'hasVideo="1" hasAudio="1" format="r1"', duration = '600s', start = '0s') =>
  `<asset id="${id}" start="${start}" duration="${duration}" ${attrs}><media-rep kind="original-media" src="file:///M/${file}"/></asset>`;
const footage = media('rCam', 'cam.mov') + media('rB', 'b.mov') + media('rRec', 'rec.wav', 'hasAudio="1"') + '<effect id="rT" name="Basic Title"/>';
const fcp = (spine: string, resources = '', sequence = 'format="r1" duration="60s" tcStart="0s"') =>
  `<fcpxml version="1.13"><resources><format id="r1" frameDuration="100/2500s" width="1920" height="1080"/>${footage}${resources}</resources><library><event name="E"><project name="P" uid="U-1"><sequence ${sequence}><spine>${spine}</spine></sequence></project></event></library></fcpxml>`;
const convert = (xml: string) => {
  const r = importFcpxml(xml, 'fcp-t', 'owner'), tracks = new Map(r.tracks.map(t => [t.id, t]));
  return { ...r, kind: (c: { trackId: string }) => tracks.get(c.trackId)!.kind, of: (name: string, kind?: 'video' | 'audio') => r.clips.filter(c => c.name === name && (!kind || tracks.get(c.trackId)!.kind === kind)) };
};
const dissolve = (offset: string) => `<transition name="Cross Dissolve" offset="${offset}" duration="1s"><filter-video name="Cross Dissolve"/></transition>`;
const text = (id: string, words: string, style = 'font="Helvetica" fontSize="80"') => `<text><text-style ref="${id}">${words}</text-style></text><text-style-def id="${id}"><text-style ${style}/></text-style-def>`;
const cdl = (slope: string) => `<filter-video name="Color Correction"><!-- info-asc-cdl: slope="${slope}" offset="0 0 0" power="1 1 1" --></filter-video>`;
const has = (r: { warnings: string[] }, pattern: RegExp) => assert.ok(r.warnings.some(w => pattern.test(w)), `${pattern} in: ${r.warnings.join('; ')}`);
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

test('multicam: angles count from the multicam tcStart; picture, sound and their adjustments come from their own angles', () => {
  const multicam = `<media id="r9" name="MC"><multicam format="r1" tcStart="100s">
    <mc-angle name="Cam" angleID="a"><gap offset="0s" start="100s" duration="3s"/><asset-clip ref="rCam" offset="3s" name="cam" start="0s" duration="50s"/></mc-angle>
    <mc-angle name="Mic" angleID="m"><asset-clip ref="rRec" offset="0s" name="mic" start="0s" duration="60s"/></mc-angle></multicam></media>`;
  const r = convert(fcp(`<mc-clip ref="r9" offset="0s" name="Interview" start="110s" duration="5s">
      <mc-source angleID="a" srcEnable="video"><adjust-transform scale="1.5 1.5"/>${cdl('1.2 1.2 1.2')}</mc-source>
      <mc-source angleID="m" srcEnable="audio"><audio-role-source role="dialogue.dialogue-1"><adjust-volume amount="-15dB"/></audio-role-source></mc-source>
    </mc-clip>
    <mc-clip ref="r9" offset="5s" name="Long tail" start="110s" duration="5s" audioDuration="7s"><mc-source angleID="a"/></mc-clip>`, multicam));
  const [picture, sound] = r.of('Interview'), cam = r.timelines.find(t => t.name === 'MC · Cam')!, mic = r.timelines.find(t => t.name === 'MC · Mic')!;
  near(picture.sourceIn, 10, 'clip start 110 s is 10 s into the multicam');
  const [inner] = r.clips.filter(c => c.timelineId === cam.id && c.name === 'cam' && r.kind(c) === 'video');
  assert.ok(inner, 'the angle has its clip'); near(inner.start, 3, 'the angle\'s clip after its 3 s gap'); near(inner.duration, 50);
  assert.equal(r.kind(picture), 'video'); assert.equal(picture.properties.compositionId, cam.id);
  near(picture.properties.zoom, 150, 'the video angle\'s transform'); assert.equal(r.nodes.filter(n => n.clipId === picture.id).length, 1, 'the video angle\'s grade');
  assert.equal(picture.properties.audioDetached, true, 'the picture angle\'s camera sound is not heard');
  assert.equal(r.kind(sound), 'audio'); assert.equal(sound.properties.compositionId, mic.id, 'sound comes from the audio angle'); near(sound.properties.gain, -15, 'the audio angle\'s role volume');
  assert.equal(sound.properties.linkGroup, picture.properties.linkGroup);
  const [tail, tailSound] = r.of('Long tail');
  near(tail.duration, 5); assert.equal(tail.properties.audioDetached, true); assert.equal(r.kind(tailSound), 'audio'); near(tailSound.start, 5); near(tailSound.duration, 7, 'an L cut on a multicam clip keeps its sound');
});

test('compound clips: Detach Audio and switched-off roles leave one sound, on an audio track', () => {
  const compound = '<media id="r8" name="CC"><sequence format="r1" tcStart="0s" duration="10s"><spine><asset-clip ref="rCam" offset="0s" name="inside" start="0s" duration="10s"/></spine></sequence></media>';
  const r = convert(fcp(`<ref-clip ref="r8" offset="0s" name="CC" start="0s" duration="10s" srcEnable="video"><adjust-transform scale="0.5 0.5"/>
      <ref-clip ref="r8" lane="-1" offset="0s" name="CC sound" start="0s" duration="10s" srcEnable="audio"/></ref-clip>
    <ref-clip ref="r8" offset="10s" name="Muted" start="0s" duration="5s"><audio-role-source role="dialogue.dialogue-1" active="0"/></ref-clip>`, compound));
  const [picture] = r.of('CC'), [sound] = r.of('CC sound'), [muted] = r.of('Muted');
  assert.equal(picture.properties.audioDetached, true); near(picture.properties.zoom, 50);
  assert.equal(r.of('CC sound').length, 1); assert.equal(r.kind(sound), 'audio', 'the detached sound is a sound clip, not a second picture');
  assert.equal(muted.properties.audioDetached, true, 'every role switched off');
  assert.ok(!r.warnings.some(w => /Audio-only compound/.test(w)), r.warnings.join('; '));
});

test('sync clips: switched-off storyline or connected sound stays off; split edits keep their sound range', () => {
  const take = (offset: string, source: string) => `<sync-clip offset="${offset}" name="Take ${source}" start="0s" duration="10s"><spine>
    <asset-clip ref="rCam" offset="0s" name="cam ${source}" start="0s" duration="10s" audioRole="dialogue"><asset-clip ref="rRec" lane="-1" offset="0s" name="rec ${source}" start="0s" duration="10s"/></asset-clip>
    </spine><sync-source sourceID="${source}"><audio-role-source role="dialogue.dialogue-1" active="0"/></sync-source></sync-clip>`;
  const r = convert(fcp(take('0s', 'storyline') + take('10s', 'connected') + `
    <sync-clip offset="20s" name="L cut" start="10s" duration="10s" audioDuration="12s"><spine><asset-clip ref="rCam" offset="10s" name="cam L" start="10s" duration="20s"><asset-clip ref="rRec" lane="-1" offset="10s" name="rec L" start="10s" duration="20s"/></asset-clip></spine></sync-clip>
    <asset-clip ref="rB" offset="30s" name="next" start="0s" duration="10s" audioStart="2s" audioDuration="8s"/>`));
  const off = (name: string) => r.of(name, 'audio')[0].disabled;
  assert.deepEqual([off('cam storyline'), off('rec storyline'), off('cam connected'), off('rec connected')], [true, false, false, true]);
  const [camL] = r.of('cam L', 'video'), [soundL] = r.of('cam L', 'audio'), [recL] = r.of('rec L', 'audio');
  near(camL.start, 20); near(camL.duration, 10);
  for (const c of [soundL, recL]) { near(c.start, 20); near(c.duration, 12, `${c.name}: the L cut runs past the picture`); }
  near(r.of('next', 'audio')[0].start, 32);
});

test('wrappers: their adjustments stay off clips connected to them; their sound joins transitions; conform knows the source', () => {
  const r = convert(fcp(`<sync-clip offset="0s" name="Take" start="0s" duration="10s"><adjust-transform scale="1.5 1.5"/><adjust-volume amount="-12dB"/>
      <spine><asset-clip ref="rCam" offset="0s" name="cam" start="0s" duration="10s"/></spine>
      <title ref="rT" lane="1" offset="2s" name="Jane" start="0s" duration="2s">${text('j', 'Jane Doe')}</title>
      <asset-clip ref="rRec" lane="-2" offset="1s" name="music" start="0s" duration="5s"/></sync-clip>
    <clip offset="10s" name="W1" start="0s" duration="10s"><video ref="rCam" offset="0s" name="w1" start="0s" duration="10s"><audio ref="rCam" lane="-1" offset="0s" name="w1 sound" start="0s" duration="10s"/></video></clip>
    ${dissolve('19.5s')}
    <clip offset="20s" name="W2" start="20s" duration="10s"><video ref="rB" offset="20s" name="w2" start="20s" duration="10s"><audio ref="rB" lane="-1" offset="20s" name="w2 sound" start="20s" duration="10s"/></video></clip>`));
  near(r.of('cam', 'video')[0].properties.zoom, 150); near(r.of('cam', 'audio')[0].properties.gain, -12);
  const [jane] = r.clips.filter(c => c.mediaId === 'frameline-title'), [music] = r.of('music');
  assert.equal(jane.properties.zoom, undefined, 'a title connected to the sync clip keeps its own size'); assert.equal(music.properties.gain, undefined, 'and connected music its own level');
  assert.ok(Number(r.of('w1 sound')[0].properties.audioFadeOut) > 0 && Number(r.of('w2 sound')[0].properties.audioFadeIn) > 0, 'a wrapper\'s nested sound crossfades with its picture');
  // A wrapper with fill conform in a 2:1 project: the 16:9 source fills it.
  const wide = convert(fcp('<clip offset="0s" name="W" start="0s" duration="5s" format="r1"><adjust-conform type="fill"/><video ref="rCam" offset="0s" name="fill" start="0s" duration="5s"/></clip>',
    '<format id="r2" frameDuration="100/2500s" width="1920" height="960"/>', 'format="r2" duration="5s" tcStart="0s"'));
  near(wide.of('fill')[0].properties.zoom, 112.5); assert.ok(!wide.warnings.some(w => /needs the source size/.test(w)), wide.warnings.join('; '));
});

test('audio components: channel components of one file become one clip; partly switched-off channels are reported', () => {
  const r = convert(fcp(`<audio ref="rPoly" offset="0s" name="poly" start="0s" duration="10s" srcCh="1"><audio ref="rPoly" lane="-1" offset="0s" start="0s" duration="10s" srcCh="2"/><audio ref="rPoly" lane="-2" offset="0s" start="0s" duration="10s" srcCh="3"/></audio>
    <asset-clip ref="rCam" offset="10s" name="dual" start="0s" duration="5s"><audio-channel-source srcCh="1"/><audio-channel-source srcCh="2" active="0"/></asset-clip>
    <clip offset="15s" name="wrapped" start="0s" duration="5s"><video ref="rB" offset="0s" name="wrapped picture" start="0s" duration="5s"/><audio ref="rB" lane="-1" offset="0s" name="wrapped sound" start="0s" duration="5s"/><audio-channel-source srcCh="1, 2" active="0"/></clip>`,
    media('rPoly', 'poly.wav', 'hasAudio="1" audioChannels="3"')));
  assert.equal(r.clips.filter(c => c.mediaId === r.media.find(m => m.name === 'poly.wav')!.id).length, 1, 'one clip, not the whole file three times');
  has(r, /Audio channel components of one file import as one clip/); has(r, /switched off in Final Cut still play.*\(dual\)/);
  assert.equal(r.of('wrapped sound')[0].disabled, true, 'a wrapper with every channel switched off is silent');
});

test('rate conform: a clip Final Cut speeds to the timeline rate plays at that speed', () => {
  const pal = media('rS', 'pal.mov', 'hasVideo="1" hasAudio="1" format="r1"', '600s', '90s');
  const r = convert(fcp(`<asset-clip ref="rS" offset="0s" name="pal" start="100s" duration="6.25s"><conform-rate srcFrameRate="25"/></asset-clip>
    <asset-clip ref="rS" offset="6.25s" name="kept" start="100s" duration="2s"><conform-rate scaleEnabled="0" srcFrameRate="25"/></asset-clip>`,
    `<format id="r24" frameDuration="100/2400s" width="1920" height="1080"/>${pal}`, 'format="r24" duration="20s" tcStart="0s"'));
  const [video] = r.of('pal', 'video'), [sound] = r.of('pal', 'audio');
  for (const c of [video, sound]) { near(c.properties.speed, 96, `${c.name}: 25p in 24p is 96%`); near(c.sourceIn, 10); }
  assert.equal(r.of('kept', 'video')[0].properties.speed, undefined, 'scaleEnabled="0" plays at its own rate');
  const ntsc = convert(fcp(`<asset-clip ref="rS" offset="0s" name="fifty" start="100s" duration="5s"><conform-rate srcFrameRate="50"/></asset-clip>`,
    `<format id="r23" frameDuration="1001/24000s" width="1920" height="1080"/>${pal}`, 'format="r23" duration="20s" tcStart="0s"'));
  near(ntsc.of('fifty', 'video')[0].properties.speed, round6(24000 / 1001 * 2 / 50 * 100), '50p in 23.98 plays at 47.95 fps');
});

test('transitions: split edits take no crossfade; gaps and title text objects get the whole window; fades and colours survive', () => {
  const r = convert(fcp(`<asset-clip ref="rCam" offset="0s" name="A" start="20s" duration="10s"/>${dissolve('9.5s')}
    <asset-clip ref="rB" offset="10s" name="J" start="20s" duration="10s" audioStart="19s" audioDuration="11s"/>
    <asset-clip ref="rCam" offset="20s" name="B" start="20s" duration="5s"/>${dissolve('24.5s')}<gap offset="25s" start="0s" duration="5s"/>${dissolve('29.5s')}
    <asset-clip ref="rB" offset="30s" name="C" start="20s" duration="5s"><adjust-volume><param name="amount"><fadeIn type="linear" duration="0.3s"/></param></adjust-volume></asset-clip>
    <transition name="Fade To Color" offset="34.5s" duration="1s"><filter-video name="Fade To Color"><param name="Color" value="1 0 0"/></filter-video></transition>
    <asset-clip ref="rCam" offset="35s" name="D" start="20s" duration="5s"/>
    <asset-clip ref="rCam" offset="40s" name="Plate" start="0s" duration="20s"><spine lane="1" offset="2s">${dissolve('0s')}<title ref="rT" offset="0s" name="Lower third" start="0s" duration="5s">${text('n', 'JANE DOE')}${text('d', 'Director', 'font="Helvetica" fontSize="40"')}</title>${dissolve('4s')}</spine></asset-clip>`));
  const [a] = r.of('A', 'audio'), [j] = r.of('J', 'audio');
  near(a.duration, 10, 'no handle past the J cut'); assert.equal(a.properties.audioFadeOut, undefined); near(j.start, 9); assert.equal(j.properties.audioFadeIn, undefined);
  assert.equal(r.of('J', 'video')[0].transition, 'Cross dissolve', 'the picture still dissolves');
  const [b] = r.of('B', 'video'), [c] = r.of('C', 'video');
  assert.deepEqual([b.properties.transitionOut, b.properties.transitionOutAlign, b.properties.fadeOut], ['Cross dissolve', 'center', undefined]);
  assert.deepEqual([c.transition, c.properties.transitionAlign, c.properties.fadeIn], ['Cross dissolve', 'center', undefined]);
  const windows = timelineTransitions(r.clips, r.timelines[0].id, r.media).filter(t => t.clipId === b.id || t.clipId === c.id).map(t => [t.start, t.end]);
  assert.deepEqual(windows, [[24.5, 25.5], [29.5, 30.5]], 'each straddles its cut, as in Final Cut');
  near(r.of('B', 'audio')[0].duration, 5.48); near(r.of('B', 'audio')[0].properties.audioFadeOut, .98, 'sound reaches into its handle (whole frames) over the window');
  near(r.of('C', 'audio')[0].properties.audioFadeIn, .3, 'a fade handle wins over the crossfade');
  const [d] = r.of('D', 'video');
  assert.deepEqual([d.transition, d.properties.transitionParams], ['Dip to colour', '{"colour":"#ff0000"}']);
  const blocks = r.clips.filter(t => t.mediaId === 'frameline-title');
  assert.equal(blocks.length, 2);
  for (const t of blocks) assert.deepEqual([t.transition, t.properties.transitionAlign, t.properties.transitionOut, t.properties.transitionOutAlign], ['Cross dissolve', 'in', 'Cross dissolve', 'out'], `${t.name} dissolves with its title`);
  has(r, /Audio fades import with a linear shape/);
  // Compound clips carry their own sound: it fades with the dissolve instead of cutting.
  const compound = '<media id="r8" name="CC"><sequence format="r1" tcStart="0s" duration="10s"><spine><asset-clip ref="rCam" offset="0s" start="0s" duration="10s"/></spine></sequence></media>';
  const comps = convert(fcp(`<ref-clip ref="r8" offset="0s" name="C1" start="0s" duration="4s"/>${dissolve('3.5s')}<ref-clip ref="r8" offset="4s" name="C2" start="4s" duration="4s"/>`, compound));
  near(comps.of('C1')[0].properties.audioFadeOut, .5); near(comps.of('C2')[0].properties.audioFadeIn, .5);
});

test('pictures: blend modes by number, masked effects, crops on the picture, flips, turns past 360°', () => {
  const r = convert(fcp(`<asset-clip ref="rCam" offset="0s" name="overlay" start="0s" duration="2s"><adjust-blend amount="0.8" mode="14 (Overlay)"/></asset-clip>
    <asset-clip ref="rCam" offset="2s" name="normal" start="0s" duration="2s"><adjust-blend mode="0 (Normal)"/></asset-clip>
    <asset-clip ref="rCam" offset="4s" name="masked" start="0s" duration="2s"><filter-video-mask><mask-shape/>${cdl('0.8 0.9 1.2')}</filter-video-mask></asset-clip>
    <asset-clip ref="r43" offset="6s" name="four by three" start="0s" duration="2s"><adjust-crop mode="trim"><trim-rect left="10" top="2"/></adjust-crop></asset-clip>
    <asset-clip ref="rCam" offset="8s" name="flipped" start="0s" duration="2s"><adjust-crop mode="trim"><trim-rect left="10"/></adjust-crop><adjust-transform position="0 0" anchor="10 0" scale="-1 1"/></asset-clip>
    <asset-clip ref="rCam" offset="10s" name="turned" start="0s" duration="2s"><adjust-transform rotation="450"/></asset-clip>
    <asset-clip ref="rCam" offset="12s" name="spun" start="0s" duration="2s"><adjust-transform><param name="rotation"><keyframeAnimation><keyframe time="0s" value="0"/><keyframe time="1s" value="720"/></keyframeAnimation></param></adjust-transform></asset-clip>`,
    `<format id="r3" frameDuration="100/2500s" width="640" height="480"/>${media('r43', 'old.mov', 'hasVideo="1" format="r3"')}`));
  const [overlay] = r.of('overlay', 'video'), [masked] = r.of('masked', 'video'), [old] = r.of('four by three'), [flipped] = r.of('flipped', 'video');
  assert.deepEqual([overlay.properties.blendMode, overlay.properties.opacity], ['Overlay', 80]); assert.ok(!r.warnings.some(w => /Blend mode/.test(w)), r.warnings.join('; '));
  assert.equal(r.nodes.filter(n => n.clipId === masked.id).length, 1, 'the masked correction imports'); has(r, /Masked effects import without their mask \(masked\)/);
  near(old.properties.cropLeft, 240 + 108, 'past the 240 px pillar, 10% of the picture'); near(old.properties.cropTop, 21.6);
  assert.deepEqual([flipped.properties.cropLeft, flipped.properties.cropRight, flipped.properties.anchorX, flipped.properties.x], [undefined, 108, -108, 108], 'the source\'s left edge shows on the right');
  near(r.of('turned', 'video')[0].properties.rotation, -90, '450° is a quarter turn');
  has(r, /Rotations beyond ±360° are clamped \(spun\)/);
});

test('titles: centred position, descenders of tight lines, text past one box, names, durations, links, captions', () => {
  const credits = 'Credits line\n'.repeat(900);
  const r = convert(fcp(`<title ref="rT" offset="0s" name="Moved" start="0s" duration="2s"><param name="Position" value="-600 200"/>${text('m', 'Hello', 'font="Helvetica" fontSize="80" alignment="center"')}</title>
    <title ref="rT" offset="2s" name="Edge" start="0s" duration="2s"><param name="Position" value="-960 0"/><param name="Right Margin" value="1920"/><param name="Alignment" value="2 (Right) 1 (Middle)"/>${text('e', 'Right')}</title>
    <title ref="rT" offset="4s" name="Tight" start="0s" duration="2s">${text('t', 'Saying goodbye', 'font="Helvetica" fontSize="150" lineSpacing="-10"')}</title>
    <title ref="rT" offset="6s" name="Roll" start="0s" duration="2s">${text('c', credits)}</title>
    <asset-clip ref="rCam" offset="8s" name=" " start="590s"><caption lane="1" offset="591s" duration="2s" role="iTT?captionFormat=ITT.en"><text><text-style>Hello there</text-style></text></caption><live-drawing lane="2" offset="590s" duration="1s"/></asset-clip>
    <caption offset="18s" duration="1s"><text>Spine caption</text></caption>
    <clip offset="20s" name="wrap" start="0s" duration="5s"><video ref="rCam" offset="0s" start="0s" duration="5s"/><audio ref="rCam" lane="-1" offset="0s" start="0s" duration="5s"/></clip>
    <title ref="rT" offset="25s" name="Two" start="0s" duration="2s">${text('x', 'One')}${text('y', 'Two')}</title>`));
  const doc = (name: string) => getText(r.clips.find(c => c.name === name)!);
  const moved = doc('Hello');
  near((moved.x + moved.width / 2) * 1920, 360, 'centred on its Position, 600 px left of the middle'); near((.5 - (moved.y + moved.height / 2)) * 1080, 200);
  const edge = doc('Right'); near(edge.x + edge.width, 1, 'right-aligned to the end of its margins');
  const tight = doc('Saying goodbye'); assert.ok(tight.height * 1080 >= 150 * 1.2, `room under the line for descenders: ${tight.height * 1080}`);
  const roll = r.clips.find(c => /^Credits/.test(c.name))!, rolled = getText(roll);
  assert.equal(rolled.runs.reduce((n, run) => n + run.text.length, 0), 10_000); validateText(rolled); has(r, /longer than one SharedCut text box/);
  const [whole] = r.of('cam.mov', 'video').filter(c => c.start === 8);
  assert.ok(whole, 'a blank name falls back to the file\'s'); near(whole.duration, 10, 'no duration: to the end of the asset');
  has(r, /Captions are not imported yet \(×2\)/); has(r, /<live-drawing> is not imported/);
  const wrapped = r.clips.find(c => c.start === 20 && c.mediaId !== 'frameline-title')!, [one, two] = ['One', 'Two'].map(n => r.clips.find(c => c.name === n)!);
  assert.ok(wrapped.properties.linkGroup && one.properties.linkGroup === two.properties.linkGroup && one.properties.linkGroup !== wrapped.properties.linkGroup, 'the title is not linked to the clip before it');
});

test('every timeline is laid out in project pixels; limits stop the import as it grows', () => {
  const projectXml = (name: string, format: string, inner: string) => `<project name="${name}" uid="${name}"><sequence format="${format}" duration="5s" tcStart="0s"><spine>${inner}</spine></sequence></project>`;
  const moved = '<asset-clip ref="rCam" offset="0s" name="m" start="0s" duration="5s"><adjust-transform position="10 0"/></asset-clip>';
  const xml = `<fcpxml version="1.13"><resources><format id="r1" frameDuration="100/2500s" width="1920" height="1080"/><format id="r6" frameDuration="100/2500s" width="3840" height="2160"/><format id="r7" frameDuration="100/2500s" width="1080" height="1920"/>${footage}</resources><library><event name="E">
    ${projectXml('Teaser', 'r1', moved)}${projectXml('Film', 'r6', moved + `<title ref="rT" offset="0s" start="0s" duration="5s">${text('f', 'Big', 'font="Helvetica" fontSize="160"')}</title>`)}${projectXml('Vertical', 'r7', moved)}</event></library></fcpxml>`;
  const r = convert(xml);
  assert.deepEqual(r.clips.filter(c => c.name === 'm' && r.kind(c) === 'video').map(c => c.properties.x), [108, 108, 108], '10% of the height is 108 px in a 1080 project');
  near(getText(r.clips.find(c => c.name === 'Big')!).runs[0].style.fontSize, 80, '160 px in a 4K timeline'); has(r, /Timeline "Vertical" is 1080 × 1920/);
  // Past a limit the import stops there: it never reaches the unreadable time after it.
  const many = (n: number, item: (i: number) => string, resources = '') => fcp(Array.from({ length: n }, (_, i) => item(i)).join('') + '<asset-clip ref="rCam" offset="later" start="0s" duration="1s"/>', resources, 'format="r1" duration="30000s" tcStart="0s"');
  assert.throws(() => importFcpxml(many(20_001, i => `<asset-clip ref="rS" offset="${i}s" start="0s" duration="1s"/>`, media('rS', 's.mov', 'hasVideo="1" format="r1"')), 'fcp-t', 'o'), /at most 20,000 timeline items/);
  assert.throws(() => importFcpxml(many(5001, i => `<asset-clip ref="rM${i}" offset="${i}s" start="0s" duration="1s"/>`, Array.from({ length: 5001 }, (_, i) => media(`rM${i}`, `${i}.mov`, 'hasVideo="1" format="r1"')).join('')), 'fcp-t', 'o'), /at most 5,000 source files/);
});

test('POST /api/fcp/import: one project per Final Cut project and importer, deleted ids stay reserved, refused files do not stop the rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sharedcut-fcp-ids-'));
  let app = createFrameLineServer({ dataDir: dir, maxUploadBytes: 1000 }), base = '';
  const start = async () => { await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; };
  await start();
  try {
    const signup = async (email: string) => (await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'FCP', email, password: 'fcp-import-test-password' }) })).headers.get('set-cookie')!.split(';')[0];
    const a = await signup('a@example.test'), b = await signup('b@example.test');
    const post = async (cookie: string, xml: string, query = '') => { const r = await fetch(`${base}/api/fcp/import?${query}`, { method: 'POST', headers: { cookie }, body: xml }); return { status: r.status, ...await r.json() as { projectId: string; error: string; media: { id: string; name: string }[] } }; };
    const first = await post(a, sample);
    assert.equal(first.status, 201); assert.equal((await post(a, sample)).projectId, first.projectId, 'the same XML resumes');
    const other = await post(b, sample);
    assert.equal(other.status, 201, other.error); assert.notEqual(other.projectId, first.projectId, 'another account imports its own copy');
    // A re-export: the same Final Cut project (uid) with a changed edit.
    const reexport = sample.replace('name="Edit"', 'name="Edit v2"');
    assert.equal((await post(a, reexport)).status, 409);
    const rebuilt = await post(a, reexport, 'rebuild=1');
    assert.equal(rebuilt.status, 200, rebuilt.error); assert.equal(rebuilt.projectId, first.projectId, 'rebuild replaces the imported edit');
    assert.equal((await post(a, reexport.replace('uid="P1"', 'uid="P2"'), 'rebuild=1')).status, 404, 'nothing to rebuild is not a new project');
    // Deleted: its id (and so its media ids) stays reserved while it can be restored; fresh imports a new copy.
    assert.equal((await fetch(`${base}/api/projects/${first.projectId}`, { method: 'DELETE', headers: { cookie: a } })).status, 200);
    const again = await post(a, reexport);
    assert.equal(again.status, 409); assert.match(again.error, /deleted/);
    const fresh = await post(a, reexport, 'fresh=1');
    assert.equal(fresh.status, 201, fresh.error); assert.notEqual(fresh.projectId, first.projectId);
    // Imported before ids were per importer: under the hash of its XML, which keeps resuming.
    const old = sample.replace('uid="P1"', 'uid="P3"'), legacy = 'fcp-' + createHash('sha256').update(old).digest('hex').slice(0, 32);
    assert.equal((await post(a, old, `projectId=${legacy}`)).status, 201);
    assert.equal((await post(a, old)).projectId, legacy);
    // Files the server refuses get a plain reason.
    const song = fresh.media.find(m => m.name === 'song.wav')!;
    const begin = async (size: number) => { const r = await fetch(`${base}/api/media/${song.id}/upload`, { method: 'POST', headers: { cookie: a, 'content-type': 'application/json' }, body: JSON.stringify({ size, fingerprint: 'song.wav' }) }); return { status: r.status, error: (await r.json() as { error: string }).error }; };
    assert.deepEqual(await begin(2000), { status: 413, error: 'Files must be smaller than 0 GB.' });
    assert.deepEqual(await begin(0), { status: 400, error: 'The file is empty.' });
    // The import script reports such a file and uploads the ones after it.
    const bundle = join(dir, 'bundle');
    await mkdir(join(bundle, 'media'), { recursive: true });
    await writeFile(join(bundle, 'Two.fcpxml'), fcp(`<asset-clip ref="rBig" offset="0s" start="0s" duration="1s"/><asset-clip ref="rSmall" offset="1s" start="0s" duration="1s"/>`, media('rBig', 'big.wav', 'hasAudio="1"') + media('rSmall', 'small.wav', 'hasAudio="1"')));
    await writeFile(join(bundle, 'media', 'big.wav'), Buffer.alloc(2000)); await writeFile(join(bundle, 'media', 'small.wav'), Buffer.alloc(10));
    await writeFile(join(bundle, 'sources.tsv'), '/M/big.wav\tmedia/big.wav\n/M/small.wav\tmedia/small.wav\n');
    const run = await new Promise<{ code: number; out: string }>(done => execFile(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '..', 'scripts', 'import-fcp.mjs'), bundle, '--server', base],
      { env: { ...process.env, FRAME_LINE_COOKIE: a }, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? Number(error.code ?? 1) : 0, out: stdout + stderr })));
    assert.equal(run.code, 0, run.out); assert.match(run.out, /big\.wav: not uploaded\. Files must be smaller than/); assert.match(run.out, /small\.wav: 1 KB uploaded/);
    // An expired backup never deletes media a live project still uses, nor its project's data.
    const live = fresh.media[0].id, marker = join(dir, 'media', live, 'kept');
    await mkdir(join(dir, 'media', live), { recursive: true }); await writeFile(marker, '');
    await app.close();
    const db = new DatabaseSync(join(dir, 'frameline.sqlite'));
    db.prepare('INSERT INTO deleted_projects(id,ownerId,expiresAt,data) VALUES(?,?,?,?)').run(fresh.projectId + 'x', 'someone', 1, JSON.stringify({ media: [{ id: live }] }));
    db.close();
    app = createFrameLineServer({ dataDir: dir }); await start();
    assert.ok(existsSync(marker), 'the purge left the live media alone');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('fonts a title needs that the library lacks are named, once each; a library font matches by prefix', () => {
  assert.deepEqual(importFcpxml(sample, 'fcp-t', 'o').missingFonts, ['Futura']);
  assert.deepEqual(importFcpxml(sample, 'fcp-t', 'o', [{ id: 'FL-1', name: 'Futura PT Bold' }]).missingFonts, []);
  const twice = fcp(`<title ref="rT" offset="0s" duration="1s">${text('a', 'One', 'font="Barlow" fontSize="80"')}</title><title ref="rT" offset="1s" duration="1s">${text('b', 'Two', 'font="Barlow" fontSize="80"')}</title><title ref="rT" offset="2s" duration="1s">${text('c', 'Three')}</title>`);
  assert.deepEqual(importFcpxml(twice, 'fcp-t', 'o').missingFonts, ['Barlow'], 'Helvetica stands in for itself');
});

test('import card: uploading, then processing, then ready; failures counted; paused held until bytes move; a smoothed rate', () => {
  const plan = { by: 'maya', files: [{ id: 'a', size: 100 }, { id: 'b', size: 50 }] };
  // The caller's anchor, moved as index.ts moves it: when a sample is taken.
  let anchor: { at: number; received: number } | undefined;
  const tick = (got: Record<string, number>, status: Record<string, string>, previous: FcpImport | undefined, now: number) => {
    const next = importStatus(plan, id => status[id], id => got[id] ?? 0, previous, now, anchor);
    if (!anchor || (next.received > anchor.received && now - anchor.at >= 5000)) anchor = { at: now, received: next.received };
    return next;
  };
  const start = tick({ a: 10 }, {}, undefined, 1000);
  assert.deepEqual(start, { by: 'maya', phase: 'uploading', total: 150, received: 10, files: 2, uploaded: 0, ready: 0, failed: 0, rate: 0, startedAt: 1000, updatedAt: 1000 });
  const soon = tick({ a: 40 }, {}, start, 3000);
  assert.deepEqual([soon.received, soon.updatedAt, soon.rate], [40, 3000, 0], 'under 5 s since the anchor: no rate sample');
  const first = tick({ a: 80 }, {}, soon, 8000);
  assert.equal(first.rate, 10, 'the first sample counts from the anchor, so the early bytes are not lost: 70 bytes in 7 s');
  const second = tick({ a: 100, b: 20 }, { a: 'processing' }, first, 13000);
  assert.deepEqual([second.rate, second.uploaded, second.received], [9, 1, 120], '0.7 × 10 + 0.3 × 8, rounded');
  assert.equal(importStatus(plan, () => undefined, () => 130, second, 20000).rate, 9, 'no anchor (a restart, a pause): no sample');
  const quiet = tick({ a: 100, b: 20 }, { a: 'processing' }, second, 60000);
  assert.deepEqual([quiet.updatedAt, quiet.rate], [13000, 9], 'no bytes: nothing moves');
  const paused = { ...second, phase: 'paused' as const }, stopped = { ...second, phase: 'stopped' as const };
  assert.equal(tick({ a: 100, b: 20 }, {}, paused, 70000).phase, 'paused');
  assert.equal(tick({ a: 100, b: 20 }, {}, stopped, 70000).phase, 'stopped');
  assert.equal(tick({ a: 100, b: 21 }, {}, paused, 70000).phase, 'uploading', 'bytes arrived');
  assert.equal(tick({ a: 100, b: 10 }, {}, stopped, 70000).phase, 'stopped', 'a discarded partial file is not an arrival');
  const processing = tick({ a: Infinity, b: Infinity }, { a: 'ready', b: 'processing' }, second, 80000);
  assert.deepEqual([processing.phase, processing.received, processing.uploaded, processing.ready, processing.doneAt], ['processing', 150, 2, 1, undefined], 'a complete file counts its planned size');
  const ready = tick({ a: 100, b: 50 }, { a: 'ready', b: 'failed' }, processing, 90000);
  assert.deepEqual([ready.phase, ready.ready, ready.failed, ready.doneAt, ready.startedAt], ['ready', 2, 1, 90000, 1000]);
  assert.equal(tick({ a: 100, b: 50 }, { a: 'ready', b: 'failed' }, ready, 99000).doneAt, 90000, 'done once');
});
