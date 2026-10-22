// color-measure's maths on synthetic pictures: known colours, ramps, clipping, letterbox bars, regions, and the hints
// that name controls (exposure alone, a Balance move vs one zone a round, saturation, black and white, hue turns and mix).
import assert from 'node:assert/strict';
import test from 'node:test';
import { measure, content, hints, regionHint, statsLines, regionText, topHues, type GradeModel, type Pixels } from './colorStats.ts';
import { fromOpponent } from '../src/services/grading.ts';

/** A width×height picture painted by `paint(x, y) → [r, g, b]` (0–255). */
function picture(width: number, height: number, paint: (x: number, y: number) => number[]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const [r, g, b] = paint(x, y), o = (y * width + x) * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; }
  return { width, height, data };
}
const flat = (rgb: number[], width = 32, height = 18) => picture(width, height, () => rgb);
/** Columns of four colours around a grey (orange, blue, green, magenta; luma-neutral, mean grey), their chroma times `k` plus
 *  a `cast`: real spread, so a saturation change and a cast can be told apart. */
const palette = (k: number, cast = [0, 0, 0]) => picture(32, 4, x => [[30, -5.89, -30], [-30, 5.89, 30], [-20, 7.96, -20], [20, -7.96, 20]][x % 4].map((c, i) => 120 + c * k + cast[i]));
const near = (actual: number, expected: number, tolerance = .05) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not ${expected} ±${tolerance}`);

test('a grey and a pure red read as the scopes would', () => {
  const grey = measure(flat([128, 128, 128]));
  for (const p of grey.luma) near(p, 128 / 2.55);
  assert.deepEqual(grey.zones.map(z => Math.round(z.share)), [0, 100, 0]);
  near(grey.all.warm, 0); near(grey.all.mag, 0); near(grey.sat, 0);
  assert.ok(grey.hues.every(v => v === 0));
  assert.equal(topHues(grey), 'none (near grey)');
  const red = measure(flat([255, 0, 0]));
  near(red.luma[3], 21.26);
  assert.equal(Math.round(red.zones[0].share), 100, 'pure red is dark (luma 21)');
  near(red.all.warm, 50); near(red.all.mag, 50); near(red.sat, 100);
  assert.equal(red.hues[0], 100);
  assert.match(regionText(red), /hue (0|360)° red$/);
  assert.equal(Math.round(red.white), 100, 'a channel at 255 counts as clipped');
});

test('a ramp splits into the three zones and percentiles follow it', () => {
  const ramp = measure(picture(256, 4, x => [x, x, x]));
  near(ramp.luma[3], 50, 1); near(ramp.luma[0], 1, 1); near(ramp.luma[6], 99, 1);
  assert.deepEqual(ramp.zones.map(z => Math.round(z.share)), [25, 50, 25]);
  near(ramp.black, 3 / 256 * 100, .01);
  near(ramp.white, 3 / 256 * 100, .01);
});

test('letterbox and pillarbox bars are found; a dark or fading picture is not trimmed', () => {
  const letterbox = picture(64, 36, (_, y) => y < 5 || y >= 31 ? [0, 0, 0] : [120, 90, 60]);
  assert.deepEqual(content(letterbox), { x: 0, y: 5 / 36, w: 1, h: 26 / 36 });
  assert.equal(Math.round(measure(letterbox, content(letterbox)).black), 0);
  // A vertical phone video in a 16:9 timeline keeps about a third of the width.
  const pillar = picture(64, 36, x => x < 22 || x >= 42 ? [0, 0, 0] : [200, 200, 200]);
  assert.deepEqual(content(pillar), { x: 22 / 64, y: 0, w: 20 / 64, h: 1 });
  // A JPEG bleeds faint colour into the bar line next to the picture; a dark line with real detail is picture.
  const bleed = picture(64, 36, (x, y) => y < 4 || y >= 32 ? [0, 0, 0] : y === 4 ? [0, 0, x % 8 ? 0 : 12] : y === 5 ? [0, 0, x === 9 ? 200 : 0] : [90, 90, 90]);
  assert.deepEqual(content(bleed), { x: 0, y: 5 / 36, w: 1, h: 27 / 36 });
  assert.deepEqual(content(flat([0, 0, 0])), { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(content(picture(64, 36, (x, y) => x === 30 && y === 18 ? [255, 255, 255] : [0, 0, 0])), { x: 0, y: 0, w: 1, h: 1 });
});

test('a region measures only its box', () => {
  const split = picture(40, 20, x => x < 20 ? [220, 60, 40] : [40, 80, 220]);
  const right = measure(split, { x: .5, y: 0, w: .5, h: 1 });
  assert.ok(right.all.warm < -20, 'the blue half is cool');
  assert.match(regionText(right), /hue 2\d\d° (blue|azure)$/);
  assert.match(regionText(measure(split, { x: 0, y: 0, w: .25, h: .5 })), /hue \d+° (red|orange)$/);
});

test('hints: exposure, contrast and the ends of the range', () => {
  const dark = measure(flat([90, 90, 90])), mid = measure(flat([128, 128, 128]));
  const [exposure] = hints(dark, mid);
  assert.match(exposure, /^darker than ref \(median 35 vs 50\): exposure \+\.99 stops \(Balance\), or gamma \(Midtones\) up; then measure again \(contrast, colour and saturation follow the brightness\)$/);
  assert.match(hints(mid, dark)[0], /^brighter than ref .*exposure -\.99 stops/);
  // A legacy node multiplies the display signal, not linear light: a 2.4× smaller step.
  assert.match(hints(dark, mid, { linear: false })[0], /exposure \+\.41 stops \(a node\)/);
  const flatRamp = measure(picture(256, 2, x => { const v = 64 + x / 2; return [v, v, v]; })), steep = measure(picture(256, 2, x => [x, x, x]));
  const text = hints(flatRamp, steep).join('\n');
  assert.match(text, /less contrast than ref \(p95−p5 \d+ vs \d+\): contrast ×1\.\d\d around pivot/);
  assert.match(text, /blacks lifted vs ref .*lift \(Shadows master\) down/);
  assert.match(text, /highlights dimmer vs ref .*gain \(Highlights master\) up/);
  assert.deepEqual(hints(mid, mid), [], 'the same picture needs nothing');
  // A brightness difference comes alone: the contrast, ends and cast of a brighter, warmer, punchier ref wait for it.
  const brighter = measure(picture(64, 2, x => { const v = 40 + x * 3.4; return [v + 8, v, v - 8]; }));
  assert.deepEqual(hints(measure(picture(64, 2, x => { const v = 30 + x * 3; return [v, v, v]; })), brighter).map(h => h.split(' (')[0]), ['darker than ref']);
});

test('hints: one Balance move for a white balance, one zone a round for the rest', () => {
  // A white balance scales the channels (luma kept), so a grey moves in step with its level: one Balance move, nothing per zone.
  const ramp = (gains: number[]) => { const l = .2126 * gains[0] + .7152 * gains[1] + .0722 * gains[2]; return measure(picture(64, 2, x => { const v = 30 + x * 3; return gains.map(g => v * g / l); })); };
  const grey = ramp([1, 1, 1]), shared = hints(grey, ramp([1.06, 1, .92]));
  assert.equal(shared.length, 1, shared.join('\n'));
  assert.match(shared[0], /^overall cooler than ref \(warm 0\.0 vs \+3\.4, mag 0\.0 vs -0\.5\): temperature \+1340, tint -4 \(Balance\), or it needs R \+2\.6 G -0\.3 B -4\.2 via offsetR\/G\/B \(Offset wheel\); then measure again$/);
  assert.match(hints(grey, ramp([1.06, 1, .92]), { linear: false })[0], /temperature \+560, tint -2 \(a node\)/);
  // A huge cast stops at the sliders' range.
  assert.match(hints(grey, ramp([1.3, 1, .5])).join('\n'), /temperature \+2000,/);
  // The same cast added at every level is an Offset, not a white balance: Balance takes the mean, and the zone it then misses
  // most comes next, said as it will be after the move (the highlights, warmed past the ref).
  const offset = (cast: number[]) => measure(picture(64, 2, x => { const v = 30 + x * 3; return cast.map(c => v + c); }));
  const f0 = offset([0, 0, 0]), r0 = offset([6, 0, -8]), added = hints(f0, r0);
  assert.deepEqual(added.map(h => h.split(' than ref')[0]), ['overall cooler', 'after that, highlights warmer'], added.join('\n'));
  // Blue shadows, neutral highlights against a neutral ref: no Balance move (it would warm the highlights too).
  const scene = (shadow: number[]) => measure(picture(42, 20, x => x < 14 ? shadow : x < 28 ? [200, 120, 60] : [200, 200, 200]));
  const split = scene([20, 22, 45]), plain = scene([27, 27, 27]);
  const zone = hints(split, plain);
  assert.match(zone[0], /^shadows bluer than ref: needs R \+1\.3 G \+0\.5 B -8\.5 via liftR\/G\/B \(Shadows wheel\), or logShadowR\/G\/B$/);
  assert.ok(!zone.some(h => /^(overall|mids|highlights)/.test(h)), zone.join('\n'));
  // Three zones each off their own way: one wheel hint, the zone furthest off (each wheel moves every zone).
  const three = (s: number[], m: number[], h: number[]) => measure(picture(42, 20, (x, y) => y < 8 && x >= 14 && x < 28 ? [200, 140, 110] : x < 14 ? s : x < 28 ? m : h));
  const each = hints(three([40, 40, 40], [128, 128, 128], [210, 210, 210]), three([44, 40, 30], [124, 128, 138], [214, 208, 200]));
  assert.deepEqual(each.map(h => h.split(': ')[0]), ['shadows bluer than ref'], each.join('\n'));
  // With the clip's own grade the amounts come from it (damped), wheels channel by channel.
  const even = r0.all.cast.map((v, i) => v - f0.all.cast[i]);
  const model: GradeModel = { exposure: () => 1, contrast: () => 1.5, balance: () => [1000, 10], balanced: () => even, saturation: () => 150, channels: keys => keys[0].startsWith('lift') ? [.02, 0, -.04] : [.01, .0001, -.02] };
  assert.match(hints(split, plain, { model })[0], /^shadows bluer than ref: needs R \+1\.3 G \+0\.5 B -8\.5 via liftR \+\.016 liftG 0 liftB -\.032 \(Shadows wheel\), or logShadowR \+\.008 logShadowG 0 logShadowB -\.016$/);
  // The model says how far Balance moves each zone: moving every level alike, the added cast is one move and nothing more;
  // moving the highlights the other way, there is no Balance move and the wheels take it one zone at a time.
  assert.deepEqual(hints(f0, r0, { model }).map(h => h.split(': ')[1]), ['temperature +800, tint +8 (Balance), or it needs R +2.1 G -0.3 B -3.4 via offsetR/G/B (Offset wheel); then measure again']);
  assert.deepEqual(hints(f0, r0, { model: { ...model, balanced: level => level > 75 ? even.map(v => -v) : even } }).map(h => h.split(' than')[0]), ['mids cooler']);
  const tone = hints(measure(picture(256, 2, x => { const v = 64 + x / 2; return [v, v, v]; })), measure(picture(256, 2, x => [x, x, x])), { model }).join('\n');
  assert.match(hints(measure(flat([90, 90, 90])), measure(flat([128, 128, 128])), { model })[0], /exposure \+\.90 stops/);
  assert.match(tone, /contrast ×1\.45 around pivot/);
  assert.match(hints(measure(palette(1)), measure(palette(1.2)), { model }).join('\n'), /saturation ×1\.45/);
  // A log band that misses the zone's level has no answer, nor one that only a huge value reaches (the band's edge barely
  // touches the level) or a wheel solve past the slider (a grade that barely passes colour): the other control's amounts come.
  assert.match(hints(split, plain, { model: { ...model, channels: keys => { if (keys[0].startsWith('log')) throw new Error('singular'); return [.02, 0, -.04]; } } })[0], /via liftR \+\.016 liftG 0 liftB -\.032 \(Shadows wheel\), or logShadowR\/G\/B once logLowRange takes in this level$/);
  const warmer = three([40, 40, 40], [128, 128, 128], [222, 208, 196]), neutral = three([40, 40, 40], [128, 128, 128], [210, 210, 210]);
  assert.match(hints(neutral, warmer, { model: { ...model, channels: keys => keys[0].startsWith('log') ? [1.16, .9, .6] : [.02, 0, -.04] } })[0], /^highlights cooler than ref: .* via gainR \+\.016 gainG 0 gainB -\.032 \(Highlights wheel\), or logHighlightR\/G\/B once logHighRange takes in this level$/);
  assert.match(hints(neutral, warmer, { model: { ...model, channels: keys => keys[0].startsWith('log') ? [.05, 0, -.05] : [1.5, 0, -1.4] } })[0], /via gainR\/G\/B \(Highlights wheel\), or logHighlightR \+\.040 logHighlightG 0 logHighlightB -\.040$/);
  // A model that cannot answer (a grade the CPU cannot run) falls back to the guesses.
  assert.match(hints(measure(flat([90, 90, 90])), measure(flat([128, 128, 128])), { model: { ...model, exposure: () => { throw new Error('no'); } } })[0], /exposure \+\.99 stops/);
  // Each direction gets its colorist word (a neutral frame against a ref cast the other way).
  const word = (cast: number[]) => /^overall (.+?) than ref/.exec(hints(grey, ramp(cast.map(v => 1 - .05 * v))).find(h => h.startsWith('overall')) ?? '')?.[1];
  assert.deepEqual([[1, 0, -1], [2, -1, -1], [1, -2, 1], [-1, -1, 2], [-1, 0, 1], [-2, 1, 1], [-1, 2, -1], [1, 1, -2]].map(word), ['warmer', 'redder', 'more magenta', 'bluer', 'cooler', 'more cyan', 'greener', 'more yellow']);
});

test('hints: saturation, a black and white reference, and the hue mix', () => {
  // More colour in the ref, no cast: saturation only. The same plus a warm cast: both, told apart by the chroma spread.
  const muted = measure(palette(1)), rich = measure(palette(1.5)), warmRich = measure(palette(1.5, [8, 0, -8]));
  const more = hints(muted, rich);
  assert.equal(more.length, 1, more.join('\n'));
  assert.match(more[0], /^less saturated than ref \(colour spread (\d+) vs (\d+), mean \d+ vs \d+, p90 \d+ vs \d+\): saturation ×1\.4[45]$/);
  const both = hints(muted, warmRich);
  assert.ok(both.some(h => /^overall cooler than ref .* after the saturation change\): temperature \+\d+/.test(h)) && both.some(h => /^less saturated than ref .*saturation ×1\.4\d/.test(h)), both.join('\n'));
  // A flat colour has no spread: a cast, never a saturation change.
  assert.match(hints(measure(flat([140, 120, 110])), measure(flat([170, 115, 85]))).join('\n'), /^overall cooler than ref/);
  const mono = hints(measure(flat([170, 115, 85])), measure(flat([120, 120, 120])));
  assert.ok(mono.some(h => h.startsWith('ref is black and white (saturation 0): mixMono 1')), mono.join('\n'));
  assert.ok(!mono.some(h => /saturated than ref|cast|cooler|warmer/.test(h)), 'no colour hints toward a black and white ref');
  // The other way round: no wheel gives a black and white frame colour back (and their solves blow up), so say so; a sepia
  // ref (one tint, no colours) is a cast that Balance can match.
  const bw = hints(measure(palette(0)), rich);
  assert.deepEqual(bw, ['frame is black and white (saturation 0), ref is colour: turn off the mixMono 1 or saturation 0 doing it (color-grade lists the nodes), then measure again']);
  assert.match(hints(measure(palette(0)), measure(palette(0, [10, 0, -12])))[0], /^overall cooler than ref .*: temperature \+\d+/);
  // Same brightness and spread, green colour against cyan colour (~55° apart, the frame has no cyan to boost): a turn.
  const green = measure(picture(32, 2, x => x % 2 ? [60, 160, 70] : [120, 120, 120])), cyan = measure(picture(32, 2, x => x % 2 ? [40, 150, 160] : [120, 120, 120]));
  assert.ok(hints(green, cyan).includes('ref has more cyan (84% vs 0.0% of the colour), less green (0.0% vs 64%): once the casts match, HueHue +59° at x .36 (y .665)'), hints(green, cyan).join('\n'));
});

test('hints: a hue a few degrees off is a HueHue turn; the curve x is the hue the HSL curves read', () => {
  // A patch of display hue `deg` beside grey (grading.ts hueOf inverted on Rec.709 weights).
  const W = [.2126, .7152, .0722], zero = Math.atan2(.5, -W[0] / (2 * (1 - W[2])));
  const patch = (deg: number) => measure(picture(32, 18, x => { if (x >= 16) return [120, 120, 120]; const a = deg / 360 * 2 * Math.PI + zero; return fromOpponent(.45, .175 * Math.cos(a), .175 * Math.sin(a), W).map(v => Math.round(v * 255)); }));
  // Each pixel splits between its two nearest bins: 42° is 60/40 orange/yellow, 48° 40/60, not all orange against all yellow.
  assert.deepEqual(patch(42).hues.map(Math.round).slice(0, 4), [0, 59, 41, 0]);
  near(patch(42).hue, 42, 1);
  const turn = (a: number, b: number, linear = true) => hints(patch(a), patch(b), { linear }).find(h => h.startsWith('ref has'));
  // nodes-v2 HSL curves read DaVinci Wide Gamut hue (42° display is ~54° there); legacy curves read the display hue.
  assert.equal(turn(42, 48), 'ref has more yellow (60% vs 41% of the colour), less orange (40% vs 59%): once the casts match, HueHue +6° at x .15 (y .518)');
  assert.match(turn(42, 48, false)!, /HueHue \+6° at x \.12 \(y \.516\)$/);
  assert.match(turn(130, 100, false)!, /: once the casts match, HueHue -30° at x \.36 \(y \.417\)$/, 'two bins apart is still a turn');
  // Far apart, a colour is missing or extra: HueSat at the bins, or HueHue turning one into the other.
  assert.match(turn(60, 200)!, /: once the casts match, HueSat up at azure \(x \.61\), down at yellow \(x \.2\), or HueHue turning yellow toward azure$/);
  assert.match(turn(60, 200, false)!, /HueSat up at azure \(x \.58\), down at yellow \(x \.17\)/);
});

test('stats print one metric per line, with the reference after a bar; regions say what they need', () => {
  const frame = measure(flat([100, 90, 80])), ref = measure(flat([110, 95, 70]));
  const lines = statsLines(frame, ref);
  assert.deepEqual(lines.map(l => l.split(':')[0]), ['luma p1/5/25/50/75/95/99', 'crushed black/clipped white', 'shadows', 'mids', 'highlights', 'saturation mean/p90', 'hues']);
  assert.match(lines[3], /^mids: 100% rgb 39\/35\/31 warm \+3\.9 mag 0\.0 sat 6 \| ref 100% rgb 43\/37\/27 warm \+7\.8 mag -2\.0 sat 13$/);
  assert.ok(statsLines(frame).every(l => !l.includes('| ref')));
  assert.equal(regionHint(frame, ref), 'bluer: needs R +2.0 G 0.0 B -5.9, sat +6.6');
  assert.equal(regionHint(ref, ref), '');
});
