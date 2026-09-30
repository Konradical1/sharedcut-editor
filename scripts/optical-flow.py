"""Portable timestamp-driven optical flow. No compiler, CUDA toolkit or administrator needed.

Decode only requested source frames as lossless 16-bit RGB; estimate bidirectional
motion once per pair and warp at each exact requested time. Holds and direction
changes are just entries in the output schedule, never a resampling-rate limit.
"""
import bisect
from functools import lru_cache
import json
from pathlib import Path
import shutil
import subprocess
import sys

import cv2
import numpy as np

cv2.setNumThreads(4)


def emit(progress):
    print(json.dumps({"progress": progress}), flush=True)


def probe(job):
    result = subprocess.run([job['ffprobe'], '-v', 'error', '-select_streams', 'v:0',
                             '-show_entries', 'frame=best_effort_timestamp_time:stream=width,height',
                             '-of', 'json', job['input']], capture_output=True, check=True, text=True)
    data = json.loads(result.stdout)
    timestamps = [float(f['best_effort_timestamp_time']) for f in data['frames']]
    if not timestamps or any(b <= a for a, b in zip(timestamps, timestamps[1:])):
        raise ValueError('Optical flow requires ordered source frame timestamps.')
    return [t - timestamps[0] for t in timestamps], data['streams'][0]


def render(job):
    times, stream = probe(job)
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
    schedule = []
    for frame in job['frames']:
        time = max(0, min(times[-1], frame['time']))
        left = max(0, bisect.bisect_right(times, time + 1e-8) - 1)
        right = min(left + 1, len(times) - 1) if frame['interpolate'] else left
        fraction = (time - times[left]) / (times[right] - times[left]) if right != left else 0
        schedule.append((left, right, max(0, min(1, fraction))))
    needed = sorted({i for left, right, _ in schedule for i in (left, right)})
    if len(needed)*width*height*6 + 512*1024**2 > shutil.disk_usage(directory).free:
        raise ValueError('Insufficient disk space for optical flow. Render a shorter range.')
    # A script avoids Windows command-line length and quoting limits. Frame numbers
    # come from decoded presentation order, including variable-frame-rate footage.
    graph = directory / 'select.filter'
    graph.write_text("select='" + '+'.join(f'eq(n\\,{i})' for i in needed) + "'" + resize)
    subprocess.run([job['ffmpeg'], '-v', 'error', '-nostdin', '-y', '-threads', threads, '-i', job['input'],
                    '-filter_script:v', str(graph), '-frames:v', str(len(needed)),
                    # Fastest deflate: still lossless, half the read time of the default level on 4K 16-bit frames.
                    '-fps_mode', 'passthrough', '-pix_fmt', 'rgb48be', '-threads', threads, '-compression_level', '1',
                    '-start_number', '0', str(directory / '%d.png')], check=True)
    positions = {index: position for position, index in enumerate(needed)}

    @lru_cache(maxsize=4)
    def frame(index):
        rgb = cv2.imread(str(directory / f'{positions[index]}.png'), cv2.IMREAD_UNCHANGED)
        if rgb is None or rgb.dtype != np.uint16 or rgb.shape != (height, width, 3):
            raise ValueError('Optical flow decoder returned an incomplete source frame.')
        return rgb

    # Motion is estimated on a bounded image, then scaled to native pixels. Color
    # stays at 16 bits throughout the warp and the pipe into the 10-bit encoder.
    scale = min(1, 960/max(width, height))
    sw, sh = max(12, round(width*scale)), max(12, round(height*scale))
    grid = np.stack(np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32)), -1)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)

    @lru_cache(maxsize=2)
    def motion(left, right):
        a, b = [cv2.resize(cv2.cvtColor((frame(i) >> 8).astype(np.uint8), cv2.COLOR_BGR2GRAY), (sw, sh)) for i in (left, right)]
        # Do not invent movement across a cut. The source frame is held until the
        # cut timestamp, as with the FFmpeg scene-change detector.
        if np.mean(cv2.absdiff(a, b)) > 50:
            return None
        fields = []
        for first, second in ((a, b), (b, a)):
            flow = cv2.resize(dis.calc(first, second, None), (width, height))
            flow *= np.array([width/sw, height/sh], dtype=np.float32)
            fields.append(flow)
        return fields

    def warp(image, flow, amount):
        # Solve the inverse mapping by fixed-point iteration. A single subtraction
        # samples flow at the destination and leaves ghosts around moving edges.
        mapping = grid.copy()
        for _ in range(3):
            displaced = cv2.remap(flow, mapping, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            mapping = grid - amount*displaced
        return cv2.remap(image, mapping, None, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    emit(15)
    error_path = directory / 'encoder.log'
    with error_path.open('wb') as errors:
        encoder = subprocess.Popen([job['ffmpeg'], '-v', 'error', '-nostdin', '-y',
                                    '-f', 'rawvideo', '-pix_fmt', 'bgr48le', '-s', f'{width}x{height}',
                                    '-r', str(job['fps']), '-i', 'pipe:0', '-an', '-c:v', 'prores_ks',
                                    '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-threads', threads,
                                    job['output']], stdin=subprocess.PIPE, stderr=errors)
        try:
            for number, (left, right, fraction) in enumerate(schedule):
                picture = frame(left)
                if fraction > 1e-8 and left != right:
                    fields = motion(left, right)
                    if fields is not None:
                        first = warp(picture, fields[0], fraction)
                        second = warp(frame(right), fields[1], 1-fraction)
                        picture = cv2.addWeighted(first, 1-fraction, second, fraction, 0)
                encoder.stdin.write(picture.astype('<u2', copy=False).tobytes())
                if number % max(1, len(schedule)//100) == 0:
                    emit(15 + 84*(number+1)/len(schedule))
            encoder.stdin.close()
            if encoder.wait() != 0:
                raise RuntimeError(error_path.read_text(errors='replace'))
        finally:
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
