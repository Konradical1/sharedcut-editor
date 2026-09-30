import assert from 'node:assert/strict';
import test from 'node:test';
import { cameraColor } from './cameraMetadata.ts';

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
