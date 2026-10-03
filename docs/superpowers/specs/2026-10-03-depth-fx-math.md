# Depth effect math (the single source of truth for preview and export)

The WebGL2 preview (`src/services/depthFx.ts`) and the PyTorch export (`scripts/depth-fx.py`) must
implement exactly these formulas. A parity check compares them.

## Notation

| Symbol | Meaning |
|---|---|
| `W×H` | Output (layer) size in pixels. |
| `x,y` | Pixel centres. |
| `u = (x+.5)/W`, `v = (y+.5)/H` | Normalised coordinates. |
| `I` | Display-referred RGB in 0–1 (the graded layer). |
| `lin(c) = c^2.2`, `enc(c) = max(c,0)^(1/2.2)` | Blur, fog, glow and grade all work in `lin`. |
| `lum(c) = .2126 r + .7152 g + .0722 b` | |
| `smoothstep(a,b,t)` | GLSL definition. Clamp `b` to at least `a + 1e-4`. |

Params are the effect values: `blur`, `focus` and so on are 0–100 unless the table in the design
spec says otherwise. `glowStart` (Glow starts, initial 40, 0–100) is an extra parameter; add it to
the table.

## 0. Depth to distance

- Stored depth sample `s` is in 0–1: the preview reads `R8/255`, the export reads the master / 1023
  (or its own scale).
- The run gives `near` and `far` (stored values).
- `dist(s) = clamp((near - s) / max(near - far, 1e-4), 0, 1)`. 0 is nearest, 1 is farthest.

## 1. Joint-bilateral upsample (depth at output pixel p)

**Depth grid coordinates:**
- The depth image is `w×h` and maps onto the clip's letterboxed source box.
- Inside the box, `q = (p_box + .5) × (w/boxW) - .5` in depth texels, where `p_box` is p in box
  pixels. Outside the box the depth is 0, so every effect is a no-op there.
- With Stabilize, `p` is first mapped through the inverse warp, the same as the matte.

**Taps:**
- `t = floor(q) + (i,j)` for `i,j ∈ {-1,0,1,2}` (16 taps), clamped to the texture edge.
- Weight: `ws = exp(-|q - t|² / 2)`.
- Guide luminance at the tap: `gt = lum(I)` sampled bilinearly at the tap's centre in output pixels,
  `((t + .5) × boxW/w)` plus the box origin.
- `wr = exp(-(lum(I(p)) - gt)² / (2 × .1²))`.
- `D(p) = Σ ws wr dist(depth_t) / Σ ws wr`.
- If `Σ ws wr < 1e-6`, use bilinear `dist(depth(q))`.

**Edges and choices the export must copy** (the preview made them; PyTorch's defaults differ):
- A tap is clamped to the texture edge first, and the clamped `t` is used for `ws` and the guide position too.
- Outside the letterbox box an explicit `inside` mask turns every stage off. `D = 0` alone would not: with Focus far,
  blur would still apply there.
- With Stabilize, the guide is sampled at the forward-warped tap centre.
- `floor(q)` at an exact integer swaps which taps are the outer ones; expect isolated outliers at depth edges (one
  pixel measured 12/255 between GPU float32 and float64). The parity check uses a percentile tolerance, not a maximum.

## 2. Background light (`light > 0`)

- `a = light/100 × smoothstep(ls, ls + max(lightSoftness/100,.01), D)`, where `ls = lightStart/100`.
- Starting from `L = lin(I)`, apply in order:
  1. Exposure: `L *= 2^bgExposure`.
  2. Warmth: `k = bgWarmth/100`, then `L *= (1 + .12k, 1 + .02k, 1 - .12k)`.
  3. Contrast: `L = .18 × (max(L,0)/.18)^(bgContrast/100)`.
  4. Saturation: `Y = lum(L)`, then `L = Y + (L - Y) × bgSaturation/100`.
- Result: `L1 = mix(lin(I), max(L,0), a)`.

## 3. Fog (`fog > 0`)

- `fs = fogStart/100`.
- `kd = 1 + 9 × fogDensity/100`.
- `base = 1 - exp(-kd × max(0, D - fs) / max(1 - fs, .05))`.
- `hz = 1 + 2 × fogHorizon/100 × (1 - v)²`. Here `v` is 0 at the top and 1 at the bottom, so fog is
  thicker toward the top. `v` is the output pixel's row after the Stabilize warp, not the source row.
- `f = clamp(fog/100 × base × hz, 0, 1)`.
- Fog colour: `hsv(fogHue, fogSaturation/100, fogBrightness/100)` converted to RGB (display), then
  `lin`.
- Result: `L2 = mix(L1, fogLin, f)`.

## 4. Lens blur (`blur > 0`)

**Circle of confusion (CoC) in output pixels:**
- `R = blur/100 × .025 × W`.
- `F = focus/100`.
- `band = range/100 × .5`.
- `δ = D - F`.
- `coc(p) = R × clamp((|δ| - band) / .35, 0, 1) × (δ < 0 ? nearBlur/100 : 1)`.

**Working resolution:**
- `Wb = min(W, 960)`, `s = Wb/W`, `Hb = max(1, round(H × s))` with JS `Math.round` (halves round up; Python's
  `round` rounds them to even).
- Downsample `L2`, `D` and `coc` to `Wb×Hb` with an exact area filter (fractional pixel overlap weights). The
  letterbox is averaged in as zeros, so at the box edge coc and D drop (about halve) in the straddling pixels.
  PyTorch's `interpolate(mode='area')` is adaptive pooling (whole pixels, equal weights), which only matches when the
  sizes divide; the export builds the overlap weights itself otherwise.
- In working pixels, `cocW = coc × s` and `Rb = R × s`.

**Gather.** This is Gustafsson's single-pass bokeh with highlight weights. For each working pixel c:

```
hw(col) = 1 + bokeh/100 × 8 × max(lum(col) - .7, 0)
acc = L2(c) × hw(L2(c)); wsum = hw(L2(c))
cc = cocW(c)
r = RS; ang = 0
while r < Rb:
  sp  = c + (cos ang, sin ang) × r          // bilinear samples of L2, D, cocW at sp
  sc  = cocW(sp)
  if D(sp) > D(c): sc = min(sc, 2 × cc)     // a farther sample can't spill onto a nearer one
  m   = smoothstep(r - .5, r + .5, sc)
  w   = hw(L2(sp))
  acc += mix(acc / wsum × w, L2(sp) × w, m)
  wsum += w
  ang += 2.39996323; r += RS / r
B(c) = acc / wsum
```

- `RS = max(.5, Rb² / (2 × N))`.
- `N` is the tap budget:
  - Preview: 16 / 32 / 48 by quality, plus 50 % when paused.
  - Export: 96.
- With the same `N`, both paths sample identical points. The parity check (`npm run test:depth:parity`) runs both at
  `N = 48`.
- If `Rb < 1`, skip the gather (`B = L2` at working resolution).
- Gather samples are bilinear with half-pixel centres, and positions outside the working image clamp to the edge
  pixel (`grid_sample` pads with zeros by default: use `padding_mode='border'`, `align_corners=False`).

**Composite at output resolution:**
- `b = clamp(coc(p) × s, 0, 1)`.
- `L3 = mix(L2(p), bilinear_up(B)(p), b)`. Upsampling is bilinear with half-pixel centres (`align_corners=False`) and
  edge clamping.

## 5. Glow (`glow > 0`)

- `th = glowThreshold/100`.
- Bright pass: `G = L3 × clamp((lum(enc(L3)) - th) / max(1 - th, .01), 0, 1) × smoothstep(gs, gs + .15, D)`,
  where `gs = glowStart/100`.
- The bright pass runs per full-resolution pixel, then the area filter of section 4 takes it to the working
  resolution `Wq = min(W, 480)`, `Hq = max(1, round(H × Wq/W))` (JS `Math.round`).
- Separable Gaussian with `σ = glowRadius/100 × .04 × W × (Wq/W)` working pixels, truncated at `floor(3σ)` taps
  (at most 63) and normalised over the taps kept. Pixels beyond the edge repeat the edge pixel (`conv2d` pads with
  zeros, which darkens the edges: pad with `replicate`).
- Upsample bilinearly to `W×H` (half-pixel centres, edge clamped).
- Result: `L4 = L3 + glow/100 × 1.5 × G_blur`.

## 6. Output

- `O = mix(I, enc(L4), amount/100)`, clamped to 0–1.
- If a stage's main parameter is 0, that stage is the identity.

**Depth map view** (preview only):
- `O = (1 - D, 1 - D, 1 - D)`, so near is white.
- Before analysis covers a frame, show the plain picture.

## 7. Smart Mask subject (Phase 3, `maskId` set)

- Matte `α(p)` is in 0–1, letterboxed like the depth.
- Inside the subject: `coc(p) *= (1 - α(p))`.
- In the gather, a sample with `α(sp) > .5` and `α(c) < .5` gets `m = 0` (subject pixels never smear
  into the background).
- Focus follow (`followSubject` on): `F` = the per-frame value from the server's focus track, when present; Focus and its
  keyframes are ignored meanwhile. The track (`GET /api/depth/<run>/focus?projectId&clipId`, cached beside the run) holds,
  per analysed frame, the median distance of the depth master under `α > .5` (the matte scaled onto the depth grid), gaps
  bridged by straight lines and held at the ends, then a centred moving average over 0.3 s (zero phase). A subject never
  found leaves Focus as set.
- Only the subject's current analysis counts (its saved revision, frames by source index as the Smart Mask effect).
  Preview: an unanalysed or edited mask renders without section 7 and says so. Export: it refuses, as a masked export
  does. Without Lens blur the subject changes nothing, so neither path looks at it.
