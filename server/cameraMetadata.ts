import { open } from 'node:fs/promises';

/** Camera recording settings read from the camera's own metadata. Never inferred from pixels or container brands. */
export type CameraColor = { inputProfile?: string; inputGamut?: string; colorMatrix?: string; colorEvidence: string };

const SONY_GAMMA: Record<string, string> = { 's-log3-cine': 'S-Log3', 's-log3': 'S-Log3', 's-log2': 'S-Log2', 's-log': 'S-Log' };
const SONY_GAMUT: Record<string, string> = { 's-gamut3-cine': 'S-Gamut3.Cine', 's-gamut3': 'S-Gamut3', 's-gamut': 'S-Gamut', rec709: 'Rec.709', rec2020: 'Rec.2020' };
const SONY_MATRIX: Record<string, string> = { rec709: 'bt709', rec2020: 'bt2020nc' };
const CANON_LOG = [undefined, 'Canon Log', 'Canon Log 2', 'Canon Log 3'], CANON_GAMUT = ['Rec.709', 'Rec.2020', 'Cinema Gamut'];

/** Sony writes NonRealTimeMeta XML at the start or the end of the file depending on model and clip length. */
function sony(text: string): CameraColor | undefined {
  const item = (name: string) => new RegExp(`<Item name="${name}" value="([^"]*)"`).exec(text)?.[1];
  const gamma = item('CaptureGammaEquation'), primaries = item('CaptureColorPrimaries'), coding = item('CodingEquations');
  if (gamma) {
    const model = /<Device [^>]*modelName="([^"]*)"/.exec(text)?.[1] ?? 'Sony camera', profile = SONY_GAMMA[gamma];
    return { inputProfile: profile, inputGamut: profile && primaries ? SONY_GAMUT[primaries] : undefined, colorMatrix: coding ? SONY_MATRIX[coding] : undefined,
      colorEvidence: `Sony camera metadata (${model}): gamma ${gamma}, primaries ${primaries ?? 'not recorded'}${profile ? '' : '; not a log curve SharedCut converts, set the input manually'}` };
  }
  const tag = /(S-Log(?:2|3)?)\/(S-Gamut(?:3(?:\.Cine)?)?)/.exec(text);
  return tag ? { inputProfile: tag[1], inputGamut: tag[2], colorMatrix: 'bt709', colorEvidence: 'Embedded Sony camera metadata: ' + tag[0] } : undefined;
}

/** Canon MP4: an Exif thumbnail in the CNTH box; maker note tag 0x4026 (LogInfo) holds ColorSpace2 (int32 9) and CanonLogVersion (int32 11). */
function canon(head: Buffer): CameraColor | undefined {
  if (!head.subarray(0, 4096).includes('CNCV')) return undefined;
  let model = 'Canon camera', log: number | undefined, gamut: number | undefined;
  try {
    const tiff = head.indexOf('Exif\0\0', 0, 'latin1') + 6, le = head.toString('latin1', tiff, tiff + 2) === 'II';
    if (tiff < 6) throw RangeError('No Exif');
    const u16 = (at: number) => le ? head.readUInt16LE(tiff + at) : head.readUInt16BE(tiff + at), u32 = (at: number) => le ? head.readUInt32LE(tiff + at) : head.readUInt32BE(tiff + at), i32 = (at: number) => le ? head.readInt32LE(tiff + at) : head.readInt32BE(tiff + at);
    const find = (ifd: number, tag: number) => { for (let i = 0, n = u16(ifd); i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 2 + i * 12; return undefined; };
    const ifd0 = u32(4), name = find(ifd0, 0x0110);
    if (name !== undefined) model = head.toString('latin1', tiff + u32(name + 8), tiff + u32(name + 8) + u32(name + 4)).replace(/\0.*$/s, '') || model;
    const exif = find(ifd0, 0x8769), maker = exif !== undefined ? find(u32(exif + 8), 0x927c) : undefined, info = maker !== undefined ? find(u32(maker + 8), 0x4026) : undefined;
    if (info !== undefined) { const values = u32(info + 8); gamut = i32(values + 36); log = i32(values + 44); }
  } catch (error) { if (!(error instanceof RangeError)) throw error; log = undefined; }
  if (log === undefined || !(log in CANON_LOG)) return { colorEvidence: `${model}: Canon Log setting not recorded in this file; set the input manually and verify it against the camera` };
  if (log === 0) return { colorEvidence: `Canon maker notes (${model}): Canon Log off` };
  const inputProfile = CANON_LOG[log]!, inputGamut = gamut !== undefined ? CANON_GAMUT[gamut] : undefined;
  return { inputProfile, inputGamut, colorEvidence: `Canon maker notes (${model}): ${inputProfile} / ${inputGamut ?? 'gamut not recorded'}` };
}

/** ffprobe's main video stream, as much of it as appleLog reads. */
export type ProbedVideo = { color_primaries?: string; color_transfer?: string; pix_fmt?: string; bits_per_raw_sample?: string; tags?: Record<string, string> };
const APPLE = 'Apple camera metadata';
/**
 * Apple Log has no transfer tag: an iPhone (its Camera app, or Blackmagic Camera on it) writes BT.2020 primaries with the
 * transfer unspecified, while Apple's HDR video is tagged HLG and its SDR video BT.709. So an Apple-made clip of 10 bits or
 * more with BT.2020 primaries and no transfer is Apple Log. HLG/PQ/BT.709-tagged, 8-bit and non-Apple clips are never marked.
 */
export function appleLog(video: ProbedVideo | undefined, format: Record<string, string> = {}): CameraColor | undefined {
  const tags = Object.fromEntries(Object.entries({ ...format, ...video?.tags }).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const make = tags['com.apple.quicktime.make'] ?? tags['com.apple.proapps.manufacturer'], model = tags['com.apple.quicktime.model'], lens = tags['com.blackmagic-design.camera.lenstype'];
  const bits = Number(/(?:p|gray)(\d\d)(?:le|be)$|^p[024](1\d)(?:le|be)?$/.exec(video?.pix_fmt ?? '')?.slice(1).find(Boolean) ?? video?.bits_per_raw_sample);
  const apple = /^apple\b/i.test(make ?? '') || [model, lens].some(name => /^ip(hone|ad)/i.test(name ?? ''));
  if (!video || !apple || video.color_primaries !== 'bt2020' || !['unknown', 'unspecified', undefined].includes(video.color_transfer) || !(bits >= 10)) return undefined;
  const software = tags['com.apple.quicktime.software'];
  return { inputProfile: 'Apple Log', inputGamut: 'Rec.2020', colorMatrix: 'bt2020nc', colorEvidence: `${APPLE} (${[lens || model || make, software].filter(Boolean).join(', ')}): BT.2020, Apple Log` };
}
/**
 * A stored asset's labels after a later metadata check. Camera maker metadata corrects a label; the Apple Log signature, read
 * from tags rather than recorded, only fills an empty one. A missing finding never removes a label, but says so when import only assumed it.
 */
export function cameraLabels(current: { inputProfile?: string; inputGamut?: string; colorEvidence?: string }, found: CameraColor | undefined): { colorEvidence?: string; inputProfile?: string; inputGamut?: string } {
  if (found?.colorEvidence.startsWith(APPLE) && current.inputProfile) return {};
  const assumed = !found?.inputProfile && current.inputProfile && current.colorEvidence?.startsWith('Canon container (CAEP)') ? `; ${current.inputProfile} was assumed at import, not verified` : '';
  return { ...(found && { colorEvidence: found.colorEvidence + assumed }), ...(found?.inputProfile && { inputProfile: found.inputProfile, inputGamut: found.inputGamut ?? current.inputGamut }) };
}
/** Bump to check every ready video's camera metadata again at startup (v2: Sony at the end of the file, no Canon Log guess; v3: Apple Log). */
export const CAMERA_METADATA_VERSION = 3;

export function cameraColor(head: Buffer, tail: Buffer): CameraColor | undefined {
  return sony(head.toString('latin1') + tail.toString('latin1')) ?? canon(head);
}

export async function readCameraColor(path: string, size: number): Promise<CameraColor | undefined> {
  const handle = await open(path, 'r'), head = Buffer.alloc(Math.min(size, 2 << 20)), tail = Buffer.alloc(Math.min(size, 1 << 20));
  try { await handle.read(head, 0, head.length, 0); await handle.read(tail, 0, tail.length, size - tail.length); } finally { await handle.close(); }
  return cameraColor(head, tail);
}
