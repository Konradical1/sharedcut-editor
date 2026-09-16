import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWaveform } from './media.ts';
test('dense peaks preserve quiet anti-phase stereo and true silence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frameline-peaks-'));
  try {
    const source = join(dir, 'stereo.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,0.5),0,0.002*sin(2*PI*1000*t))|-if(lt(t,0.5),0,0.002*sin(2*PI*1000*t))':s=48000:d=1", '-c:a', 'pcm_f32le', source]);
    const {waveform, waveformVersion} = await prepareWaveform(source, 1);
    assert.equal(waveformVersion, 2); assert.equal(waveform.length, 200);
    assert.ok(waveform.slice(0, 90).every(n => n === 0));
    assert.ok(waveform.slice(110).every(n => n > .0019 && n < .0021), 'Opposite channels must not cancel in the visualization');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
