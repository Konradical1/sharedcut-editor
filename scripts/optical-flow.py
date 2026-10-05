"""Portable timestamp-driven optical flow. No compiler, CUDA toolkit or administrator needed.

Decode only requested source frames as lossless 16-bit RGB; estimate bidirectional
motion once per pair and warp at each exact requested time. Holds and direction
changes are just entries in the output schedule, never a resampling-rate limit.
"""
import bisect
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading

import cv2
import numpy as np

cv2.setNumThreads(4)
SHOWINFO = re.compile(r'pts_time:\s*(-?[0-9.]+(?:e-?[0-9]+)?)')


def emit(progress):
    print(json.dumps({"progress": progress}), flush=True)


def probe(job):
    """Stream geometry and rate only: nothing is decoded here."""
    result = subprocess.run([job['ffprobe'], '-v', 'error', '-select_streams', 'v:0',
                             '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation',
                             '-of', 'json', job['input']], capture_output=True, check=True, text=True)
    stream = json.loads(result.stdout)['streams'][0]
    # FFmpeg decodes phone footage upright; the coded size is sideways when the display matrix rotates 90.
    rotation = next((d['rotation'] for d in stream.get('side_data_list', []) if 'rotation' in d), 0)
    if abs(int(rotation)) % 180 == 90:
        stream = {**stream, 'width': stream['height'], 'height': stream['width']}
    rates = [n / d for n, d in (map(float, (stream.get(key) or '0/0').split('/')) for key in ('avg_frame_rate', 'r_frame_rate')) if n > 0 and d > 0]
    return stream, min(rates) if rates else 24.0


def windows(requested, reach):
    """Merged [start, end) source intervals around the requested times: every frame the schedule can read lies in one."""
    merged = []
    for time in sorted(requested):
        if merged and time - reach <= merged[-1][1]: merged[-1][1] = time + reach
        else: merged.append([time - reach, time + reach])
    return merged


def decode(job, requested, width, height, resize, threads, directory, rate, reach):
    """Decode only the source window the schedule reads, seeking to it, and keep the frames within `reach` of a
    requested time as raw 16-bit RGB in one file FFmpeg writes itself. Returns the kept frames' times (seconds from
    the input's start, the clock `-ss` uses in the rest of the export) and the frames, memory-mapped.

    Before 2026-10-05 this decoded the whole file twice (a frame-accurate ffprobe for timestamps, then a select
    filter from frame 0) and wrote every needed frame as a 16-bit PNG: 3-10 minutes per 1.5 s clip of 4K 4:2:2.
    The frames go to a file rather than through a pipe to Python: a Windows pipe moved 4K 16-bit frames at
    about 150 MB/s, which was most of the decode time."""
    spans = windows(requested, reach)
    first, last = max(0.0, spans[0][0]), spans[-1][1]
    raw, graph = directory / 'frames.raw', directory / 'decode.filter'
    keep = '+'.join(f'between(t\\,{start:.6f}\\,{end:.6f})' for start, end in spans)
    # A script avoids Windows command-line length and quoting limits; showinfo logs each kept frame's pts in order.
    graph.write_text(f"select='{keep}',showinfo{resize},format=bgr48le")
    result = subprocess.run([job['ffmpeg'], '-hide_banner', '-nostats', '-v', 'info', '-nostdin', '-y', '-threads', threads,
                             '-ss', f'{first:.6f}', '-t', f'{last - first:.6f}', '-copyts', '-start_at_zero', '-i', job['input'],
                             '-map', '0:v:0', '-filter_script:v', str(graph), '-fps_mode', 'passthrough',
                             '-f', 'rawvideo', '-threads', threads, str(raw)], capture_output=True)
    log = result.stderr.decode('utf-8', 'replace').splitlines()
    if result.returncode != 0:
        raise RuntimeError('\n'.join(line for line in log if 'rror' in line)[-4000:] or 'Optical flow decoder failed.')
    times = [float(match.group(1)) for match in (SHOWINFO.search(line) for line in log if 'showinfo' in line.lower()) if match]
    size = width * height * 3 * 2
    if not times or raw.stat().st_size != len(times) * size:
        raise RuntimeError('Optical flow decoder returned an incomplete source window.')
    if any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError('Optical flow requires ordered source frame timestamps.')
    return times, np.memmap(raw, dtype='<u2', mode='r', shape=(len(times), height, width, 3))


def bracketed(times, requested, reach):
    """Whether every requested time has its own frames among the kept ones: a frame at or before it within reach, and
    one after it within reach unless it lies past the last frame. A source with gaps wider than `reach` fails this."""
    for time in requested:
        left = bisect.bisect_right(times, time + 1e-8) - 1
        # Before the first frame is only a gap when the window could have reached further back than the file start.
        if left < 0 and times[0] - time > 1e-6 and time > reach: return False
        if left >= 0 and time - times[left] > reach: return False
        if 0 <= left < len(times) - 1 and times[left + 1] - time > reach: return False
    return True


def render(job):
    stream, rate = probe(job)
    width, height = stream['width'], stream['height']
    # An export fits every source into its canvas first, so its bake need be no larger than that box.
    resize = ''
    if job.get('fit'):
        scale = min(1, job['fit'][0] / width, job['fit'][1] / height)
        if scale < 1:
            width, height = max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)
            resize = f',scale={width}:{height}'
    # Previews run in the background on two threads; an export bake is the only work its export waits on.
    threads = str(job.get('threads', 2))
    cv2.setNumThreads(max(4, int(threads)))
    directory = Path(job['output']).parent / 'decoded'
    directory.mkdir()
    requested = [max(0, frame['time']) for frame in job['frames']]
    # Worst case every frame of the window is kept: speed at or below 100% reads them all.
    window = (max(requested) - min(requested) + 5 / max(1.0, rate)) * rate + 2
    if window*width*height*6 + 512*1024**2 > shutil.disk_usage(directory).free:
        raise ValueError('Insufficient disk space for optical flow. Render a shorter range.')
    # Three nominal frame periods hold a frame on each side of any requested time on constant-rate footage. Variable
    # frame rate can leave wider gaps; then the window is decoded again with a two-second reach.
    times, decoded = decode(job, requested, width, height, resize, threads, directory, rate, 3 / max(1.0, rate))
    if not bracketed(times, requested, 3 / max(1.0, rate)):
        del decoded
        times, decoded = decode(job, requested, width, height, resize, threads, directory, rate, 2.0)
    emit(10)
    schedule = []
    for frame, wanted in zip(job['frames'], requested):
        time = max(times[0], min(times[-1], wanted))
        left = max(0, bisect.bisect_right(times, time + 1e-8) - 1)
        right = min(left + 1, len(times) - 1) if frame['interpolate'] else left
        fraction = (time - times[left]) / (times[right] - times[left]) if right != left else 0
        schedule.append((left, right, max(0, min(1, fraction))))

    # Motion is estimated on a bounded image, then scaled to native pixels. Color
    # stays at 16 bits throughout the warp and the pipe into the 10-bit encoder.
    scale = min(1, 960/max(width, height))
    sw, sh = max(12, round(width*scale)), max(12, round(height*scale))
    grid = np.stack(np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32)), -1)
    small = np.stack(np.meshgrid(np.arange(sw, dtype=np.float32), np.arange(sh, dtype=np.float32)), -1)
    units = np.array([width/sw, height/sh], dtype=np.float32)
    # A DIS instance keeps state between calls, so each worker thread has its own.
    local = threading.local()

    def gray(index):
        # Shrink the 16-bit picture first: converting and greying 4K only to throw three quarters away cost more than DIS.
        return cv2.cvtColor((cv2.resize(decoded[index], (sw, sh), interpolation=cv2.INTER_AREA) >> 8).astype(np.uint8), cv2.COLOR_BGR2GRAY)

    def motion(left, right):
        a, b = gray(left), gray(right)
        # Do not invent movement across a cut. The source frame is held until the
        # cut timestamp, as with the FFmpeg scene-change detector.
        if np.mean(cv2.absdiff(a, b)) > 50:
            return None
        if not hasattr(local, 'dis'): local.dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
        # Both fields stay at the motion resolution, in its own pixels; only the finished mapping is enlarged.
        return [local.dis.calc(first, second, None) for first, second in ((a, b), (b, a))]

    def warp(image, flow, amount):
        # Solve the inverse mapping by fixed-point iteration. A single subtraction
        # samples flow at the destination and leaves ghosts around moving edges.
        # The iteration runs where the motion was measured: at native size it repeated the same interpolation of the
        # same coarse field on up to 16x the pixels, which was most of the 1 s each 4K output frame took.
        mapping = small.copy()
        for _ in range(3):
            displaced = cv2.remap(flow, mapping, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            mapping = small - amount*displaced
        # OpenCV, not numpy, for the full-size arithmetic: it is threaded and was a third of the frame time as numpy.
        offset = cv2.resize((mapping - small) * units, (width, height), interpolation=cv2.INTER_LINEAR)
        fixed, fraction = cv2.convertMaps(cv2.add(grid, offset), None, cv2.CV_16SC2)
        return cv2.remap(image, fixed, fraction, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    def picture(left, right, fraction, fields):
        image = decoded[left]
        fields = fields.result() if fields else None
        if fields is None: return image
        first = warp(image, fields[0], fraction)
        second = warp(decoded[right], fields[1], 1-fraction)
        return cv2.addWeighted(first, 1-fraction, second, fraction, 0)

    # Frames are independent once their pair's motion is known: several are warped at once (OpenCV releases the GIL)
    # and written in order. A pair shared by consecutive slow-motion frames is measured once. Two pools, so a frame
    # waiting on its motion never holds the thread that motion needs.
    workers = max(2, min(8, int(threads) // 3))
    emit(15)
    error_path = directory / 'encoder.log'
    with error_path.open('wb') as errors, ThreadPoolExecutor(workers) as motions, ThreadPoolExecutor(workers) as pictures:
        encoder = subprocess.Popen([job['ffmpeg'], '-v', 'error', '-nostdin', '-y',
                                    '-f', 'rawvideo', '-pix_fmt', 'bgr48le', '-s', f'{width}x{height}',
                                    '-r', str(job['fps']), '-i', 'pipe:0', '-an', '-c:v', 'prores_ks',
                                    '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-threads', threads,
                                    job['output']], stdin=subprocess.PIPE, stderr=errors, bufsize=16 * 1024**2)
        pairs, waiting = {}, deque()

        def write(number):
            encoder.stdin.write(np.ascontiguousarray(waiting.popleft().result(), dtype='<u2').data)
            if number % max(1, len(schedule)//100) == 0:
                emit(15 + 84*(number+1)/len(schedule))
        try:
            for number, (left, right, fraction) in enumerate(schedule):
                fields = None
                if fraction > 1e-8 and left != right:
                    if (left, right) not in pairs:
                        pairs[(left, right)] = motions.submit(motion, left, right)
                        # The schedule moves through the window, so only recent pairs come back.
                        while len(pairs) > 4 * workers: pairs.pop(next(iter(pairs)))
                    fields = pairs[(left, right)]
                waiting.append(pictures.submit(picture, left, right, fraction, fields))
                if len(waiting) > 2 * workers: write(number - len(waiting) + 1)
            while waiting: write(len(schedule) - len(waiting))
            encoder.stdin.close()
            if encoder.wait() != 0:
                raise RuntimeError(error_path.read_text(errors='replace'))
        finally:
            for pending in waiting: pending.cancel()
            if encoder.poll() is None:
                encoder.kill()
                encoder.wait()
    emit(100)


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--check']:
            cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
            print(json.dumps({'engine': 'OpenCV DIS bidirectional flow', 'opencv': cv2.__version__, 'numpy': np.__version__}))
        else:
            render(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
    except Exception as error:
        print(f'Optical flow: {error}', file=sys.stderr)
        sys.exit(1)
