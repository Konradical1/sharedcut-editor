#!/usr/bin/env python3
"""Install the pinned Video Depth Anything Small weights (Apache-2.0) for scripts/depth.py.

The model code is vendored in scripts/vendor/video_depth_anything; only the weights are downloaded. They go
under artifacts/ beside the SAM checkpoints (FRAME_LINE_DEPTH_WEIGHTS overrides the path), are verified,
and only then renamed into place. Run through `npm run setup:depth`, which installs the .venv-mask packages first.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
URL = "https://huggingface.co/depth-anything/Video-Depth-Anything-Small/resolve/main/video_depth_anything_vits.pth"
SIZE = 116440756
SHA256 = "13379300b739e659f076a59d52e9801bd8d38c541a7e71f73bbca4dcfb013609"
WEIGHTS = Path(os.environ.get("FRAME_LINE_DEPTH_WEIGHTS", ROOT / "artifacts/depth/video_depth_anything_vits.pth"))


def verified(path):
    if not path.is_file() or path.stat().st_size != SIZE:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == SHA256


def setup():
    if not verified(WEIGHTS):
        WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
        temporary = WEIGHTS.with_name(WEIGHTS.name + ".download")
        try:
            print(f"Downloading Video Depth Anything Small ({SIZE / 1e6:.0f} MB)")
            urllib.request.urlretrieve(URL, temporary)
            if not verified(temporary):
                raise RuntimeError("The downloaded depth weights do not match the pinned size and SHA-256.")
            os.replace(temporary, WEIGHTS)
        finally:
            temporary.unlink(missing_ok=True)
    check = subprocess.run([sys.executable, str(ROOT / "scripts/depth.py"), "--check"], capture_output=True, text=True,
                           env={**os.environ, "FRAME_LINE_DEPTH_WEIGHTS": str(WEIGHTS)})
    result = json.loads(check.stdout.strip().splitlines()[-1]) if check.returncode == 0 else {}
    if not result.get("available"):
        raise SystemExit(f"Depth check failed: {result.get('reason') or check.stderr.strip()[-600:]}")
    print(f"Installed {result['engine']} on {result['device']}.")


if __name__ == "__main__":
    setup()
