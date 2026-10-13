#!/usr/bin/env python3
"""SharedCut Normalize worker: automatic exposure, black level and white balance for a group of shots.

Usage:
  color-normalize.py normalize job.json   measure every shot (working-space cache shared with color-assistant.py), solve the group
  color-normalize.py --selftest           synthetic shots: warm cast, wood floor, darker copy, coloured light, lifted blacks

Job: {ffmpeg, cacheDir, width, shots: [{clipId, key, input, matrix, range, times, preStages, postStages, setup, sdr, hdrCube?}], targets?: [clipId]}
  preStages: processingStages() up to the Balance node; postStages: the stages after it (the clip's output, no look).
  setup: shots with the same camera and source settings share it; targets: the shots to answer for (the rest are context).
Result: {shots: [{clipId, balance: {exposure, temperature, tint, lift, gamma, gain}, confidence, key, warnings: [{code, text}]}], level: {group, target, display}}

How it decides, in DaVinci Wide Gamut linear before the Balance node:
- White balance: the strongest near-neutral colour cluster, weighted by brightness, by the camera's own balance (casts along the
  daylight-tungsten line are believed sooner than green/magenta ones, cool ones sooner than warm ones because wood, skin and brick
  are warm), by agreement with a grey-edge estimate and by the same camera's other shots. With no clear neutral (stage or festival
  light) it stays close to the camera's balance. Shots of one camera that agree within ~0.07 share one balance.
- Exposure: the group keeps its own level (a night game stays a night game) lifted a little; each camera is matched to that level
  and each shot is evened out partly toward its camera's level, as a colourist does by eye. A display guard keeps highlights
  from newly clipping.
- Black level: deep shadows (display p0.5) come down to ~6/255 when a shot's blacks are lifted; mid-tones are then kept.
- Display-referred shots (phones, finished video) have no highlight headroom: a mid-tone gamma with white and black pinned brings
  them to the camera shots' display level instead of exposure.
Everything renders through SharedCut's own engine (color-render.py grade()), so the numbers are what the editor shows.
"""
import importlib.util, json, os, shutil, subprocess, sys, tempfile, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('color_assistant', os.path.join(HERE, 'color-assistant.py'))
ca = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(ca)
engine = ca.engine
DI = 'DaVinci Intermediate'
DWG_Y = np.array(ca.DWG_Y, np.float32)
TEMP_AXIS = np.array([.62, -.785])   # warm direction of the Planckian locus in DWG ln(R/G), ln(B/G) (2000-10000 K)
TINT_AXIS = np.array([.785, .62])    # + magenta, - green
BIN, SPAN = .02, 1.6                 # chroma histogram: 0.02 ln bins over +-1.6
N = int(2 * SPAN / BIN); C = (np.arange(N) + .5) * BIN - SPAN; U, V = np.meshgrid(C, C, indexing='ij')
KAPPA = .55                          # how far each shot is evened out toward its camera's level (1 = fully)
BLACK = .025                         # display luma of the deepest 0.5% after the black point (~6/255)
POOL = .3                            # weight of the same camera's other shots in a shot's white balance
LIMITS = {'exposure': 3.0, 'sdrExposure': .75, 'temperature': 4000, 'tint': 60, 'lift': .06}
REC709_Y = np.array([.2126, .7152, .0722], np.float32)


def blur1(a, sigma, axis):
    r = int(3 * sigma + .5); k = np.exp(-.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    return np.apply_along_axis(lambda m: np.convolve(m, k, 'same'), axis, a)


def conv2(a, k):
    s = [a.shape[0] + k.shape[0] - 1, a.shape[1] + k.shape[1] - 1]
    out = np.fft.irfft2(np.fft.rfft2(a, s) * np.fft.rfft2(k, s), s)
    return out[k.shape[0] // 2:k.shape[0] // 2 + a.shape[0], k.shape[1] // 2:k.shape[1] // 2 + a.shape[1]]


_r = int(.06 / BIN); _y, _x = np.mgrid[-_r:_r + 1, -_r:_r + 1]; DISK = (np.hypot(_x, _y) <= _r).astype(float)


def downscale(frames, f):
    n, h, w, c = frames.shape; h2, w2 = h // f * f, w // f * f
    return frames[:, :h2, :w2].reshape(n, h2 // f, f, w2 // f, f, c).mean((2, 4))


def pixel_set(lin):
    """Usable pixels: positive, above the noise floor and not on a clipped plateau."""
    flat = lin.reshape(-1, 3); y = flat @ DWG_Y; top = flat.max(1); peak = np.percentile(top, 99.9)
    ok = (flat > 1e-4).all(1) & (y > 2e-3)
    if (top >= peak * .985).mean() > .002: ok &= top < peak * .97
    return flat, y, ok


def chroma(flat):
    with np.errstate(divide='ignore', invalid='ignore'):
        return np.stack([np.log(flat[:, 0] / flat[:, 1]), np.log(flat[:, 2] / flat[:, 1])], 1)


def grey_edge(lin, p=6):
    """Grey-edge illuminant (1st order, Minkowski p): large flat coloured areas (floors, grass) carry no edges, so they barely count."""
    out = []
    for f in lin:
        b = blur1(blur1(f, 1.0, 0), 1.0, 1)
        g = np.hypot(np.diff(b, axis=1)[:-1], np.diff(b, axis=0)[:, :-1]).reshape(-1, 3)
        top = f[:-1, :-1].reshape(-1, 3).max(1); m = top < np.percentile(top, 99.5)
        if m.any(): out.append((g[m] ** p).mean(0) ** (1 / p))
    if not out: return np.zeros(2)  # every frame flat (black slug, solid matte): no edge evidence
    e = np.maximum(np.mean(out, 0), 1e-9)
    return np.log(e[[0, 2]] / e[1])


def analyse(lin):
    """Chroma maps of one shot: mass (brightness-weighted share of pixels within 0.06 ln of each chroma) and their mean brightness."""
    flat, y, ok = pixel_set(lin); uv = chroma(flat)
    key = np.median(y[ok]) if ok.any() else 1.0; rel = y / max(key, 1e-6)
    sel = ok & (rel > 2 ** -2.5) & (rel < 2 ** 4.5) & (np.abs(uv) < SPAN).all(1)
    w = np.clip(rel[sel], 0, 16) ** .6
    h, _, _ = np.histogram2d(uv[sel, 0], uv[sel, 1], bins=N, range=[[-SPAN, SPAN]] * 2, weights=w)
    hb, _, _ = np.histogram2d(uv[sel, 0], uv[sel, 1], bins=N, range=[[-SPAN, SPAN]] * 2, weights=w * rel[sel])
    near = conv2(h, DISK)
    return {'mass': np.maximum(near, 0) / max(w.sum(), 1e-9), 'bright': np.clip(conv2(hb, DISK) / np.maximum(near, 1e-9), 0, 20),
            'edge': grey_edge(lin), 'uv': uv[sel], 'w': w}


def _prior():
    t, k = U * TEMP_AXIS[0] + V * TEMP_AXIS[1], U * TINT_AXIS[0] + V * TINT_AXIS[1]
    return np.exp(-.5 * (t / np.where(t > 0, .30, .40)) ** 2 - .5 * (k / .12) ** 2)
PRIOR = _prior()


def white_balance(a, pooled, pooled_edge, sdr):
    """(applied cast, raw cast, confidence): the cast in ln(R/G), ln(B/G) that the Balance node cancels."""
    agree = lambda e, s: np.maximum(.25, np.exp(-.5 * ((U - e[0]) ** 2 + (V - e[1]) ** 2) / s ** 2))
    score = (a['mass'] * np.sqrt(a['bright']) + POOL * pooled) * PRIOR * agree(a['edge'], .22) * agree(pooled_edge, .3)
    i, j = np.unravel_index(np.argmax(score), score.shape); est = np.array([C[i], C[j]])
    for _ in range(4):  # mean shift on the pixels for sub-bin precision
        near = np.hypot(*(a['uv'] - est).T) < .06
        if near.sum() < 20: break
        est = (a['uv'][near] * a['w'][near, None]).sum(0) / a['w'][near].sum()
    far = np.hypot(U - C[i], V - C[j]) > .15
    ambiguity = float(score[far].max() / max(score[i, j], 1e-12)) if far.any() else 0.0
    conf = float(np.clip((a['mass'][i, j] + POOL * pooled[i, j] - .02) / .1, 0, 1) * np.clip(1.5 - ambiguity, .3, 1)) * (.5 if sdr else 1)
    return est * conf, est, conf


def gains_to_balance(uv, exposure):
    """Balance exposure/temperature/tint whose linear gains cancel the cast uv and then add `exposure` stops (a grey keeps its level)."""
    g = np.array([np.exp(-uv[0]), 1.0, np.exp(-uv[1])]); s = (g[0] + g[2]) / 2
    return {'exposure': float(exposure + np.log2(s / (DWG_Y @ g))), 'temperature': float(1e4 * (g[0] - g[2]) / (g[0] + g[2])), 'tint': float(200 * (1 - 1 / s))}


def balance_stage(b, lift, gamma=0.0, gain=1.0):
    """The Balance node exactly as processingStages emits it."""
    g = {'exposure': b['exposure'], 'temperature': b['temperature'], 'tint': b['tint'], 'contrast': 1, 'pivot': .336043, 'saturation': 1, 'lift': lift, 'gamma': gamma, 'gain': gain, 'offset': 0}
    return {'type': 'correction', 'g': g, 'extra': {}, 'node': {}, 'gamma': DI, 'gamut': 'DaVinci Wide Gamut', 'weights': DWG_Y.tolist(), 'nodeStart': True, 'nodeEnd': True}


def display(frames, post, b, lift=0.0, gamma=0.0, gain=1.0):
    """Display picture (Gamma 2.4) through the Balance and the shot's output."""
    stages = [balance_stage(b, lift, gamma, gain)] + post
    return np.stack([ca.graded(np.ascontiguousarray(f, np.float32), stages) for f in frames])


def luma(g24): return np.clip(g24, 0, 1) @ REC709_Y
def level(g24): return float(np.percentile(luma(g24), 60))  # mid-tone level: the middle of the 25-95th percentile band
WHITE_DI = float(engine.encode(np.array(1.0), DI))           # display white of a Rec.709 source in DaVinci Intermediate
def white_gain(gamma): return WHITE_DI ** (1 - 1 / 2 ** gamma)  # with this gain the Balance gamma moves mid-tones, not white or black


def robust_key(lin, uv):
    """Scene level in stops from 18% grey after the white balance: log average of the 25th-99th percentile, so a black sky or a
    dark backdrop does not drag a lit subject up."""
    g = np.exp(-np.array([uv[0], 0, uv[1]])); y = (lin.reshape(-1, 3) * g) @ DWG_Y / (DWG_Y @ g)
    y = y[y > 1e-5]
    if not len(y): return -6.0
    lo, hi = np.percentile(y, [25, 99]); s = y[(y >= lo) & (y <= hi)]
    return float(np.log2(np.exp(np.log(s).mean()) / .18)) if len(s) else -6.0


def level_offset(group_level):
    """How much brighter than the group's own level it ends up: dark groups a little more, already bright groups less or darker."""
    return float(np.interp(group_level, [-4, -1, .5, 1.5, 3], [.9, .75, .5, .1, -.6]))


def bisect(f, lo, hi, steps=7):
    """Largest x in [lo, hi] with f(x) true, f monotone (true below the answer)."""
    for _ in range(steps):
        mid = (lo + hi) / 2
        if f(mid): lo = mid
        else: hi = mid
    return lo


def finish_sdr(small, post, wb, target):
    """Display-referred footage (phones, finished video) has no highlight headroom: a mid-tone gamma with white and black pinned
    brings it to the group's level instead of exposure. Returns the Balance gamma."""
    at = lambda g: level(display(small, post, gains_to_balance(wb, 0), 0.0, g, white_gain(g)))
    return bisect(lambda g: at(g) < target, 0.0, 1.0) if at(0.0) < target else -bisect(lambda g: at(-g) > target, 0.0, .6)


def finish_levels(small, post, wb, e, sdr):
    """Highlight guard, then black point with mid-tones kept: (exposure, lift, stops held back, display level)."""
    clipped = lambda b, lift=0.0: float((display(small, post, b, lift).max(-1) >= .985).mean())
    base = clipped(gains_to_balance(wb, 0)); guarded = 0.0
    def guard(e, lift):
        if e <= 0 or clipped(gains_to_balance(wb, e), lift) <= base + .01: return e
        return bisect(lambda x: clipped(gains_to_balance(wb, x), lift) <= base + .01, 0.0, e)
    g = guard(e, 0.0); guarded += e - g; e = g
    deep = lambda x, lift: float(np.percentile(luma(display(small, post, gains_to_balance(wb, x), lift)), .5))
    lift = 0.0
    if deep(e, 0.0) > BLACK + .004 and not sdr:
        mid = float(np.median(luma(display(small, post, gains_to_balance(wb, e)))))
        for _ in range(2):
            lift = -bisect(lambda x: deep(e, -x) > BLACK, 0.0, LIMITS['lift'])
            # the lift also darkens mid-tones; buy them back with exposure, then redo the lift for the new exposure
            e = bisect(lambda x: np.median(luma(display(small, post, gains_to_balance(wb, x), lift))) < mid, e, min(LIMITS['exposure'], e + 1.0), 6)
        lift = -bisect(lambda x: deep(e, -x) > BLACK, 0.0, LIMITS['lift'])
        g = guard(e, lift); guarded += e - g; e = g
    return e, lift, guarded, level(display(small, post, gains_to_balance(wb, e), lift))


def solve(shots, frames, clipped, targets):
    lin = {s['clipId']: engine.decode(frames[s['clipId']], DI).astype(np.float32) for s in shots}  # frames arrive at half the analysis width
    A = {c: analyse(f) for c, f in lin.items()}
    setups = {}
    for s in shots: setups.setdefault(str(s.get('setup', '')), []).append(s['clipId'])
    setup = {c: k for k, ids in setups.items() for c in ids}
    pooled = {k: np.mean([A[c]['mass'] for c in ids], 0) for k, ids in setups.items()}
    pedge = {k: np.median([A[c]['edge'] for c in ids], 0) for k, ids in setups.items()}
    sdr = {s['clipId']: bool(s.get('sdr')) for s in shots}
    wb, raw, conf = {}, {}, {}
    for c in lin: wb[c], raw[c], conf[c] = white_balance(A[c], pooled[setup[c]], pedge[setup[c]], sdr[c])
    # same camera and light: small differences are estimation noise, large ones are real
    for ids in setups.values():
        m = np.median([wb[c] for c in ids], 0)
        for c in ids: d = wb[c] - m; n2 = float((d ** 2).sum()); wb[c] = m + d * n2 / (n2 + .07 ** 2)
    key = {c: robust_key(lin[c], wb[c]) for c in lin}
    frame_keys = {c: [robust_key(f[None], wb[c]) for f in lin[c]] for c in lin}
    group = float(np.median(list(key.values()))); target = group + level_offset(group)
    by_shot = {s['clipId']: s for s in shots}; out, failed = [], []
    answer = [c for c in lin if c in targets]
    small = {c: downscale(frames[c], 2) for c in lin}
    def levels(c):
        ms = float(np.median([key[x] for x in setups[setup[c]]]))
        e0 = float(np.clip((target - ms) + KAPPA * (ms - key[c]), -LIMITS['exposure'], LIMITS['exposure']))
        return finish_levels(small[c], by_shot[c]['postStages'], wb[c], e0, False)
    # Camera (scene-referred) shots first, in parallel (numpy and OpenColorIO release the GIL). Display-referred shots then meet
    # the camera shots' display level; context shots count only when there are display-referred shots to place.
    logs = [c for c in lin if not sdr[c] and (c in targets or any(sdr[x] for x in answer))]
    with ThreadPoolExecutor(max(1, min(8, (os.cpu_count() or 2) // 2))) as workers: done = dict(zip(logs, workers.map(levels, logs)))
    plain = {c: level(display(small[c], by_shot[c]['postStages'], gains_to_balance(wb[c], 0))) for c in lin if sdr[c]}
    goal = float(np.median([done[c][3] for c in logs])) if logs else min(.6, float(np.median(list(plain.values()) or [.3])) * 2 ** (level_offset(group) / 2.4))
    finished = {}
    for c in answer:
        if not sdr[c]: finished[c] = done[c][:3] + (0.0,); continue
        mine = float(np.median([plain[x] for x in setups[setup[c]]]))
        finished[c] = (0.0, 0.0, 0.0, finish_sdr(small[c], by_shot[c]['postStages'], wb[c], float(np.clip(goal + (1 - KAPPA) * (plain[c] - mine), .05, .65))))
    for n, c in enumerate(answer):
        e, lift, guarded, gamma = finished[c]
        b = gains_to_balance(wb[c], e)
        if not np.isfinite([*b.values(), lift, gamma, conf[c]]).all(): failed.append({'clipId': c, 'error': 'This shot could not be measured (no usable picture).'}); continue
        warnings = []
        if sdr[c]: warnings.append({'code': 'display-referred', 'text': 'Not camera log footage: corrected gently.'})
        elif conf[c] < .35: warnings.append({'code': 'low-confidence', 'text': 'No clear white or grey surfaces: white balance kept close to the camera\'s.'})
        if np.mean(clipped[c]) > .02: warnings.append({'code': 'clipping', 'text': f'{round(float(np.mean(clipped[c])) * 100)}% of the picture is clipped in the camera; those highlights stay white.'})
        swing = max(frame_keys[c]) - min(frame_keys[c])  # framing moves the level too: only a big swing is worth a look
        if swing > 1.5: warnings.append({'code': 'lighting-change', 'text': f'The picture gets {swing:.1f} stops brighter or darker within this shot, so one balance may not fit all of it.'})
        if guarded >= .5: warnings.append({'code': 'highlight-guard', 'text': f'Held back {guarded:.1f} stops so highlights do not clip.'})
        if abs(e) >= 2: warnings.append({'code': 'large-change', 'text': f'A large exposure change ({e:+.1f} stops): check this shot.'})
        out.append({'clipId': c, 'balance': {'exposure': round(float(np.clip(b['exposure'], -LIMITS['exposure'] - 1, LIMITS['exposure'] + 1)), 3),
                    'temperature': round(float(np.clip(b['temperature'], -LIMITS['temperature'], LIMITS['temperature']))),
                    'tint': round(float(np.clip(b['tint'], -LIMITS['tint'], LIMITS['tint'])), 1), 'lift': round(float(lift), 4),
                    'gamma': round(float(gamma), 4), 'gain': round(float(white_gain(gamma)), 4)},
                    'confidence': round(conf[c], 2), 'key': round(key[c], 2), 'cast': [round(float(v), 3) for v in raw[c]], 'warnings': warnings})
        ca.progress(60 + 39 * (n + 1) / max(1, len(answer)))
    return {'shots': out, 'failed': failed, 'level': {'group': round(group, 2), 'target': round(target, 2), 'display': round(goal, 3)}}


def normalize(job):
    ff, cache, width = job.get('ffmpeg', 'ffmpeg'), job['cacheDir'], int(job.get('width', 640))
    if width < 16 or width > 4096 or width % 2: raise ValueError('Invalid analysis width')
    shots, frames, clipped, failed = [], {}, {}, []
    cubes = job.get('hdrCubes') or {}
    for n, shot in enumerate(job['shots']):
        if isinstance(shot.get('hdrCube'), str): shot = {**shot, 'hdrCube': cubes[shot['hdrCube']]}  # one shared table per HDR transfer
        # only half the analysis width is kept: 300 shots of 4K would otherwise hold gigabytes
        try: f, clipped[shot['clipId']], _ = ca.working_frames(ff, cache, width, shot); frames[shot['clipId']] = downscale(f, 2); shots.append(shot)
        except (RuntimeError, ValueError) as error: failed.append({'clipId': shot['clipId'], 'error': str(error)[:300]})
        ca.progress(60 * (n + 1) / len(job['shots']))
    targets = set(job.get('targets') or [s['clipId'] for s in job['shots']])
    result = solve(shots, frames, clipped, targets) if shots else {'shots': [], 'failed': [], 'level': None}
    return {**result, 'failed': [f for f in failed + result['failed'] if f['clipId'] in targets]}


def selftest():
    """Synthetic gym shots through the real cache, engine and solver."""
    started = time.time(); ff = os.environ.get('FFMPEG_PATH') or 'ffmpeg'
    with open(os.path.join(HERE, 'color-assistant-fixture.json'), encoding='utf-8') as f: fx = json.load(f)
    pre = fx['preStages']; post = [s for s in fx['postStages'] if s['node'].get('name') not in ('Balance', 'Look')]
    h, w = 180, 320
    WHITE, WOOD, SKIN = np.array([.85, .85, .85]), np.array([.45, .30, .17]), np.array([.42, .29, .22])
    def scene(cast=(1, 1, 1), gain=1.0, flare=0.0, light=None, seed=0):
        r = np.random.default_rng(seed); lin = np.empty((h, w, 3), np.float32)
        lin[:] = WOOD                                   # a wood floor over most of the frame
        lin[:50] = [.18, .18, .18]                      # grey wall
        lin[:12] = .03                                  # dark top
        for x in range(10, w - 30, 46):                 # players: white jerseys, skin, black shorts
            lin[60:110, x:x + 22] = WHITE; lin[48:60, x + 6:x + 16] = SKIN; lin[110:128, x:x + 22] = .03
        lin[150:154] = WHITE                            # court line
        lin *= (1 + .08 * r.standard_normal((h, w, 1))).clip(.6, 1.4)        # texture, so edges exist
        lin *= np.linspace(.8, 1.15, w)[None, :, None]                         # uneven light
        if light is not None: lin = lin * np.array(light, np.float32)        # coloured stage light: no neutral anywhere
        lin = lin * np.array(cast, np.float32) * gain + flare
        return np.clip(engine.encode(lin.astype(np.float32), 'S-Log3'), 0, 1)
    cases = {'A': {}, 'B': {'cast': (1.35, 1, .7)}, 'C': {'gain': .5}, 'D': {'light': (1.5, .45, 1.4)}, 'E': {'flare': .012}, 'F': {'gain': .3}}
    # F: a dim phone clip, display-referred Rec.709 with a lamp at white: no headroom to push exposure into
    def xyz(p):
        m = np.array([[x / y for x, y in p], [1, 1, 1], [(1 - x - y) / y for x, y in p]]); return m * np.linalg.solve(m, [.3127 / .329, 1, (1 - .3127 - .329) / .329])
    r709, dwg = xyz([[.64, .33], [.3, .6], [.15, .06]]), xyz([[.8, .313], [.1682, .9877], [.079, -.1155]])
    neutral = lambda gamma, gamut, w: {'type': 'correction', 'g': dict(pre[0]['g']), 'extra': {}, 'node': {'name': 'n'}, 'gamma': gamma, 'gamut': gamut, 'weights': w, 'nodeStart': True, 'nodeEnd': False}
    cst = lambda a, b, m, w: {'type': 'cst', 'effect': {'inputGamma': a[0], 'inputGamut': a[1], 'outputGamma': b[0], 'outputGamut': b[1], 'toneMapping': 'none', 'gamutMapping': 'none'}, 'node': {'name': 'n'}, 'matrix': m.tolist(), 'weights': w, 'nodeStart': False, 'nodeEnd': True}
    pre709 = [neutral('Rec.709', 'Rec.709', r709[1].tolist()), cst(('Rec.709', 'Rec.709'), (DI, 'DaVinci Wide Gamut'), np.linalg.inv(dwg) @ r709, dwg[1].tolist())]
    post709 = [neutral(DI, 'DaVinci Wide Gamut', dwg[1].tolist()), cst((DI, 'DaVinci Wide Gamut'), ('Gamma 2.4', 'Rec.709'), np.linalg.inv(r709) @ dwg, r709[1].tolist())]
    tmp = tempfile.mkdtemp(prefix='frameline-normalize-')
    try:
        video, cache = os.path.join(tmp, 'synthetic.mkv'), os.path.join(tmp, 'cache')
        def phone(seed):
            lin = engine.decode(scene(seed=seed, gain=.3), 'S-Log3'); lin[14:22, 100:220] = 1.0  # a lamp at display white
            return np.clip(lin, 0, 1) ** (1 / 2.4)
        frames = [phone(i) if k == 'F' else scene(seed=i, **kw) for k, kw in cases.items() for i in range(3)]
        raw = b''.join(np.rint(np.clip(f, 0, 1) * 65535).astype('<u2').tobytes() for f in frames)
        subprocess.run([ff, '-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb48le', '-video_size', f'{w}x{h}', '-framerate', '2', '-i', '-',
                        '-c:v', 'ffv1', '-pix_fmt', 'gbrp16le', video], input=raw, check=True)
        shot = lambda i, k: {'clipId': k, 'key': 'norm-' + k, 'input': video, 'matrix': 'bt709', 'range': 'pc', 'times': [(i * 3 + j) / 2 for j in range(3)],
                             'preStages': pre709 if k == 'F' else pre, 'postStages': post709 if k == 'F' else post, 'setup': {'D': 'stage', 'F': 'phone'}.get(k, 'cam'), 'sdr': k == 'F'}
        job = {'ffmpeg': ff, 'cacheDir': cache, 'width': w, 'shots': [shot(i, k) for i, k in enumerate(cases)]}
        full = normalize(job); res = {s['clipId']: s for s in full['shots']}
        report = {k: {**v['balance'], 'conf': v['confidence'], 'warn': [x['code'] for x in v['warnings']]} for k, v in res.items()}
        gains = lambda b: 2 ** b['exposure'] * np.array([1 + b['temperature'] / 1e4, 1 - b['tint'] / 200, 1 - b['temperature'] / 1e4])
        # the cast was applied in camera space: carry the white through the Input CST before the Balance gains
        white_dwg = engine.decode(ca.graded(engine.encode((WHITE * np.array(cases['B']['cast'])).astype(np.float32)[None, None], 'S-Log3'), pre), DI)[0, 0]
        white_after = white_dwg * gains(res['B']['balance'])
        report['whiteB'] = [round(float(np.log(white_after[0] / white_after[1])), 3), round(float(np.log(white_after[2] / white_after[1])), 3)]
        assert abs(res['A']['balance']['temperature']) < 300 and abs(res['A']['balance']['tint']) < 8, ('wood floor must stay warm', report)
        assert max(map(abs, report['whiteB'])) < .05, ('warm cast: whites must come out neutral', report)
        assert .35 < res['C']['balance']['exposure'] - res['A']['balance']['exposure'] < 1.1, ('a stop darker copy is lifted toward the others', report)
        assert abs(res['D']['balance']['temperature']) < 900 and 'low-confidence' in report['D']['warn'], ('coloured light stays as shot', report)
        assert res['E']['balance']['lift'] < -.004 and res['A']['balance']['lift'] >= res['E']['balance']['lift'], ('lifted blacks come down', report)
        f, fb = np.load(os.path.join(cache, 'norm-F.npy')), res['F']['balance']
        lamp = lambda g24: float((g24[:, 14:22, 100:220].max(-1) >= .985).mean())
        before, after = display(f, post709, {'exposure': 0, 'temperature': 0, 'tint': 0}), display(f, post709, fb, fb['lift'], fb['gamma'], fb['gain'])
        report['phone'] = {'level': [round(level(before), 3), round(level(after), 3)], 'goal': full['level']['display'], 'lamp': [lamp(before), lamp(after)]}
        assert fb['gamma'] > .1 and abs(fb['exposure']) < .15 and abs(level(after) - full['level']['display']) < .06, ('phone clip meets the camera shots by mid-tones', report)
        assert lamp(after) >= lamp(before) - .02 and float((after.max(-1) >= .985).mean()) <= float((before.max(-1) >= .985).mean()) + .01, ('phone highlights neither clip nor dim', report)
        black = np.zeros((h, w, 3), np.float32)
        bvideo = os.path.join(tmp, 'black.mkv')
        subprocess.run([ff, '-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb48le', '-video_size', f'{w}x{h}', '-framerate', '2', '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'gbrp16le', bvideo],
                       input=b''.join(np.rint(np.clip(engine.encode(x, 'S-Log3'), 0, 1) * 65535).astype('<u2').tobytes() for x in [black, black, black]), check=True)
        withblack = normalize({**job, 'shots': [*job['shots'], {**shot(0, 'A'), 'clipId': 'K', 'key': 'norm-K', 'input': bvideo, 'times': [0, .5, 1]}]})
        assert {s['clipId'] for s in withblack['shots']} >= set(res) and all(np.isfinite(list(s['balance'].values())).all() for s in withblack['shots']), ('a black context shot sinks the rest', withblack['failed'])
        only = normalize({**job, 'targets': ['A']})['shots']
        assert [s['clipId'] for s in only] == ['A'] and only[0]['balance'] == res['A']['balance'], ('targets answer for the same group', only)
        report['seconds'] = round(time.time() - started, 2)
        assert report['seconds'] < 60, ('selftest too slow', report['seconds'])
        print(json.dumps({'ok': True, **report}))
    finally: shutil.rmtree(tmp, ignore_errors=True)


def main(argv):
    if argv[1:] == ['--selftest']: return selftest()
    if len(argv) != 3 or argv[1] != 'normalize': print(__doc__, file=sys.stderr); sys.exit(2)
    try:
        with open(argv[2], encoding='utf-8') as f: result = normalize(json.load(f))
    except Exception as error:  # the server shows the last stderr line
        print(str(error) if isinstance(error, (RuntimeError, ValueError)) else f'{type(error).__name__}: {error}', file=sys.stderr, flush=True); sys.exit(1)
    print(json.dumps(result, allow_nan=False, separators=(',', ':')), flush=True)


if __name__ == '__main__': main(sys.argv)
