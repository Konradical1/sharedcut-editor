#!/usr/bin/env python3
"""Create .venv-stabilize with OpenCV and NumPy for the Stabilize effect. Works on macOS, Linux and Windows."""
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT = ROOT / ".venv-stabilize"
PYTHON = ENVIRONMENT / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def run(*args):
    subprocess.run([str(a) for a in args], check=True)


def setup():
    if not PYTHON.exists():
        venv.create(ENVIRONMENT, with_pip=True)
    run(PYTHON, "-m", "pip", "install", "--upgrade", "pip")
    run(PYTHON, "-m", "pip", "install", "-r", ROOT / "scripts/stabilize-requirements.txt")
    run(PYTHON, ROOT / "scripts/stabilize.py", "--check")
    print(f"Stabilize worker ready. Set FRAME_LINE_STABILIZE_PYTHON={PYTHON} if the server runs elsewhere.")


if __name__ == "__main__":
    setup()
