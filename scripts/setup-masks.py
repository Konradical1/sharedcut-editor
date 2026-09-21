#!/usr/bin/env python3
"""Install the pinned, Apache-licensed SAM 2.1 tracking baseline."""
import hashlib
import os
from pathlib import Path
import subprocess
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT / "artifacts/smart-mask/sam2"
REVISION = "2b90b9f5ceec907a1c18123530e92e794ad901a4"
# Pinned checkpoints. FRAME_LINE_SAM2_MODEL picks which one the worker loads; `small` tracks at roughly
# twice the frame rate of `large` with softer edges on thin limbs.
WEIGHTS = {
    "large": ("sam2.1_hiera_large.pt", "2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318"),
    "base_plus": ("sam2.1_hiera_base_plus.pt", "a2345aede8715ab1d5d31b4a509fb160c5a4af1970f199d9054ccfb746c004c5"),
    "small": ("sam2.1_hiera_small.pt", "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38"),
    "tiny": ("sam2.1_hiera_tiny.pt", "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69"),
}
MODEL = os.environ.get("FRAME_LINE_SAM2_MODEL", "large").lower()
if MODEL not in WEIGHTS:
    raise SystemExit(f"FRAME_LINE_SAM2_MODEL must be one of {', '.join(WEIGHTS)}.")
WEIGHT_NAME, WEIGHT_SHA256 = WEIGHTS[MODEL]


def run(*args, **kwargs):
    subprocess.run(list(map(str, args)), check=True, **kwargs)


def setup():
    environment = ROOT / ".venv-mask"
    if not (environment / "bin/python").exists():
        venv.create(environment, with_pip=True)
    python = environment / "bin/python"
    run(python, "-m", "pip", "install", "-r", ROOT / "scripts/mask-requirements.txt")
    if not REPO.exists():
        REPO.parent.mkdir(parents=True, exist_ok=True)
        run("git", "clone", "https://github.com/facebookresearch/sam2.git", REPO)
    revision = subprocess.check_output(["git", "-C", str(REPO), "rev-parse", "HEAD"], text=True).strip()
    if revision != REVISION:
        if subprocess.check_output(["git", "-C", str(REPO), "status", "--porcelain"], text=True).strip():
            raise RuntimeError("SAM2 checkout has local changes; preserve them before installing the pinned revision.")
        run("git", "-C", REPO, "fetch", "origin", REVISION)
        run("git", "-C", REPO, "checkout", "--detach", REVISION)
    run(python, "-m", "pip", "install", "--no-build-isolation", "-e", REPO,
        env={**os.environ, "SAM2_BUILD_CUDA": "0"})
    weights = REPO / "checkpoints" / WEIGHT_NAME
    weights.parent.mkdir(exist_ok=True)
    if not weights.exists():
        temporary = weights.with_suffix(".download")
        try:
            urllib.request.urlretrieve(f"https://dl.fbaipublicfiles.com/segment_anything_2/092824/{WEIGHT_NAME}", temporary)
            with temporary.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != WEIGHT_SHA256:
                    raise RuntimeError("Downloaded checkpoint hash does not match the pinned SAM2 weights.")
            temporary.rename(weights)
        finally:
            temporary.unlink(missing_ok=True)
    with weights.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != WEIGHT_SHA256:
            raise RuntimeError("Installed SAM2 checkpoint differs from the pinned checkpoint.")
    run(python, ROOT / "scripts/smart-mask.py", "--check", env={**os.environ, "FRAME_LINE_SAM2_MODEL": MODEL})
    print(f"Installed the SAM 2.1 {MODEL} selection preview. Native hair/motion-blur matting is a separate model capability.")


if __name__ == "__main__":
    setup()
