import assert from 'node:assert/strict';
import test from 'node:test';
import type { Clip, Effect } from '../state/models.ts';
import { acceptsEffect, audioEffectNames, detailPixels, effectValue } from './effects.ts';

test('effect parameters retain legacy settings, clamp values, and produce repeatable detail previews', () => {
  const clip = { properties: { EQ_Presence: 4 } } as unknown as Clip;
  const eq = { name: 'EQ', enabled: true, amount: 50 } as Effect;
  assert.equal(effectValue(clip,eq,'Presence'),4);
  assert.equal(effectValue(clip,{...eq,parameters:{Presence:7}},'Presence'),7);
  assert.equal(effectValue(clip,{...eq,parameters:{Presence:99}},'Presence'),12);
  const grain = {...eq,name:'Film grain',parameters:{seed:42}};
  const pixels = new Uint8ClampedArray([100,100,100,255,150,150,150,255]);
  const a = pixels.slice(), b = pixels.slice();detailPixels(a,2,1,clip,grain);detailPixels(b,2,1,clip,grain);
  assert.deepEqual(a,b);assert.notDeepEqual(a,pixels);assert.equal(a[3],255);
  detailPixels(b,2,1,clip,{...grain,enabled:false});assert.deepEqual(a,b);
  const noisy = new Uint8ClampedArray([0,0,0,255,100,100,100,255,0,0,0,255]);
  detailPixels(noisy,3,1,clip,{...eq,name:'Sharpen'});assert.ok(noisy[4]>100);
  const smooth = new Uint8ClampedArray([0,0,0,255,100,100,100,255,0,0,0,255]);
  // Picture Noise Reduction is baked from the camera original (server/denoise.ts), never smoothed here.
  detailPixels(smooth,3,1,clip,{...eq,name:'Noise Reduction'});assert.equal(smooth[4],100);
});

test('picture and audio Noise Reduction go where they belong, one picture Noise Reduction per clip', () => {
  const clip = { properties: {}, effects: [] } as unknown as Clip;
  assert.ok(acceptsEffect(clip,'video','Noise Reduction'));assert.ok(!acceptsEffect(clip,'audio','Noise Reduction'));
  assert.ok(acceptsEffect(clip,'audio','Audio Noise Reduction'));
  assert.ok(!acceptsEffect({...clip,effects:[{id:'n',name:'Noise Reduction',enabled:true,amount:50}]},'video','Noise Reduction'));
  assert.deepEqual(audioEffectNames,['EQ','Compressor','Limiter','Audio Noise Reduction']);
});
