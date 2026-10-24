#!/usr/bin/env python3
"""SharedCut Color Assistant worker: working-space frame cache, measurements, proposal stills, match first guess.

Usage:
  color-assistant.py measure job.json   decode + grade to the Balance node (cached), measure every frame
  color-assistant.py render job.json    grade cached frames with proposal stages, write viewer-exact JPEG stills
  color-assistant.py match job.json     deterministic Balance first guess matching targets to a reference
  color-assistant.py --selftest         synthetic S-Log3 round trip, exit 0 on success

One JSON result goes to stdout; progress lines {"progress": n} go to stderr. Every transform is the export engine's
grade() from color-render.py run on stages built by processingStages() in src/services/color.ts: this file adds
measurements, never a second color implementation. Cross-platform: ffmpeg is reached through the path the job names,
paths only ever travel as argv, never inside a filtergraph.
"""
import importlib.util, io, json, os, re, shutil, subprocess, sys, tempfile, time, uuid
from concurrent.futures import ThreadPoolExecutor
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('color_render', os.path.join(HERE, 'color-render.py'))
engine = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(engine)
DI = 'DaVinci Intermediate'
DWG_Y = [0.2741185109066489, 0.8736318959404368, -0.14775040684708576]  # luminanceWeights('DaVinci Wide Gamut')
LIMITS = {'exposure': 3, 'temperature': 2000, 'tint': 100, 'delta': 0.4}
MATRICES, RANGES = {'bt709', 'bt470bg', 'smpte170m', 'bt2020nc', 'auto'}, {'pc', 'tv', 'auto'}
pool = ThreadPoolExecutor(os.cpu_count() or 1)
decoders = ThreadPoolExecutor(3)  # ponytail: 3 concurrent source decodes; each 4K decoder holds a few hundred MB


def progress(value): print(json.dumps({'progress': round(min(99.0, value), 1)}), file=sys.stderr, flush=True)
def num(v): return None if v is None else round(float(v), 5)
def one_line(stderr): return ' '.join(stderr.decode('utf-8', 'replace').split())[-300:]  # the server shows only the last line
def cache_path(cache, key):
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key): raise ValueError('Invalid cache key')
    return os.path.join(cache, key)


def replace_atomic(path, data):
    tmp = f'{path}.{uuid.uuid4().hex}.tmp'
    with open(tmp, 'wb') as f: f.write(data)
    for attempt in range(6):  # Windows scanners briefly lock fresh files
        try: return os.replace(tmp, path)
        except PermissionError:
            if attempt == 5: os.remove(tmp); raise
            time.sleep(.05 * 2 ** attempt)


def graded(rgb, stages):
    """grade_frame() on a copy of the frame, exactly like process_frames: 64-row stripes (numpy/OCIO release the GIL), a window
    placed by each stripe's rows, Dehaze and Clarity from the whole picture entering their node, so Assistant stills and Normalize
    measure what export shows. Film stages are dropped (stills and measurements read the grade without grain, glow or weave)."""
    return engine.grade_frame(np.array(rgb, np.float32), [s for s in stages if s['type'] != 'film'], None, True, 0, pool)


def decode_frame(ff, shot, t, width):
    if shot['matrix'] not in MATRICES or shot['range'] not in RANGES: raise ValueError('Invalid color matrix or range')
    # flags=area: bicubic overshoots at a clipped edge, so the plateau test would find only the ringing peak on 4K sources.
    vf = f"scale={width}:-2:in_color_matrix={shot['matrix']}:in_range={shot['range']}:flags=area,format=gbrpf32le"
    p = subprocess.run([ff, '-v', 'error', '-ss', f'{max(0.0, float(t)):.6f}', '-i', shot['input'], '-frames:v', '1', '-an', '-vf', vf, '-f', 'rawvideo', '-'], capture_output=True)
    h = len(p.stdout) // (width * 12)
    if p.returncode or not h or len(p.stdout) != width * h * 12:
        raise RuntimeError(f'Could not decode a frame at {float(t):.3f} s: ' + one_line(p.stderr))
    return np.ascontiguousarray(np.frombuffer(p.stdout, '<f4').reshape(3, h, width)[[2, 0, 1]].transpose(1, 2, 0))


def clipped_fraction(src, profile):
    """Plateau at the frame's top code value, counted only when that code is brighter than scene linear 1.0."""
    top = src.max(axis=-1); peak = float(top.max()); frac = float((top >= peak - 1.5 / 1023).mean())
    return frac if frac >= .001 and float(engine.decode(np.array(peak), profile)) > 1 else 0.0


def working_frames(ff, cache, width, shot):
    """(frames n*h*w*3 float32 in the working space, clipped fraction per frame, loaded from cache)."""
    path, times, pre = cache_path(cache, shot['key']), shot['times'], shot['preStages']
    if os.path.exists(path + '.npy') and os.path.exists(path + '.json'):
        try:
            frames = np.load(path + '.npy')
            with open(path + '.json', encoding='utf-8') as f: meta = json.load(f)
            if frames.ndim == 4 and len(frames) == len(times) == len(meta['clipped']): return frames, meta['clipped'], True
        except (OSError, ValueError, KeyError): pass  # unreadable entry: rebuild it
    if not times: raise ValueError('A shot needs at least one frame time')
    sources = list(decoders.map(lambda t: decode_frame(ff, shot, t, width), times))
    profile = next((s['effect']['inputGamma'] for s in pre if s['type'] == 'cst'), pre[0].get('gamma', 'Gamma 2.4') if pre else 'Gamma 2.4')
    clipped = [clipped_fraction(s, profile) for s in sources]
    # HLG/PQ sources: the export's HDR -> SDR table first (hdrToSdr in color.ts), so the grade sees what export sees.
    if shot.get('hdrCube'): sources = [engine.lut(s, {'cube': shot['hdrCube'], 'amount': 1}).astype(np.float32) for s in sources]
    frames = np.stack([graded(s, pre) for s in sources]).astype(np.float32)
    os.makedirs(cache, exist_ok=True)
    replace_atomic(path + '.json', json.dumps({'times': times, 'clipped': clipped}).encode())
    buffer = io.BytesIO(); np.save(buffer, frames)
    replace_atomic(path + '.npy', buffer.getvalue())  # written last: its presence means the entry is complete
    return frames, clipped, False


def ratios(pixels):
    s = pixels.sum(0, dtype=np.float64) if len(pixels) else None
    return {'rg': num(s[0] / s[1]), 'bg': num(s[2] / s[1])} if s is not None and s[1] > 0 else None


def measure_frame(di, weights, to709=None):
    flat = di.reshape(-1, 3)
    lin = engine.decode(flat, DI); y = lin @ np.asarray(weights, np.float32)
    stops = np.log2(np.maximum(y, 1e-6) / .18)
    shadows, highs = stops < -2.5, stops > 1; mids = ~shadows & ~highs
    with np.errstate(divide='ignore', invalid='ignore'):
        lr, lb = np.log(lin[:, 0] / lin[:, 1]), np.log(lin[:, 2] / lin[:, 1])
    # ponytail: "neutral" = mid pixels within ±0.3 ln of green (tolerates ~±1500 K casts); skin can bias it warm.
    grey = mids & (lin > 0).all(1) & (np.abs(lr) < .3) & (np.abs(lb) < .3)
    neutral = ratios(lin[grey]) if grey.mean() >= .02 else None
    # A second witness: the brightest unclipped near-neutral surfaces (white shirts, paper, court lines), least-chroma half around their median.
    # Warm floors and skin pull the near-grey average; whites often tell the truth there. Neither is always right: the model judges from the stills.
    cand = (lin > 0).all(1) & (stops > -1) & (stops < 3.5) & (np.abs(lr) < .6) & (np.abs(lb) < .6)
    whites = None
    if cand.mean() >= .01:
        top = cand & (y >= np.percentile(y[cand], 80)); c = np.hypot(lr - np.median(lr[top]), lb - np.median(lb[top]))
        core = top & (c <= np.percentile(c[top], 50))
        whites = ratios(lin[core]) if core.mean() >= .002 else None
    for estimate in (neutral, whites):
        if estimate:
            rg, bg = estimate['rg'], estimate['bg']; k = 2 / (1 / rg + 1 / bg)
            estimate.update(temperature=num(np.clip(1e4 * (k / rg - 1), -4000, 4000)), tint=num(np.clip(200 * (1 - k), -100, 100)))
    pct = np.percentile(flat, [10, 50, 90], axis=0)
    out = {'stops': dict(zip(('p1', 'p10', 'p50', 'p90', 'p99'), map(num, np.percentile(stops, [1, 10, 50, 90, 99])))),
           'shadows': ratios(lin[shadows]), 'mids': ratios(lin[mids]), 'highlights': ratios(lin[highs]), 'neutral': neutral, 'whites': whites,
           'channels': {c: {'p10': num(pct[0, i]), 'p50': num(pct[1, i]), 'p90': num(pct[2, i])} for i, c in enumerate('rgb')}}
    if to709 is not None:
        v = np.clip(np.maximum(lin @ np.asarray(to709, np.float32).T, 0) ** (1 / 2.4), 0, 1)
        mx, mn = v.max(1), v.min(1); d = np.maximum(mx - mn, 1e-9); sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0)
        r, g, b = v.T
        hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
        skin = (hue <= 50) & (sat >= .15) & (sat <= .7) & (mx > .2)
        out['skin'] = {'fraction': num(skin.mean()), 'hue': num(hue[skin].mean()) if skin.any() else None}
        out['saturation'] = {'p50': num(np.percentile(sat, 50)), 'p90': num(np.percentile(sat, 90))}
    return out


def median(items):
    items = [i for i in items if i is not None]
    if not items: return None
    if isinstance(items[0], dict): return {k: median([i.get(k) for i in items]) for k in items[0]}
    return num(np.median(items))


def summary(per):
    spread = lambda v: num(max(v) - min(v)) if v else 0.0
    band = lambda c: [f['neutral'][c] for f in per if f['neutral']]  # near-grey white balance: framing changes move the mid-tone average, not this
    variation = {'p50StopsRange': spread([f['stops']['p50'] for f in per]), 'rgRange': spread(band('rg')), 'bgRange': spread(band('bg'))}
    return {**median([{k: v for k, v in f.items() if k != 'time'} for f in per]), 'variation': variation,
            'lightingChange': bool(variation['p50StopsRange'] > .5 or variation['rgRange'] > .08 or variation['bgRange'] > .08)}


def measure(job):
    ff, cache, width = job.get('ffmpeg', 'ffmpeg'), job['cacheDir'], int(job.get('width', 640))
    if width < 16 or width > 4096 or width % 2: raise ValueError('Invalid analysis width')
    weights, to709, shots = job.get('weights', DWG_Y), job['toRec709'], []
    for n, shot in enumerate(job['shots']):
        try: frames, clipped, cached = working_frames(ff, cache, width, shot)
        except (RuntimeError, ValueError) as error:  # one unreadable shot must not sink the others; the server skips it
            shots.append({'clipId': shot['clipId'], 'error': str(error)[:300]}); progress((n + 1) / len(job['shots']) * 100); continue
        per = [{'time': t, **measure_frame(f, weights, to709), 'clipped': num(c)} for t, f, c in zip(shot['times'], frames, clipped)]
        shots.append({'clipId': shot['clipId'], 'key': shot['key'], 'frames': len(frames), 'width': frames.shape[2], 'height': frames.shape[1],
                      'cached': cached, 'stats': summary(per), 'perFrame': per})
        progress((n + 1) / len(job['shots']) * 100)
    return {'shots': shots}


def viewer_codes(g24):
    """What the viewer shows for an ACES 2 grade: Gamma 2.4 display -> sRGB, 8-bit, no dither (srgb_from_g24)."""
    lin = np.maximum(g24, 0) ** 2.4
    return np.rint(np.clip(np.where(lin > .0031308, 1.055 * lin ** (1 / 2.4) - .055, 12.92 * lin), 0, 1) * 255).astype(np.uint8)


def write_jpeg(ff, codes, out):
    h, w = codes.shape[:2]
    p = subprocess.run([ff, '-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', f'{w}x{h}', '-i', '-',
                        '-frames:v', '1', '-update', '1', '-q:v', '3', out], input=codes.tobytes(), capture_output=True)
    if p.returncode: raise RuntimeError('Could not encode a still: ' + one_line(p.stderr))


def read_codes(ff, path, shape):
    p = subprocess.run([ff, '-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True)
    if p.returncode or len(p.stdout) != int(np.prod(shape)): raise RuntimeError('Could not read the still to compare with: ' + one_line(p.stderr))
    return np.frombuffer(p.stdout, np.uint8).reshape(shape)


def hsv(v):
    mx, mn = v.max(1), v.min(1); d = np.maximum(mx - mn, 1e-9); r, g, b = v.T
    hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    return hue, np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0), mx


def display_check(codes, before):
    """What a colorist checks on the monitor: shares of pure black and pure white, before and after, and the mean hue shift
    (degrees, minus = toward magenta) of the pixels that were skin-like before; None when under 0.5% of the frame is skin."""
    v, w = (np.asarray(c, np.float32).reshape(-1, 3) / 255 for c in (codes, before))
    black, white = lambda x: num((x.max(1) <= 2 / 255).mean()), lambda x: num((x.max(1) >= 254 / 255).mean())
    h0, s0, m0 = hsv(w); skin = (h0 <= 50) & (s0 >= .15) & (s0 <= .7) & (m0 > .2)
    shift = num(np.mean((hsv(v[skin])[0] - h0[skin] + 180) % 360 - 180)) if skin.mean() > .005 else None
    return {'crushed': black(v), 'clipped': white(v), 'crushedBefore': black(w), 'clippedBefore': white(w), 'skinShift': shift}


def render(job):
    """Optional still['compare'] = an earlier still of the same frame: adds meanDiff, the mean absolute 8-bit change from it,
    and colorDiff, the part of that change that moves the channels apart (hue and saturation, not brightness)."""
    ff, loaded, out = job.get('ffmpeg', 'ffmpeg'), {}, []
    for n, still in enumerate(job['stills']):
        key = still['key']
        if key not in loaded: loaded[key] = np.load(cache_path(job['cacheDir'], key) + '.npy')
        frames, i = loaded[key], int(still['frame'])
        if not 0 <= i < len(frames): raise ValueError('Still frame is outside the cached frames')
        codes = viewer_codes(graded(frames[i], still['stages']))
        write_jpeg(ff, codes, still['out'])
        pct = np.percentile(codes.reshape(-1, 3), [10, 50, 90], axis=0)
        out.append({'out': still['out'], 'width': codes.shape[1], 'height': codes.shape[0],
                    'stats': {c: {'p10': num(pct[0, j]), 'p50': num(pct[1, j]), 'p90': num(pct[2, j])} for j, c in enumerate('rgb')}})
        if still.get('compare'):
            before = read_codes(ff, still['compare'], codes.shape); d = codes.astype(np.int16) - before
            out[-1].update(meanDiff=round(float(np.abs(d).mean()), 2), colorDiff=round(float(np.abs(d - d.mean(-1, keepdims=True)).mean()), 2), check=display_check(codes, before))
        progress((n + 1) / len(job['stills']) * 100)
    return {'stills': out}


def balance_stages(b, weights):
    """The Balance node exactly as processingStages emits it (master values neutral), for grade()."""
    g = {'exposure': b['exposure'], 'temperature': b['temperature'], 'tint': b['tint'], 'contrast': 1, 'pivot': .336043, 'saturation': 1, 'lift': 0, 'gamma': 0, 'gain': 1, 'offset': 0}
    extra = {k + c.upper(): b[k][c] for k in ('lift', 'gamma', 'gain', 'offset') for c in 'rgb'}
    return [{'type': 'correction', 'g': g, 'extra': extra, 'node': {}, 'gamma': DI, 'gamut': 'DaVinci Wide Gamut', 'weights': list(weights), 'nodeStart': True, 'nodeEnd': True}]


def neutral_balance(): return {'exposure': 0.0, 'temperature': 0.0, 'tint': 0.0, **{k: {c: 0.0 for c in 'rgb'} for k in ('lift', 'gamma', 'gain', 'offset')}}
def levels(frames, weights, balance=None):
    return median([measure_frame(graded(f, balance_stages(balance, weights)) if balance else f, weights) for f in frames])


def first_guess(ref, frames, weights, limits):
    lim = {**LIMITS, **(limits or {})}; clamp = lambda v, m: num(np.clip(v, -m, m))
    tgt, b = levels(frames, weights), neutral_balance()
    # White balance: map target neutral ratios onto the reference's (mid band when either lacks a neutral).
    band = 'neutral' if ref['neutral'] and tgt['neutral'] else 'mids'
    if ref[band] and tgt[band] and tgt[band]['rg'] > 0 and tgt[band]['bg'] > 0:
        a, c = ref[band]['rg'] / tgt[band]['rg'], ref[band]['bg'] / tgt[band]['bg']; k = 2 / (a + c)
        b.update(temperature=clamp(1e4 * (a * k - 1), lim['temperature']), tint=clamp(200 * (1 - k), lim['tint']))
    b['exposure'] = clamp(ref['stops']['p50'] - levels(frames, weights, b)['stops']['p50'], lim['exposure'])
    # Per-channel lift/gain on DI values: out = lift + v*(gain - lift) maps target p10/p90 onto the reference's.
    now = levels(frames, weights, b)['channels']
    for c in 'rgb':
        t10, t90, r10, r90 = now[c]['p10'], now[c]['p90'], ref['channels'][c]['p10'], ref['channels'][c]['p90']
        if t90 - t10 < 1e-3: continue
        s = (r90 - r10) / (t90 - t10); lift = r10 - t10 * s
        b['lift'][c], b['gain'][c] = clamp(lift, lim['delta']), clamp(s + lift - 1, lim['delta'])
    matched = levels(frames, weights, b)['channels']
    residual = np.mean([abs(ref['channels'][c][p] - matched[c][p]) for c in 'rgb' for p in ('p10', 'p50', 'p90')])
    return b, num(residual)


def match(job):
    cache, weights = job['cacheDir'], job.get('weights', DWG_Y)
    ref = levels(np.load(cache_path(cache, job['reference']['key']) + '.npy'), weights); out = []
    for n, t in enumerate(job['targets']):
        balance, residual = first_guess(ref, np.load(cache_path(cache, t['key']) + '.npy'), weights, job.get('limits'))
        out.append({'clipId': t['clipId'], 'balance': balance, 'residual': residual})
        progress((n + 1) / len(job['targets']) * 100)
    return {'targets': out}


def selftest():
    started = time.time(); ff = os.environ.get('FFMPEG_PATH') or 'ffmpeg'
    with open(os.path.join(HERE, 'color-assistant-fixture.json'), encoding='utf-8') as f: fx = json.load(f)
    pre, post, weights, to709 = fx['preStages'], fx['postStages'], fx['weights'], fx['toRec709']
    h, w = 360, 640
    def scene(gain=1.0, cast=(1, 1, 1), curve='S-Log3'):
        lin = np.full((h, w, 3), .18, np.float32)  # 66% 18% grey
        lin[:60] = .01                             # deep shadows
        lin[60:110, :320] = [.30, .18, .10]         # warm patch
        lin[60:110, 320:] = [.35, .22, .15]         # skin-like patch
        code = engine.encode(lin * gain * np.array(cast, np.float32), curve)
        code[348:] = .94                           # clipped plateau (decodes to ~22x scene white)
        return code
    # Shots: A normal, B warm cast, C lighting change (+1 stop halfway), D one stop darker than A.
    shots = {'A': [scene()] * 4, 'B': [scene(cast=(1.25, 1, .8))] * 4, 'C': [scene()] * 2 + [scene(2.0)] * 2, 'D': [scene(.5)] * 4}
    tmp = tempfile.mkdtemp(prefix='frameline-color-assistant-')
    try:
        video, cache = os.path.join(tmp, 'synthetic.mkv'), os.path.join(tmp, 'cache')
        frames = [f for v in shots.values() for f in v]
        raw = b''.join(np.rint(np.clip(f, 0, 1) * 65535).astype('<u2').tobytes() for f in frames)
        subprocess.run([ff, '-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb48le', '-video_size', f'{w}x{h}', '-framerate', '2', '-i', '-',
                        '-c:v', 'ffv1', '-pix_fmt', 'gbrp16le', video], input=raw, check=True)
        job = {'ffmpeg': ff, 'cacheDir': cache, 'width': w, 'weights': weights, 'toRec709': to709,
               'shots': [{'clipId': k, 'key': 'shot-' + k, 'input': video, 'matrix': 'bt709', 'range': 'pc', 'times': [(i * 4 + j) / 2 for j in range(4)], 'preStages': pre}
                         for i, k in enumerate(shots)]}
        first = {s['clipId']: s for s in measure(job)['shots']}
        a, b, c, d = (first[k]['stats'] for k in 'ABCD')
        report = {'p50A': a['stops']['p50'], 'p50D': d['stops']['p50'], 'clippedA': a['clipped'], 'neutralB': b['neutral'], 'midsB': b['mids'],
                  'skinA': a['skin'], 'variationC': c['variation']}
        assert all(s['frames'] == 4 and s['width'] == w and s['height'] == h and not s['cached'] for s in first.values()), 'shape or cache flag'
        assert abs(a['stops']['p50']) < .1, ('18% grey should measure 0 stops', a['stops'])
        assert abs(d['stops']['p50'] + 1) < .1, ('darker copy should measure -1 stop', d['stops'])
        assert .02 < a['clipped'] < .05 and not a['lightingChange'], ('clipped plateau', a['clipped'], a['variation'])
        assert abs(a['neutral']['rg'] - 1) < .02 and abs(a['neutral']['bg'] - 1) < .02, ('neutral grey', a['neutral'])
        assert a['mids']['rg'] > 1 and a['skin']['fraction'] > .02, ('warm patch and skin', a['mids'], a['skin'])
        assert b['neutral']['rg'] > 1.1 and b['neutral']['bg'] < .9 and b['neutral']['temperature'] < 0, ('warm cast', b['neutral'])
        assert c['lightingChange'] and abs(c['variation']['p50StopsRange'] - 1) < .1, ('lighting change', c['variation'])
        # Apple Log (iPhone): the same scene through its curve measures the same stops (the S-Gamut3.Cine matrix kept from the fixture leaves grey neutral).
        apple, iphone = json.loads(json.dumps(pre).replace('"S-Log3"', '"Apple Log"')), os.path.join(tmp, 'apple-log.mkv')
        subprocess.run([ff, '-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb48le', '-video_size', f'{w}x{h}', '-framerate', '2', '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'gbrp16le', iphone],
                       input=b''.join(np.rint(np.clip(scene(g, curve='Apple Log'), 0, 1) * 65535).astype('<u2').tobytes() for g in [1, 1, .5, .5]), check=True)
        logs = {s['clipId']: s['stats'] for s in measure({**job, 'shots': [{**job['shots'][0], 'clipId': k, 'key': 'apple-' + k, 'input': iphone, 'times': [i, i + .5], 'preStages': apple} for i, k in enumerate('AD')]})['shots']}
        report.update(p50AppleA=logs['A']['stops']['p50'], p50AppleD=logs['D']['stops']['p50'], clippedApple=logs['A']['clipped'])
        assert abs(logs['A']['stops']['p50']) < .1 and abs(logs['D']['stops']['p50'] + 1) < .1 and .02 < logs['A']['clipped'] < .05, ('Apple Log stops', report)
        # Second run is served from the cache: the source is gone and the numbers are identical.
        os.replace(video, video + '.gone')
        again = {s['clipId']: s for s in measure(job)['shots']}
        assert all(s['cached'] and s['stats'] == first[s['clipId']]['stats'] for s in again.values()), 'cache not reused'
        # An unreadable shot is reported on its own, in one line; the others still measure.
        broken = measure({**job, 'shots': [{**job['shots'][0], 'clipId': 'E', 'key': 'shot-E', 'input': video}, job['shots'][0]]})['shots']
        assert 'Could not decode a frame' in broken[0]['error'] and '\n' not in broken[0]['error'] and broken[1]['cached'], ('per-shot error', broken[0])
        # A 2x source is downscaled for analysis: the clipped plateau must survive it (bicubic ringing hid it).
        big = os.path.join(tmp, 'big.mkv')
        subprocess.run([ff, '-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb48le', '-video_size', f'{w * 2}x{h * 2}', '-i', '-', '-c:v', 'ffv1', '-pix_fmt', 'gbrp16le', big],
                       input=np.rint(np.clip(np.repeat(np.repeat(scene(), 2, 0), 2, 1), 0, 1) * 65535).astype('<u2').tobytes(), check=True)
        report['clippedDownscaled'] = clipped_fraction(decode_frame(ff, {'matrix': 'bt709', 'range': 'pc', 'input': big}, 0, w), 'S-Log3')
        assert report['clippedDownscaled'] > .01, ('clipping lost in the downscale', report['clippedDownscaled'])
        # Stills: neutral proposal and +1 stop Balance, decoded back from JPEG.
        brighter = json.loads(json.dumps(post)); brighter[0]['g']['exposure'] = 1
        stills = [{'key': 'shot-A', 'frame': 0, 'stages': post, 'out': os.path.join(tmp, 'a-0.jpg')},
                  {'key': 'shot-A', 'frame': 1, 'stages': brighter, 'out': os.path.join(tmp, 'a-1.jpg'), 'compare': os.path.join(tmp, 'a-0.jpg')},
                  {'key': 'shot-A', 'frame': 1, 'stages': post, 'out': os.path.join(tmp, 'a-2.jpg'), 'compare': os.path.join(tmp, 'a-0.jpg')}]
        result = render({'ffmpeg': ff, 'cacheDir': cache, 'stills': stills})['stills']
        report.update(meanDiffBrighter=result[1]['meanDiff'], colorDiffBrighter=result[1]['colorDiff'], meanDiffSame=result[2]['meanDiff'])
        assert 'meanDiff' not in result[0] and result[1]['meanDiff'] > 20 and result[2]['meanDiff'] < 2, ('meanDiff against the before still', report)
        assert result[1]['colorDiff'] < result[1]['meanDiff'] / 3, ('a brighter grey picture is not a color change', report)
        expected = viewer_codes(graded(np.load(os.path.join(cache, 'shot-A.npy'))[0], post))
        back = subprocess.run([ff, '-v', 'error', '-i', stills[0]['out'], '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
        jpeg_error = float(np.abs(np.frombuffer(back, np.uint8).astype(float) - expected.reshape(-1)).mean()) if len(back) == w * h * 3 else None
        report.update(greyCode=result[0]['stats']['g']['p50'], brighterGreyCode=result[1]['stats']['g']['p50'], jpegMeanError=jpeg_error)
        assert all(r['width'] == w and r['height'] == h and os.path.getsize(r['out']) > 1000 for r in result), 'still size'
        assert jpeg_error is not None and jpeg_error < 2, ('JPEG differs from the graded codes', jpeg_error)
        assert result[1]['stats']['g']['p50'] > result[0]['stats']['g']['p50'] + 20, ('+1 stop still is not brighter', result)
        # Match: the darker copy and the warm cast are pulled back onto A.
        matched = {t['clipId']: t for t in match({'cacheDir': cache, 'weights': weights, 'reference': {'key': 'shot-A'},
                                                  'targets': [{'clipId': 'D', 'key': 'shot-D'}, {'clipId': 'B', 'key': 'shot-B'}], 'limits': LIMITS})['targets']}
        md, mb = matched['D'], matched['B']
        after = levels(np.load(os.path.join(cache, 'shot-D.npy')), weights, md['balance'])
        warm = levels(np.load(os.path.join(cache, 'shot-B.npy')), weights, mb['balance'])
        report.update(matchD={'exposure': md['balance']['exposure'], 'residual': md['residual'], 'p50After': after['stops']['p50']},
                      matchB={'temperature': mb['balance']['temperature'], 'tint': mb['balance']['tint'], 'residual': mb['residual'], 'neutralAfter': warm['neutral']})
        assert abs(md['balance']['exposure'] - 1) < .1 and abs(after['stops']['p50'] - a['stops']['p50']) < .1 and md['residual'] < .01, ('match darker copy', report['matchD'])
        assert mb['balance']['temperature'] < 0 and abs(warm['neutral']['rg'] - 1) < .03 and abs(warm['neutral']['bg'] - 1) < .03 and mb['residual'] < .02, ('match warm cast', report['matchB'])
        report['seconds'] = round(time.time() - started, 2)
        assert report['seconds'] < 20, ('selftest too slow', report['seconds'])
        print(json.dumps({'ok': True, **report}))
    finally: shutil.rmtree(tmp, ignore_errors=True)


def main(argv):
    if argv[1:] == ['--selftest']: return selftest()
    commands = {'measure': measure, 'render': render, 'match': match}
    if len(argv) != 3 or argv[1] not in commands: print(__doc__, file=sys.stderr); sys.exit(2)
    try:
        with open(argv[2], encoding='utf-8') as f: job = json.load(f)
        result = commands[argv[1]](job)
    except Exception as error:  # the server shows the last stderr line
        print(str(error) if isinstance(error, (RuntimeError, ValueError)) else f'{type(error).__name__}: {error}', file=sys.stderr, flush=True); sys.exit(1)
    print(json.dumps(result, allow_nan=False, separators=(',', ':')), flush=True)


if __name__ == '__main__': main(sys.argv)
