import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveRaw, rawChange, rawColorSpace, rawKey, rawPending, rawSignature, toneCurve, validateRawSettings } from './braw.ts';
import type { BrawInfo } from '../state/models.ts';

// What the RAW SDK reported for a Pocket Cinema Camera 4K clip (card A042), trimmed.
const film = { tone_curve_contrast: 1, tone_curve_saturation: 1, tone_curve_midpoint: .383561641, tone_curve_highlights: 1, tone_curve_shadows: 1, tone_curve_black_level: 0, tone_curve_white_level: 1, tone_curve_video_black_level: 0 };
const info: BrawInfo = {
  camera: 'Blackmagic Pocket Cinema Camera 4K', width: 3840, height: 2160, fps: 24, frames: 177,
  asShot: { viewing_bmdgen: 5, viewing_gamut: 'Blackmagic Design', viewing_gamma: 'Blackmagic Design Film', tone_curve_contrast: 1, tone_curve_saturation: 1, tone_curve_midpoint: .5, tone_curve_highlights: 1, tone_curve_shadows: 1,
    tone_curve_black_level: 0, tone_curve_white_level: 1, tone_curve_video_black_level: 0, highlight_recovery: 0, gamut_compression_enable: 1, post_3dlut_mode: 'Disabled', iso: 3200, white_balance_kelvin: 3850, white_balance_tint: 14, exposure: 0 },
  options: { viewing_bmdgen: [4, 5, 6], viewing_gamut: ['Blackmagic Design', 'Rec.709', 'DaVinci Wide Gamut'], viewing_gamma: ['Blackmagic Design Film', 'Blackmagic Design Extended Video', 'Blackmagic Design Custom', 'DaVinci Intermediate', 'ARRI LogC4'],
    post_3dlut_mode: ['Embedded', 'Disabled'], iso: [1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400] },
  ranges: { white_balance_kelvin: [2000, 50000], white_balance_tint: [-150, 150], exposure: [-5, 5], tone_curve_contrast: [.002, 1.998] },
  toneCurves: { '5:Blackmagic Design Film': film, '5:Blackmagic Design Extended Video': { ...film, tone_curve_contrast: 1.58, tone_curve_saturation: 1.4, tone_curve_midpoint: .409007728, tone_curve_shadows: 1.25 } },
};

test('Camera Raw settings are checked against what the camera offers, and the camera\'s own values are left out', () => {
  assert.deepEqual(validateRawSettings(info, { white_balance_kelvin: 5600.4, iso: 3200, exposure: .5, highlight_recovery: 1 }), { white_balance_kelvin: 5600, exposure: .5, highlight_recovery: 1 });
  for (const bad of [{ shutter: 1 }, { iso: 800 }, { white_balance_kelvin: 60000 }, { exposure: '1' }, { highlight_recovery: 2 }, { viewing_gamma: 'Rec.709' }, []])
    assert.throws(() => validateRawSettings(info, bad), JSON.stringify(bad));
});

test('a curve slider switches the gamma to Custom from that gamma\'s own curve; choosing a gamma takes its curve back', () => {
  const ev = { info, settings: { viewing_gamma: 'Blackmagic Design Extended Video' } };
  const custom = rawChange(ev, 'tone_curve_contrast', 1.8);
  assert.equal(custom.viewing_gamma, 'Blackmagic Design Custom');
  assert.equal(custom.tone_curve_contrast, 1.8);
  assert.equal(custom.tone_curve_saturation, 1.4, 'Extended Video\'s saturation carries over');
  assert.deepEqual(toneCurve({ info, settings: custom }).tone_curve_shadows, 1.25);
  const back = rawChange({ info, settings: custom }, 'viewing_gamma', 'Blackmagic Design Film');
  assert.ok(!Object.keys(back).some(key => key.startsWith('tone_curve_')), 'no custom curve is left behind');
  assert.equal(toneCurve({ info, settings: back }).tone_curve_midpoint, .383561641);
});

test('the developed picture is read as Film Gen 5, a display gamma as Rec.709, and an unmanaged pair says so', () => {
  assert.deepEqual(rawColorSpace(effectiveRaw({ info, settings: {} })).inputProfile, 'Blackmagic Film Gen 5');
  assert.deepEqual(rawColorSpace(effectiveRaw({ info, settings: {} })).inputGamut, 'Blackmagic Wide Gamut');
  assert.deepEqual([rawColorSpace(effectiveRaw({ info, settings: { viewing_gamma: 'Blackmagic Design Extended Video' } }))].map(c => [c.inputProfile, c.inputGamut]), [['Rec.709', 'Rec.709']]);
  assert.deepEqual([rawColorSpace({ viewing_gamma: 'DaVinci Intermediate', viewing_gamut: 'DaVinci Wide Gamut', viewing_bmdgen: 5 })].map(c => [c.inputProfile, c.inputGamut]), [['DaVinci Intermediate', 'DaVinci Wide Gamut']]);
  for (const odd of [{ ...info.asShot, viewing_bmdgen: 6 }, { ...info.asShot, viewing_gamma: 'ARRI LogC4' }]) {
    const c = rawColorSpace(odd);
    assert.equal(c.inputProfile, undefined); assert.match(c.colorEvidence, /Colour management has no input/);
  }
});

test('a develop is pending until the files match the settings; keys are stable', () => {
  assert.equal(rawPending({ info, settings: {} }), false, 'a new clip is developed with camera metadata');
  assert.equal(rawPending({ info, settings: { exposure: 1 } }), true);
  assert.equal(rawPending({ info, settings: { exposure: 1 }, developed: rawSignature({ exposure: 1 }) }), false);
  assert.equal(rawSignature({ exposure: 1, iso: 1600 }), rawSignature({ iso: 1600, exposure: 1 }));
  assert.equal(rawKey({ exposure: 1, iso: 1600 }), rawKey({ iso: 1600, exposure: 1 }));
  assert.notEqual(rawKey({ exposure: 1 }), rawKey({ exposure: 1.01 }));
  assert.match(rawKey({}), /^[0-9a-f]{8}$/);
});
