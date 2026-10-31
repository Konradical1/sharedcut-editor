// The Blackmagic RAW helper end to end, on the SDK's sample clip that npm run setup:braw keeps in .braw/. Skipped where the
// helper is not built (no SDK on this machine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { brawFrame, brawHelper, brawInfo, brawReady, developBraw } from './braw.ts';

const sample = resolve(import.meta.dirname, '..', '.braw', 'sample.braw');
const skip = !brawReady() || !existsSync(sample) ? 'the Blackmagic RAW helper is not set up here (npm run setup:braw)' : false;
const probe = (file: string) => JSON.parse(execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString()).streams as { codec_name: string; profile?: string; width?: number; height?: number; pix_fmt?: string; color_range?: string }[];

test('Blackmagic RAW: info reads the camera and its choices; a still and a develop come out like full-v3 and a ProRes HQ master', { skip, timeout: 120_000 }, async () => {
  const info = await brawInfo(sample);
  assert.equal(info.width, 4608); assert.equal(info.frames, 1);
  assert.ok(info.options.viewing_gamma.includes('Blackmagic Design Film') && info.options.iso.includes(800));
  assert.ok(!info.options.post_3dlut_mode.includes('Sidecar'), 'no sidecar LUT reaches the server');
  assert.deepEqual(info.scales?.half, [2304, 1296]);
  const dir = mkdtempSync(join(tmpdir(), 'braw-test-'));
  try {
    await brawFrame({ original: sample, output: join(dir, 'frame.mp4'), info, settings: { white_balance_kelvin: 5600 }, frame: 0 });
    const [still] = probe(join(dir, 'frame.mp4'));
    assert.deepEqual([still.width, still.pix_fmt, still.color_range], [1920, 'yuv422p10le', 'tv']);
    await developBraw({ original: sample, output: join(dir, 'master.mov'), full: join(dir, 'full.mp4'), info, settings: { viewing_gamma: 'Blackmagic Design Film', viewing_bmdgen: 5 }, audio: false });
    const [master] = probe(join(dir, 'master.mov')), [full] = probe(join(dir, 'full.mp4'));
    assert.deepEqual([master.codec_name, master.profile, master.width, master.pix_fmt], ['prores', 'HQ', 4608, 'yuv422p10le']);
    assert.deepEqual([full.codec_name, full.width, full.pix_fmt], ['h264', 1920, 'yuv422p10le']);
    // A setting the SDK refuses fails the develop instead of writing a short file.
    await assert.rejects(developBraw({ original: sample, output: join(dir, 'bad.mov'), full: join(dir, 'bad.mp4'), info, settings: { viewing_gamma: 'Not a gamma' }, audio: false }), /refused|decode failed/);
    assert.ok(!existsSync(join(dir, 'bad.mov')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Blackmagic RAW: a missing helper says how to set it up', { skip: brawReady() ? false : 'only meaningful with the helper present' }, async () => {
  const saved = process.env.FRAME_LINE_BRAW;
  process.env.FRAME_LINE_BRAW = join(tmpdir(), 'no-braw-helper-here');
  try { await assert.rejects(brawInfo(sample), /npm run setup:braw/); }
  finally { if (saved === undefined) delete process.env.FRAME_LINE_BRAW; else process.env.FRAME_LINE_BRAW = saved; }
  assert.ok(existsSync(brawHelper()));
});
