import json, os, subprocess, sys, time
import numpy as np, torch, torch.nn.functional as F
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from video_depth_anything.video_depth import VideoDepthAnything, INFER_LEN, OVERLAP, KEYFRAMES

ffmpeg = os.environ.get('FFMPEG_PATH', 'ffmpeg')
video, weights, frames_wanted = sys.argv[1], sys.argv[2], int(sys.argv[3])
size = int(sys.argv[4]) if len(sys.argv) > 4 else 518
out = sys.argv[5] if len(sys.argv) > 5 else None
dev = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'

probe = json.loads(subprocess.run([ffmpeg.replace('ffmpeg', 'ffprobe'), '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,pix_fmt,r_frame_rate', '-of', 'json', video], capture_output=True, text=True).stdout)['streams'][0]
w, h = probe['width'], probe['height']
if w >= h: H = size; W = round(w * size / h / 14) * 14
else: W = size; H = round(h * size / w / 14) * 14
t0 = time.perf_counter()
cmd = [ffmpeg, '-v', 'error', '-i', video, '-frames:v', str(frames_wanted), '-vf', f'scale={W}:{H}:flags=bicubic', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']
raw = subprocess.run(cmd, capture_output=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
decode_s = time.perf_counter() - t0
n = len(frames)

model = VideoDepthAnything(encoder='vits', features=64, out_channels=[48, 96, 192, 384])
model.load_state_dict(torch.load(weights, map_location='cpu'), strict=True)
model = model.to(dev).eval()
mean = torch.tensor([0.485, 0.456, 0.406], device=dev).view(1, 1, 3, 1, 1); std = torch.tensor([0.229, 0.224, 0.225], device=dev).view(1, 1, 3, 1, 1)
def prep(batch):
    x = torch.from_numpy(batch).to(dev).permute(0, 3, 1, 2).float().div(255).unsqueeze(0)
    return (x - mean) / std
step = INFER_LEN - OVERLAP
pad = (step - (n % step)) % step + (INFER_LEN - step)
seq = np.concatenate([frames, np.repeat(frames[-1:], pad, 0)])
if dev == 'cuda': torch.cuda.reset_peak_memory_stats(); torch.cuda.synchronize()
times = []; depths = []; pre = None
for start in range(0, n, step):
    x = prep(seq[start:start + INFER_LEN])
    if pre is not None: x[:, :OVERLAP] = pre[:, KEYFRAMES]
    if dev == 'cuda': torch.cuda.synchronize()
    a = time.perf_counter()
    with torch.no_grad(), torch.autocast(device_type=dev, dtype=torch.float16, enabled=dev != 'cpu'):
        d = model(x)
    if dev == 'cuda': torch.cuda.synchronize()
    times.append(time.perf_counter() - a)
    depths.append(d[0].float().cpu().numpy() if start == 0 else d[0, OVERLAP:].float().cpu().numpy())
    pre = x
peak = torch.cuda.max_memory_allocated() / 2**30 if dev == 'cuda' else 0
infer = sum(times[1:]) if len(times) > 1 else times[0]
windows = max(1, len(times) - 1)
new_frames = windows * step
res = {'device': dev, 'torch': torch.__version__, 'source': probe, 'analysis': [W, H], 'frames': n, 'decode_s': round(decode_s, 2), 'decode_fps': round(n / decode_s, 1),
       'first_window_s': round(times[0], 3), 'steady_window_s': round(infer / windows, 3), 'infer_fps': round(new_frames / infer, 1) if len(times) > 1 else None, 'peak_vram_gb': round(peak, 2)}
print(json.dumps(res))
if out:
    d = np.concatenate(depths)[:n]
    lo, hi = np.percentile(d[:32], 1), np.percentile(d[:32], 99)
    g = np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1)
    g = (g * 255).astype(np.uint8)
    side = np.concatenate([frames, np.repeat(g[..., None], 3, -1)], axis=2)
    enc = subprocess.Popen([ffmpeg, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W*2}x{H}', '-r', '30', '-i', 'pipe:0', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out], stdin=subprocess.PIPE)
    enc.stdin.write(side.tobytes()); enc.stdin.close(); enc.wait()
