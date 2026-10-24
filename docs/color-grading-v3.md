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
| Detail | **Dehaze** and **Clarity** (Primaries, "Detail" section): spatial, inside the node, limited by its mask/windows/qualifier. |
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

1. exposure/temperature/tint (unchanged); on a node with Dehaze/Clarity this step is the detail point (see "Detail" below)
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

## Detail: Dehaze and Clarity (spatial, inside the node)

Registry group **`detail`**: `dehaze`, `clarity`, −100..100, step 1, absent or 0 = identity. Not a look group, so applying a
look keeps them, and the Color Assistant's Balance/Look proposals keep a node's values (`detailParams`). `detailActive(p)`
(either ≠ 0) joins `spatialGrade`: such a clip always takes the per-frame colour worker (no LUT bake), and `write_cube` refuses it.
Keyframable like every node parameter (sampled per frame, like film). Older builds refuse to render nodes carrying these keys:
fix forward.

**Placement.** No new stage type: a *detail point* is a correction stage with `nodeStart` and `detailActive(stage.extra)`
(`detailPoint` in color.ts; the correction is always a node's first stage). It runs first thing in that stage, so the node
blend `out = in + (graded − in)·mask·windows·qualifier` limits both tools and the qualifier keys on the pre-detail input.
- nodes-v2: step 1 becomes `lin = decode(rgb, gamma)·G` → **dehaze → clarity** → `rgb = encode(lin, gamma)`, with
  `G = 2^exposure·(1 + T/1e4, 1 − tint/200, 1 − T/1e4)` (`detailGain`; run even at G = 1).
- legacy: at the very start of the stage, `lin = decode(rgb, stage gamma)` (Gamma 2.4 unless an earlier CST changed it), G = 1, then encode and the legacy stage as before.
- The maps come from the whole node input decoded the same way and × the same G, so they see exactly the `lin` they are
  applied to: Dehaze on Balance acts on the balanced picture, identical to Dehaze on its own node right after Balance.
  Whole-frame renderers split *before* a detail point (film splits after its node); intermediate parts stay unclamped.

Notation: `w` = stage.weights (DWG's blue weight is negative), `H` = height of the processed picture (the preview's picture
box, the export's fitted picture; no letterbox bars), `ss` = smoothstep, `L(x) = log₂(max(x,0) + 2⁻¹⁰) − log₂(.18)` (stops re
18 % grey, `detailStops`), `y = w·lin`, `mx = max(max_c lin_c, 0)`, `l = L(y)`, `lm = L(mx)`. Float32 throughout; powers as
products (`x⁴ = (x²)²`).

Constants (`DETAIL` in grading.ts, identical in GLSL and color-render.py): `R = 2` (% of H, every large blur), `RD = .5` (% of H,
dark-channel blur), `M0 = 2⁻⁸`, guards `GLO, GHI = .25, .7` (level-k box mean of mx) and `LO, HI = .25, .7` (pixel luma),
`EPS_D = .25`, `EPS_C = .0625`, `RM = EPS_C/EPS_M = .0625` (`EPS_M = 1`), `SMAX = .25` stop, `VEPS = 1e-3`, `OMEGA = .95`,
`TMIN = 1/3`, `UMAX = .8`, `CHROMA = .6`, `KAPPA = .6`, `KN = .5`, `KH = 1`, `KAPPA_N = .4`, `D = .5` stop, `GATE = (.08/.25)²`.
The airlight is a constant 1 (scene linear, after the node's exposure). There is no frame statistic, percentile, airlight
search or previous-frame state anywhere: every map is a pure function of the current frame, so scrubbing, chunked export and
a bright object entering the frame change the result only locally.

**Maps** (`detailMaps` in filmLook.ts, once per detail point per frame, one pyramid level, the film blur's pieces):
1. `σ = R/100·H`, `k = max(0, ⌊log₂(σ/4)⌋)`, `σ' = σ/2ᵏ` (no σ < .5 shortcut). 1080p and 2160p → 480×270 with σ' 5.4;
   512 rows → ⌈W/2⌉×256, σ' 5.12; H < 400 → full size, σ' = .02H.
2. Per full-resolution pixel `SA = (l, l², lm, mx)`, `SB = r⁴` per channel with `r = 1/clamp(lin_c, M0, 1)`; k 2×2 box halvings of both.
3. `Gs` = the separable Gaussian at level k (radius ⌈3s⌉ taps, normalised, clamped edges), no upsample.
4. Soft dark channel: `Pb = Gs(SB)` with `s = σ'·RD/R`, `sm_c = 1/√√Pb_c` (power-mean soft minimum), `dk = min_c sm_c`; veil
   colour `vr = log₂(sm_r/sm_g)`, `vb = log₂(sm_b/sm_g)` scaled by `min(1, SMAX/max(√(vr² + vb²), 1e-6))`; bright guard per
   level-k texel before any blur: `dk' = dk·(1 − ss(GLO, GHI, SA.mx))`.
5. `B1 = Gσ'(l, l², lm, lm²)`, `B2 = Gσ'(dk', lm·dk', dk'·vr, dk'·vb)` (lm² and the products formed at level k).
6. `vl = max(B1.y − B1.x², 0)`, `vm = max(B1.w − B1.z², 0)`; clarity base `a_c = vl/(vl + EPS_C)`, `b_c = (1 − a_c)·B1.x`;
   haze map guided by lm: `α = (B2.y − B1.z·B2.x)/(vm + EPS_D)`, `β = B2.x − α·B1.z`.
7. `M1 = Gσ'(a_c, b_c, α, β)`, `M2 = B2`, read at each pixel with the film blur's bilinear (half-pixel centres, clamped):
   the 8 values `(a_c, b_c, α, β, μd, ·, dvr, dvb)` (`detailAt`).

**Per pixel** (`applyDetail` in grading.ts; `a = dehaze/100`, `c = clarity/100`, `a_c`, `b_c`… from the maps):
- `base = a_c·l + b_c`. Smooth local mean: `a_m = RM·a_c/(RM·a_c + 1 − a_c)`, `b_m = a_m·l + (1 − a_m)·b_c/max(1 − a_c, 1e-3)`,
  `μ = .18·2^b_m` (only ≈1 stop edges, ridgelines, survive in it).
- Haze map `h = clamp(α·(b_m + lm − l) + β, 0, 1)·(1 − ss(LO, HI, y))`, 0 where `y ≤ 1e-6` (read at the smooth base plus the
  pixel's own max-over-luma offset, so texture is not copied into h). `softcap(u) = u/√√(1 + (u/UMAX)⁴)`.
- **a > 0**: `t = max(1 − OMEGA·a·h, TMIN)`, `s = 1 − t`, `uc = softcap(s/max(y, 1e-6))`, `q = (1 − uc)/t`,
  `gc = q·(1 − CHROMA) + CHROMA/t`, veil colour `col = (2^(dvr/(μd+VEPS)), 1, 2^(dvb/(μd+VEPS)))` divided by its luma `w·col`;
  `out = q·y + gc·(lin − y − uc·y·(col − 1))`, then `out *= ((1 − softcap(s/max(μ, 1e-6)))/t)^−KAPPA`. That is
  `J = (I − A(1 − t))/t` with A = 1 on luminance, the removed fraction soft-capped below 80 %, the veil's own colour (±.25 stop)
  taken out of the chroma, 60 % of the physical chroma gain kept, 60 % of the darkening at the local mean given back.
- **a < 0**: `v = |a|·(KN·max(μ − 2⁻¹⁰, 0)·(1 − ss(LO, HI, y)) + KH·h)`, `out = (lin + v)·(μ/(μ + v))^KAPPA_N` (a neutral veil,
  stronger where there is haze already, bright areas kept).
- **Clarity** after dehaze, its detail band from the pre-dehaze `l`: `d = l − base`, `f = d/√(1 + (d/D)²)`,
  `mid = ss(−6, −1.5, base)·(1 − ss(2, 5, base))`, `g = a_c/(a_c + GATE·(1 − a_c))` (flat skies and noise left alone),
  `out *= 2^(c·(c > 0 ? 2 : 1)·mid·g·f)`: one factor on R, G and B (hue and saturation ratios exact; +100 doubles midtone
  detail, −100 removes it and never inverts it).

**Edges and limits.** Alpha is ignored by the maps and passed through. Negative or huge channels stay finite (the clamps above);
a black frame and a flat field under clarity come back unchanged (to 1e-9), a flat field stays flat. Every detail target is
RGBA32F (`P` reaches 2³², `E[l²] − E[l]²` cancels in 16F); a GPU without float render targets never runs a detail point in 16F
or 8-bit ("Dehaze and Clarity need a GPU with float render targets"). Only the guards are absolute: place Dehaze on or after
Balance. Dehaze darkens hazy areas; lift Exposure on a later node. Recipe (hazy landscape): a node after Balance with dehaze
50–70 and clarity 30–40, then Exposure +.3..+.5 and Contrast 1.1–1.2 on Look; −dehaze adds atmosphere; a gradient window or
depth key confines it to the distance. Pinned vectors (final_detail.py's `pattern(H, W)` at 61×37, 480×270, 963×541,
1920×1080, k = 0, 0, 1, 2): `src/services/detail.test.ts`; the reference rounds `a_c`, `b_c` to ~3e-5 (float32 variance), the
rest and the output pixels agree to ~1e-6.

## Where each renderer runs it

- **Preview** (WebGL2): per-pixel steps and the blend in the stage loop; the film stage splits the chain into passes
  (stages before → float texture → film passes → stages after). Windows use the picture rectangle inside the layer.
  Film changes colour only: the layer keeps the source alpha. Under Stabilize, a grade with a window, film or Dehaze/Clarity
  reads the picture and its mattes through the stabilize warp, as export grades the stabilized bake. A detail point splits
  the chain *before* its node into float targets (never film's 'A'); maps at the level-k grid, all RGBA32F, then the main
  pass reads M1 and M2 at the detail point. The software fallback (no WebGL2) is `gradePicture` in color.ts.
- **Export** (`color-render.py`): `grade()` runs per-pixel stages in stripes and computes window alphas from the stripe's
  rows; `grade_frame()` runs film stages on the whole frame between segments and flushes before a detail point, storing its
  level-k maps in `masks['detail:<node id>']` (each stripe upsamples only its rows). Clips whose grade has an active window,
  film stage or Dehaze/Clarity always take the per-frame path (no LUT bake). So does a qualifier when the worker is installed: the hue key
  jumps at grey (grey reads hue 0), which a 33³/65³ table smears onto near-greys by up to 10 levels; without the worker
  (SharedCut Desktop) a qualifier grade falls back to a 65³ table. Stills and compositions keep their alpha through the
  worker. Grain counts frames as `round(source time × fps)` for footage and `round((in point + time into clip) × project
  fps)` for stills, titles and adjustment clips, in preview and export alike.
- **CPU** (`colorTransform`): per-pixel steps and the qualifier; a window needs `maskAt('window:<node id>')`, a detail point
  the 8 map values `maskAt('detail:<node id>:<0..7>')` (M1 then M2; without maskAt it throws: no LUT can hold it); film stages
  are skipped (it bakes LUTs, which cannot hold them). `gradePicture(clip, asset, nodes, rgb, width, height, {base, maskAt,
  frame})` is the whole-frame reference: parts split after film and before detail points, `detailMaps` from each part's
  output, film between parts, unclamped until the end.

## Layout (MacBook first)

Top: viewer (left) and nodes + shot strip (right). Bottom: tool tabs **Primaries · Curves · Qualifier · Windows ·
Mixer · Film** beside the scopes, height draggable and remembered. Fits 1470×760 (MacBook Air with browser chrome and
Dock) without page scroll; compacts below 820 px tall. The right Library panel gains Looks and Film stocks.
