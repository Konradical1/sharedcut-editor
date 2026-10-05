import test from 'node:test';
import assert from 'node:assert/strict';
import { blendFilters, blendRegion, run } from './media.ts';
import { blendModeNames } from '../src/services/blendModes.ts';

test('bounded blends match the full-frame compositor, including fades, gaps and clipped edges', { timeout: 120000 }, async () => {
  const width = 128, height = 72, layerWidth = 22, layerHeight = 14;
  // A fractional origin, both clipped corners, and a completely off-screen layer.
  const positions = [[25.33, 18.33], [-62.5, -35.5], [62.5, 35.5], [200, 200]];
  for (const mode of blendModeNames.filter(mode => mode !== 'Normal' && mode !== 'Add')) for (const [shiftX, shiftY] of positions) {
    const region = blendRegion(width, height, layerWidth, layerHeight, shiftX, shiftY);
    const options = { mode, width, height, fps: 4, duration: 1, x: `(W-w)/2+${shiftX}`, y: `(H-h)/2+${shiftY}`, enable: 'gte(n,1)*lt(n,3)' };
    const graph = ['[0:v]format=yuva444p10le,split[u0][u1]', '[1:v]format=yuva444p10le,split[l0][l1]',
      ...blendFilters({ ...options, under: 'u0', layer: 'l0', output: 'old', tag: 'old' }),
      ...blendFilters({ ...options, under: 'u1', layer: 'l1', output: 'new', tag: 'new', region }),
      '[old]format=rgb48le[a]', '[new]format=rgb48le[b]', '[a][b]hstack[out]'].join(';');
    const pixels = await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-filter_complex_threads', '2',
      '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:r=4:d=1`,
      '-f', 'lavfi', '-i', `color=c=0xb3c54f@0.6:s=${layerWidth}x${layerHeight}:r=4:d=1,format=rgba,fade=t=in:st=0:d=0.5:alpha=1`,
      '-filter_complex', graph, '-map', '[out]', '-frames:v', '4', '-f', 'rawvideo', '-pix_fmt', 'rgb48le', 'pipe:1'], { binary: true });
    assert.equal(pixels.length, width * height * 2 * 6 * 4);
    let worst = 0;
    for (let frame = 0; frame < 4; frame++) for (let y = 0; y < height; y++) for (let x = 0; x < width * 3; x++) {
      const offset = (frame * width * height * 2 * 3 + y * width * 2 * 3 + x) * 2;
      worst = Math.max(worst, Math.abs(pixels.readUInt16LE(offset) - pixels.readUInt16LE(offset + width * 6)));
    }
    assert.ok(worst <= 256, `${mode} at ${shiftX},${shiftY}: ${worst / 257} 8-bit steps`);
  }
});

test('blend regions retain the full-frame path for large or off-screen layers', () => {
  assert.equal(blendRegion(128, 72, 128, 72, 0, 0), undefined);
  assert.equal(blendRegion(128, 72, 22, 14, 200, 200), undefined);
  assert.deepEqual(blendRegion(1920, 1080, 218, 122, 799.33, 480.33), { x: 1648, y: 956, width: 222, height: 124 });
});
