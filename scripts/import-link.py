"""Acquire one public video or a Spotify track's matched YouTube recording."""
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import shutil
import sys
import time


def emit(kind, **data):
    print(json.dumps({"type": kind, **data}), flush=True)


def main():
    url, mode, height, directory, max_bytes, node = sys.argv[1:]
    max_bytes = int(max_bytes)
    # Reject private destinations after DNS resolution, including redirects.
    original_resolve = socket.getaddrinfo

    def public_addresses(*args, **kwargs):
        addresses = original_resolve(*args, **kwargs)
        if any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ValueError("Link imports cannot access private network addresses.")
        return addresses

    socket.getaddrinfo = public_addresses
    # Networks that re-sign TLS (the Lenovo's school Wi-Fi runs Securly) need their root on top of certifi.
    extra_ca = os.environ.get("FRAME_LINE_IMPORT_CA")
    compat = set()
    if extra_ca:
        import certifi
        bundle = Path(directory) / "ca-bundle.pem"
        bundle.write_text(Path(certifi.where()).read_text() + "\n" + Path(extra_ca).read_text())
        os.environ["SSL_CERT_FILE"] = os.environ["REQUESTS_CA_BUNDLE"] = str(bundle)
        compat = {"no-certifi"}
    from yt_dlp import YoutubeDL

    class Logger:
        def debug(self, message):
            pass

        def warning(self, message):
            print(message, file=sys.stderr)

        def error(self, message):
            print(message, file=sys.stderr)

    title = None
    expected_duration = None
    if "open.spotify.com" in url:
        from spotdl import Spotdl
        client = Spotdl(client_id="", client_secret="", no_cache=True, headless=True,
                        downloader_settings={"audio_providers": ["youtube"], "lyrics_providers": [],
                                             "threads": 1, "ffmpeg": shutil.which(os.environ.get("FFMPEG_PATH", "ffmpeg")) or "ffmpeg",
                                             "yt_dlp_args": "--js-runtimes node --socket-timeout 20 --retries 2"
                                                            + (" --compat-options no-certifi" if compat else "")})
        song = client.search([url])[0]
        title, expected_duration = song.display_name, song.duration
        url = client.downloader.search(song)
        if not re.fullmatch(r"https://(?:www\.|music\.)?youtube\.com/watch\?v=[\w-]{11}", url):
            raise ValueError("No suitable YouTube recording was found for this Spotify track.")

    previous = -1
    streams = 1
    parts = {}
    last_update = 0

    def progress(data):
        nonlocal previous, last_update
        total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
        downloaded = data.get("downloaded_bytes", 0)
        if downloaded > max_bytes or total > max_bytes:
            raise ValueError("Download exceeds the configured size limit.")
        fraction = 1 if data.get("status") == "finished" else min(1, downloaded / total) if total else 0
        key = data.get("filename", "media")
        parts[key] = max(parts.get(key, 0), fraction)
        percent = max(previous, min(99, int(sum(parts.values()) / streams * 100)))
        if percent != previous and (time.monotonic() - last_update >= .2 or percent == 99):
            last_update = time.monotonic()
            emit("progress", percent=percent)
            previous = percent

    options = {"quiet": True, "logger": Logger(), "noplaylist": True, "cachedir": False,
               "socket_timeout": 20, "retries": 2, "fragment_retries": 2,
               "js_runtimes": {"node": {"path": node}},
               "ffmpeg_location": shutil.which(os.environ.get("FFMPEG_PATH", "ffmpeg")) or "ffmpeg",
               "outtmpl": str(Path(directory) / "media.%(ext)s"),
               "max_filesize": max_bytes, "progress_hooks": [progress],
               "format": "bestaudio/best" if mode == "audio" else f"bestvideo[height<={height}]+bestaudio/best[height<={height}]",
               "merge_output_format": "mp4", "windowsfilenames": True, "compat_opts": compat}
    if mode == "audio":
        options["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}]
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=False)
        if not info or info.get("_type", "video") != "video":
            raise ValueError("This link does not contain a single available video.")
        if info.get("is_live") or not 0 < (info.get("duration") or 0) <= 21600:
            raise ValueError("Import a finished video up to six hours long.")
        if expected_duration and abs(info["duration"] - expected_duration) > max(15, expected_duration * .1):
            raise ValueError("The matched recording differs in length. Paste the correct YouTube link instead.")
        streams = max(1, len(info.get("requested_formats") or []))
        title = title or info["title"]
        emit("source", title=title, url=url, matchedTitle=info["title"])
        downloader.process_ie_result(info, download=True)
    files = [p for p in Path(directory).glob("media.*") if p.suffix in {".mp4", ".m4a", ".webm", ".mkv", ".opus", ".mp3", ".ogg"}]
    if len(files) != 1:
        raise ValueError("The download did not produce a complete media file.")
    emit("complete", filename=files[0].name, title=title)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", message=str(error))
        sys.exit(1)
