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
WEIGHT_SHA256 = "2647878d5dfa5098f2f8649825738a9345572bae2d4350a2468587ece47dd318"


def run(*args, **kwargs):
    subprocess.run(list(map(str, args)), check=True, **kwargs)


def venv_python(environment):
    # .venv-x/bin/python on macOS and Linux, .venv-x\Scripts\python.exe on Windows.
    return environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def setup():
    environment = ROOT / ".venv-mask"
    if not venv_python(environment).exists():
        venv.create(environment, with_pip=True)
    python = venv_python(environment)
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
    weights = REPO / "checkpoints/sam2.1_hiera_large.pt"
    weights.parent.mkdir(exist_ok=True)
    if not weights.exists():
        temporary = weights.with_suffix(".download")
        try:
            urllib.request.urlretrieve("https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt", temporary)
            with temporary.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != WEIGHT_SHA256:
                    raise RuntimeError("Downloaded checkpoint hash does not match the pinned SAM2 weights.")
            temporary.rename(weights)
        finally:
            temporary.unlink(missing_ok=True)
    with weights.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != WEIGHT_SHA256:
            raise RuntimeError("Installed SAM2 checkpoint differs from the pinned checkpoint.")
    run(python, ROOT / "scripts/smart-mask.py", "--check")
    print("Installed SAM 2.1 selection preview. Native hair/motion-blur matting is a separate model capability.")


if __name__ == "__main__":
    setup()
