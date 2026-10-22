# Color page v3: DaVinci-class grading tools

Status: in progress, October 22, 2026. Konrad's brief: revamp the Color page so he and Claude agents can grade
like DaVinci Resolve (and Dehancer for film), keep it simple to read, fit a MacBook screen, and make the MCP good
enough that an agent can match a reference picture.

This file is the contract between the three renderers. **The CPU reference is `src/services/grading.ts`**; the
GPU preview (`src/services/colorPreview.ts`) and the export worker (`scripts/color-render.py`) implement exactly the
formulas below. Any change here changes all three, plus a parity test.

## What ships

| Area | Tools |
|---|---|
| Primaries | Wheels renamed **Shadows / Midtones / Highlights / Offset** (stored as lift/gamma/gain/offset). **Log wheels** (Shadow/Midtone/Highlight with ranges). Exposure, Temp, Tint, Contrast, Pivot, Saturation, **Hue**, **Color Boost**, **Shadows**, **Highlights**, **Density**, range saturation. |
| Curves | Custom (Master/R/G/B) plus **Hue vs Hue, Hue vs Sat, Hue vs Lum, Lum vs Sat, Sat vs Sat, Sat vs Lum**. |
| Qualifier | **HSL key** (hue center/width/soft, sat and lum ranges), eyedropper on the viewer, highlight/matte view. |
| Windows | **Gradient** (linear), **Circle** (radial/ellipse), **Rectangle**; softness, rotation, invert; handles on the viewer. |
| Mixer | **RGB mixer** 3×3 and monochrome. |
| Film | Dehancer-style **Halation, Bloom, Grain, Vignette, Gate weave, Breath, Chromatic aberration** (+ Density in Primaries). |
| Looks | Library of looks and film stocks, applied to the selected node (`applyColorLook`). |
| MCP | Help generated from the parameter registry, richer `color-grade`, new `color-measure` (frame vs reference stats + hints). |

## Data model

Everything numeric is a **node parameter** (`GradeNode.parameters`): keyframable, merge-friendly (each key saves as
`parameters.<key>`), settable from the MCP with `updateNode`. **An absent key means identity**, so a node that does not
use a feature stores nothing for it. Booleans are numbers (on when ≥ .5). The registry `GRADE_PARAMS` in
`grading.ts` lists every key with label, default, min, max, step, unit and a one-line doc; UI, validation and MCP help
read it. HSL curves live in `GradeNode.curves` under `HueHue HueSat HueLum LumSat SatSat SatLum` (same point format as
the custom curves; neutral is y = .5; hue curves are periodic and need `first.y === last.y`).

Older builds refuse to render (and the server refuses to save) nodes that carry these keys or curves: fix forward.

## Per-pixel math (LUT-able)

Notation: `w` = the stage's luma weights (`stage.weights`: `luminanceWeights(gamut)` on nodes-v2, Rec.709 on legacy).
All of it runs on the encoded signal of the stage (DaVinci Intermediate between the CSTs, Gamma 2.4 on legacy).

Opponent space (used by Hue, Boost, Density, HSL curves and the qualifier):

    y  = w·rgb
    cb = (b − y) / (2(1 − wb))        cr = (r − y) / (2(1 − wr))
    back: r = y + 2(1 − wr)·cr,  b = y + 2(1 − wb)·cb,  g = (y − wr·r − wb·b) / wg
    sat s = 2·√(cb² + cr²)            (≈ 1 for Rec.709 primaries)
    hue h = fract((atan2(cr, cb) − atan2(.5, −wr/(2(1 − wb))))/2π)   (red = 0, increases R→Y→G→C→B→M;
            grey, s < 1e-6, is h = 0 in every engine — GLSL atan(0,0) is undefined)

Order inside a correction stage (new steps marked ★):

1. exposure/temperature/tint (unchanged)
2. contrast/pivot, offset, gamma, gain, lift per channel (unchanged)
3. ★ Log wheels: `t = clamp(y,0,1)`, `wS = 1 − ss(lo − .1, lo + .1, t)`, `wH = ss(hi − .1, hi + .1, t)`, `wM = max(0, 1 − wS − wH)`
   with `lo = logLowRange`, `hi = logHighRange`, `ss` = smoothstep; `rgb_c += wS(logShadow + logShadowC) + wM(logMid + logMidC) + wH(logHighlight + logHighlightC)`.
4. ★ Tone sliders on `t = clamp(y,0,1)` (y after step 3), split at the node's contrast pivot `m = clamp(pivot,.05,.95)`
   (`g.pivot`: .336 on a DaVinci Intermediate node, .5 legacy), added to all channels with `bump = u(1 − u)²`:
   below m, `u = t/m`, `+ kS·m·bump`, `kS = shadows/100·(shadows > 0 ? 2 : 1)`;
   above m, `u = (1 − t)/(1 − m)`, `+ kH·(1 − m)·bump`, `kH = highlights/100·(highlights < 0 ? 2 : 1)`. Monotonic; black, white and the pivot stay put.
5. saturation and range saturation (unchanged)
6. ★ Hue: rotate (cb, cr) by `hue` degrees (counter-clockwise: positive moves red toward yellow). Luma unchanged.
7. ★ Color Boost: `chroma *= 1 + boost/100·(1 − s₁)` with `s₁ = clamp(s,0,1)` measured after step 6 (rotation keeps it).
8. ★ Density: `y −= density/100 · .2 · s₁` (saturated colours darken, like dye; same `s₁` as step 7).
   Steps 6–8 share one opponent conversion and are skipped together when hue, boost and density are all 0.
9. legacy warm/tint multiply (unchanged, legacy only)
10. custom curves (unchanged)
11. ★ HSL curves, all read from the colour after step 10 (`y0, s0, h0`) and applied together:
    `HueHue`: rotate (cb, cr) by `(H(h0) − .5)·360°`; `HueSat`·`LumSat`·`SatSat`: `chroma *= 2H(h0) · 2C(t0) · 2C(clamp(s0,0,1))`;
    `HueLum`: `y += (H(h0) − .5)·.5·ss(0, .15, s0)`; `SatLum`: `y += (C(clamp(s0,0,1)) − .5)·.5`.
    `H` samples a hue curve periodically (`sampleHueCurve`: the points wrapped one period each side, then `sampleCurve`);
    `C` is `sampleCurve`. An absent curve contributes identity.
12. ★ RGB mixer: `rgb' = M·rgb` (rows `mixR*`, `mixG*`, `mixB*`); `mixMono` on → all three channels take row R.

Then the node's CST/LUT effects (unchanged), then the node blend.

## Node blend: mask × windows × qualifier

    α = maskTerm · αWindows · αQualifier;   out = in + (graded − in)·α      (in = the node's input)

`maskTerm` is the existing Smart Mask / depth key term (1 without one). The blend runs at the node's end whenever a mask,
a window or the qualifier is on. A CST on a node with an active mask, window or qualifier is refused.

**Qualifier** (`qualOn`), from the node *input* in the opponent space, `sP = clamp(s,0,1)·100`, `yP = clamp(y,0,1)·100`:
`kH = 1` when `qualHueWidth ≥ 360`, else `1 − sse(W/2, W/2 + qualHueSoft, d)` where `d` is the circular hue distance in
degrees to `qualHue`; `kS = (low ≤ 0 ? 1 : sse(low − soft, low, sP))·(high ≥ 100 ? 1 : 1 − sse(high, high + soft, sP))` with
`qualSat{Low,High,Soft}`; `kL` the same on `yP` with `qualLum*`. `α = kH·kS·kL`, inverted by `qualInvert`.
`sse(a,b,x)` is smoothstep, or a hard step `x ≥ a` when `b ≤ a`.

**Windows**, in source-picture coordinates `px, py ∈ [0,1]` (top-left origin), aspect `A = width/height`, sizes in
picture-height units: `X = (px − cx)·A`, `Y = py − cy`; rotate by the window angle (degrees, positive = clockwise on
screen): `u = X cos a + Y sin a`, `v = −X sin a + Y cos a`.

- Circle (`circ*`): `d = √((u/W)² + (v/H)²)`, `k = soft/min(W,H)`, `α = 1 − sse(1 − k/2, 1 + k/2, d)` (W, H are radii).
- Rectangle (`rect*`): half sizes `hw = W/2, hh = H/2`, `r = round·min(hw,hh)`, `q = (|u| − hw + r, |v| − hh + r)`,
  `sd = |max(q,0)| + min(max(qx,qy),0) − r`, `α = 1 − sse(−soft/2, soft/2, sd)`.
- Gradient (`grad*`): `d = X sin a − Y cos a` (angle 0 = inside towards the top), `α = sse(−soft/2, soft/2, d)`.

Each window can be inverted; enabled windows combine as a union `1 − Π(1 − αᵢ)`; none enabled → 1.

## Film stage (spatial, not LUT-able)

A node with any of `filmHalation, filmBloom, filmGrain, filmVignette, filmWeave, filmBreath, filmAberration` ≠ 0 adds a
`{type:'film'}` stage right after the node (after its blend; film is never masked). It works on the whole frame in the
signal's own encoding (`gamma`/`gamut` of that point). `f` = source frame number (`round(sourceTime·fps)`), `seed` =
`filmGrainSeed`, `W×H` = the processed picture in pixels.

1. Gate weave: `t = f/6`, offset `(ox, oy) = .003·filmWeave/100·(2n₁(t) − 1, 2n₁'(t) − 1)` in height units.
2. Aberration: `s = .004·filmAberration/100`; red samples `c + (p − c)(1 + s)`, blue `c + (p − c)(1 − s)` (c = centre).
   The picture is resampled bilinearly (clamped) at `p − (ox/A, oy)` after the aberration scale.
3. `lin = decode(rgb, gamma)`, `Y = w·lin`.
4. Halation: `src = max(0, Y − .18·2^thrH)`, blurred with σ = `filmHalationRadius`% of H; `lin += .25·filmHalation/100 · blur · tint`
   where tint is the full-value HSV hue `filmHalationHue` mixed toward white by `1 − filmHalationSat/100` (brightest channel 1).
   Tuned on the Newspaper S-Log3 stage footage: luma-normalised tint at full strength drew neon outlines on bright skin.
5. Bloom: `src = lin·max(0, Y − .18·2^thrB)/max(Y, 1e-4)`, σ = `filmBloomRadius`% of H;
   `lin += filmBloom/100 · .5 · blur · (1 + k, 1, 1 − k)`, `k = .3·filmBloomWarmth/100`. Both sources come from step 3's `lin`.
6. Breath: `lin *= 2^(.08·filmBreath/100·(2n₁(f/3) − 1))`.
7. Vignette (lens: unshifted coordinates): `ax = mix(1, A, roundness/100)`, `d = |((px − .5)·2ax, (py − .5)·2)| / √(ax² + 1)`,
   `g = sse(size/100, size/100 + max(.01, softness/100), d)`, `lin *= 2^(−2·filmVignette/100·g)`.
8. `rgb = encode(lin, gamma)`.
9. Grain (encoded): `t = clamp(w·rgb,0,1)`, `resp = (1 − r) + r·4t(1 − t)` (`r = filmGrainResponse/100`),
   `amp = .1·filmGrain/100`; lattice `L = (px·A, py)·1080/filmGrainSize`; frame `fg = filmGrainStatic ? 0 : f`;
   `n_c = 1.6·(.7(2v(L, k_c) − 1) + .3(2v(2.37L + 17.1, k_c ^ 0x68E31DA4) − 1))` for c = 0,1,2 and mono c = 3;
   `rgb_c += amp·resp·mix(n₃, n_c, filmGrainColor/100)`.

Noise, identical in all three engines (uint32 arithmetic, wrapping multiplies):

    hash(x, y, k): h = (x·0x8da6b343) ^ (y·0xd8163841) ^ (k·0xcb1ab31f);
                   h ^= h>>16; h *= 0x7feb352d; h ^= h>>15; h *= 0x846ca68b; h ^= h>>16;  → (h >> 8) / 2²⁴
                   (24 bits, exact in float32; reference values are pinned in src/services/grading.test.ts)
    v(L, k): value noise, corners hash(floor(L) + (0|1, 0|1), k), weights smoothstep of fract(L) (x then y).
    n₁(t), keyed 1-D noise: corners hash(floor(t) + 0|1, 0, k), smoothstep weight.
    grain key k_c = seed·0x01000193 ^ fg·0x9E3779B9 ^ (c + 1)·0x85EBCA6B
    weave x / weave y / breath keys: seed·0x01000193 ^ 0xA136AAAD / ^ 0x27D4EB2F / ^ 0x165667B1

Blur (shared): `σ = radius/100·H` px; σ < .5 → no blur. Level `k = max(0, ⌊log₂(σ/4)⌋)`; k successive 2×2 box
halvings (output size ⌈n/2⌉, input indices clamped); separable Gaussian at `σ/2ᵏ` with radius ⌈3σ'⌉ taps, normalised,
clamped edges; bilinear upsample with half-pixel centres (`x = (i + .5)·m/n − .5`, clamped), the GPU's LINEAR filter.

## Where each renderer runs it

- **Preview** (WebGL2): per-pixel steps and the blend in the stage loop; the film stage splits the chain into passes
  (stages before → float texture → film passes → stages after). Windows use the picture rectangle inside the layer.
  Film changes colour only: the layer keeps the source alpha. Under Stabilize, a grade with a window or film reads the
  picture and its mattes through the stabilize warp, as export grades the stabilized bake.
- **Export** (`color-render.py`): `grade()` runs per-pixel stages in stripes and computes window alphas from the stripe's
  rows; `grade_frame()` runs film stages on the whole frame between segments. Clips whose grade has an active window or
  film stage always take the per-frame path (no LUT bake). So does a qualifier when the worker is installed: the hue key
  jumps at grey (grey reads hue 0), which a 33³/65³ table smears onto near-greys by up to 10 levels; without the worker
  (SharedCut Desktop) a qualifier grade falls back to a 65³ table. Stills and compositions keep their alpha through the
  worker. Grain counts frames as `round(source time × fps)` for footage and `round((in point + time into clip) × project
  fps)` for stills, titles and adjustment clips, in preview and export alike.
- **CPU** (`colorTransform`): per-pixel steps and the qualifier; a window needs `maskAt('window:<node id>')`; film stages
  are skipped (it bakes LUTs, which cannot hold them).

## Layout (MacBook first)

Top: viewer (left) and nodes + shot strip (right). Bottom: tool tabs **Primaries · Curves · Qualifier · Windows ·
Mixer · Film** beside the scopes, height draggable and remembered. Fits 1470×760 (MacBook Air with browser chrome and
Dock) without page scroll; compacts below 820 px tall. The right Library panel gains Looks and Film stocks.
