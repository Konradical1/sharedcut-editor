import assert from 'node:assert/strict';
import test from 'node:test';
import { appleLog, cameraColor, cameraLabels } from './cameraMetadata.ts';
import { isHdrTransfer } from '../src/services/color.ts';

const sonyXml = (gamma: string, primaries: string, model = 'ZV-E10M2') => Buffer.from(`<NonRealTimeMeta><Device manufacturer="Sony" modelName="${model}"/><AcquisitionRecord><Group name="CameraUnitMetadataSet"><Item name="CaptureGammaEquation" value="${gamma}"/><Item name="CaptureColorPrimaries" value="${primaries}"/><Item name="CodingEquations" value="rec709"/></Group></AcquisitionRecord></NonRealTimeMeta>`, 'latin1');

/** Canon MP4 layout: CNCV box, then an Exif thumbnail whose maker note carries LogInfo (tag 0x4026). */
function canonHead(log: number | undefined, gamut = 2, model = 'Canon EOS R6m2') {
  const tiff = Buffer.alloc(400); tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  const entry = (at: number, tag: number, type: number, count: number, value: number) => { tiff.writeUInt16LE(tag, at); tiff.writeUInt16LE(type, at + 2); tiff.writeUInt32LE(count, at + 4); tiff.writeUInt32LE(value, at + 8); };
  tiff.writeUInt16LE(2, 8); entry(10, 0x0110, 2, model.length + 1, 200); entry(22, 0x8769, 4, 1, 50); tiff.write(model, 200, 'latin1');
  tiff.writeUInt16LE(1, 50); entry(52, 0x927c, 7, 80, 100);
  tiff.writeUInt16LE(log === undefined ? 0 : 1, 100);
  if (log !== undefined) { entry(102, 0x4026, 4, 12, 300); tiff.writeInt32LE(48, 300); tiff.writeInt32LE(gamut, 300 + 36); tiff.writeInt32LE(1, 300 + 40); tiff.writeInt32LE(log, 300 + 44); }
  return Buffer.concat([Buffer.from('\0\0\0\x26CNCVCanonMP4_002\xff\xd8\xff\xe1\x37\xfeExif\0\0', 'latin1'), tiff]);
}

test('reads Sony S-Log3 settings written at the end of the file', () => {
  const color = cameraColor(Buffer.from('ftypXAVC'), sonyXml('s-log3-cine', 's-gamut3-cine'));
  assert.deepEqual({ ...color, colorEvidence: undefined }, { inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine', colorMatrix: 'bt709', colorEvidence: undefined });
  assert.match(color!.colorEvidence, /ZV-E10M2.*s-log3-cine.*s-gamut3-cine/);
});

test('keeps the Sony profile tag some models write at the start', () => {
  assert.deepEqual(cameraColor(Buffer.from('xxS-Log3/S-Gamut3.Cinexx'), Buffer.alloc(0)), { inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine', colorMatrix: 'bt709', colorEvidence: 'Embedded Sony camera metadata: S-Log3/S-Gamut3.Cine' });
});

test('reports a Sony recording that is not a log curve without inventing one', () => {
  const color = cameraColor(sonyXml('rec2100-hlg', 'rec2020'), Buffer.alloc(0));
  assert.equal(color?.inputProfile, undefined);
  assert.match(color!.colorEvidence, /rec2100-hlg.*not a log curve/);
});

test('reads Canon Log 3 / Cinema Gamut from Canon maker notes', () => {
  const color = cameraColor(canonHead(3), Buffer.alloc(0));
  assert.equal(color?.inputProfile, 'Canon Log 3'); assert.equal(color?.inputGamut, 'Cinema Gamut'); assert.equal(color?.colorMatrix, undefined);
  assert.match(color!.colorEvidence, /Canon EOS R6m2.*Canon Log 3.*Cinema Gamut/);
  assert.equal(cameraColor(canonHead(2, 1), Buffer.alloc(0))?.inputGamut, 'Rec.2020');
});

test('does not guess Canon Log when the camera recorded it off or not at all', () => {
  const off = cameraColor(canonHead(0), Buffer.alloc(0));
  assert.equal(off?.inputProfile, undefined); assert.match(off!.colorEvidence, /Canon Log off/);
  const unknown = cameraColor(canonHead(undefined), Buffer.alloc(0));
  assert.equal(unknown?.inputProfile, undefined); assert.match(unknown!.colorEvidence, /not recorded/);
});

test('ignores truncated maker notes and unrelated files', () => {
  assert.equal(cameraColor(canonHead(3).subarray(0, 120), Buffer.alloc(0))?.inputProfile, undefined);
  assert.equal(cameraColor(Buffer.from('ftypisom'), Buffer.alloc(0)), undefined);
});

// ffprobe's JSON leaves an unspecified transfer out, as on the real Blackmagic Camera files (HEVC Rext 4:2:2 10-bit, colr nclc 9/2/9).
const iphone = { color_primaries: 'bt2020', color_space: 'bt2020nc', pix_fmt: 'yuv422p10le' };
const blackmagic = { 'com.apple.proapps.manufacturer': 'Apple Inc.', 'com.apple.quicktime.software': 'Blackmagic Cam 3.5.200045', 'com.blackmagic-design.camera.lensType': 'iPhone 15 Pro Max 24mm', 'com.apple.proapps.clipID': 'A001_10231512_C001' };
const cameraApp = { 'com.apple.quicktime.make': 'Apple', 'com.apple.quicktime.model': 'iPhone 15 Pro Max', 'com.apple.quicktime.software': '17.1' };

test('reads Apple Log from an Apple-made 10-bit clip with BT.2020 primaries and no transfer', () => {
  assert.deepEqual(appleLog(iphone, blackmagic), { inputProfile: 'Apple Log', inputGamut: 'Rec.2020', colorMatrix: 'bt2020nc', colorEvidence: 'Apple camera metadata (iPhone 15 Pro Max 24mm, Blackmagic Cam 3.5.200045): BT.2020, Apple Log' });
  assert.equal(appleLog({ ...iphone, pix_fmt: 'yuv420p10le' }, cameraApp)?.colorEvidence, 'Apple camera metadata (iPhone 15 Pro Max, 17.1): BT.2020, Apple Log');
  // The transfer as ffprobe can spell it (and isHdrTransfer keeps every one of them off the HLG/PQ tone map), the depth from the format or the stream.
  for (const color_transfer of [undefined, 'unknown', 'unspecified']) { assert.equal(appleLog({ ...iphone, color_transfer }, blackmagic)?.inputProfile, 'Apple Log', String(color_transfer)); assert.equal(isHdrTransfer(color_transfer), false); }
  for (const pix_fmt of ['p010le', 'yuv444p12le', 'gbrp10le']) assert.equal(appleLog({ ...iphone, pix_fmt }, cameraApp)?.inputProfile, 'Apple Log', pix_fmt);
  assert.equal(appleLog({ ...iphone, pix_fmt: undefined, bits_per_raw_sample: '10' }, cameraApp)?.inputProfile, 'Apple Log', 'ProRes reports its depth per stream');
  assert.equal(appleLog(iphone, { 'com.apple.quicktime.model': 'iPad Pro' })?.inputProfile, 'Apple Log', 'an iPad');
  assert.equal(appleLog({ ...iphone, tags: { 'COM.APPLE.QUICKTIME.MAKE': 'Apple' } })?.inputProfile, 'Apple Log', 'stream tags, any case');
});

test('never marks tagged HLG/PQ/BT.709, 8-bit, non-BT.2020 or non-Apple clips Apple Log', () => {
  for (const color_transfer of ['arib-std-b67', 'smpte2084', 'bt709', 'bt2020-10']) assert.equal(appleLog({ ...iphone, color_transfer }, cameraApp), undefined, color_transfer);
  for (const pix_fmt of ['yuv420p', 'yuvj420p', 'nv12']) assert.equal(appleLog({ ...iphone, pix_fmt, bits_per_raw_sample: '8' }, cameraApp), undefined, pix_fmt);
  assert.equal(appleLog({ ...iphone, pix_fmt: 'yuv420p' }, cameraApp), undefined, 'no depth reported');
  for (const color_primaries of ['bt709', undefined]) assert.equal(appleLog({ ...iphone, color_primaries }, cameraApp), undefined, String(color_primaries));
  assert.equal(appleLog(iphone, { 'com.apple.quicktime.make': 'SONY', 'com.apple.quicktime.model': 'ILME-FX3' }), undefined, 'another make in the Apple keys');
  assert.equal(appleLog(iphone, { encoder: 'Lavf61', 'com.apple.quicktime.software': 'Final Cut Pro' }), undefined, 'Apple software is not an Apple camera');
  assert.equal(appleLog(iphone, {}), undefined); assert.equal(appleLog(undefined, cameraApp), undefined);
});

test('a later check: camera maker metadata corrects a label, Apple Log only fills an empty one', () => {
  const apple = appleLog(iphone, blackmagic)!, untagged = { colorEvidence: 'Camera profile untagged; set input manually for log footage' };
  assert.deepEqual(cameraLabels(untagged, apple), { colorEvidence: apple.colorEvidence, inputProfile: 'Apple Log', inputGamut: 'Rec.2020' });
  assert.deepEqual(cameraLabels({ inputProfile: 'Gamma 2.4', inputGamut: 'Rec.709', colorEvidence: 'set elsewhere' }, apple), {}, 'a label it did not read stays');
  assert.deepEqual(cameraLabels(untagged, undefined), {}, 'nothing found changes nothing');
  const sony = cameraColor(Buffer.from('ftypXAVC'), sonyXml('s-log3-cine', 's-gamut3-cine'))!;
  assert.deepEqual(cameraLabels({ inputProfile: 'Canon Log 3', inputGamut: 'Cinema Gamut', colorEvidence: 'Canon container (CAEP)' }, sony), { colorEvidence: sony.colorEvidence, inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' });
  assert.match(cameraLabels({ inputProfile: 'Canon Log 3', colorEvidence: 'Canon container (CAEP)' }, cameraColor(canonHead(0), Buffer.alloc(0))).colorEvidence!, /Canon Log off; Canon Log 3 was assumed at import, not verified$/);
});
