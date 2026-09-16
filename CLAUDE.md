# FrameLine

The directory and the code say "FrameLine". **The product is called SharedCut**, after
sharedcut.com where it is hosted. Say SharedCut to Konrad and in anything user-facing; leave
the `FRAME_LINE_*` env vars, paths and LaunchAgent labels alone.

## Talking to Konrad
Short answers. Plain words. A few lines max.
No long explanations, no detail dumps, no lists of internals.
Say what happened or what to do, then stop. More detail only if asked.

## This server is moving to Windows — write nothing Mac-native

Today the backend runs on an Apple silicon Mac. It is moving to a Windows machine (a Lenovo
tower with an RTX 5060 Ti) and the Mac becomes a fallback. `docs/WINDOWS_MIGRATION.md` has the
full plan.

**Every feature added from now on must run on both.** This is not a later cleanup — a
Mac-only feature written today is a feature that breaks on the move. When you are about to
write something platform-specific, stop and pick a cross-platform route instead.

Rules, in order of how often they bite:

1. **No shelling out to macOS tools.** No `xcrun`, `sw_vers`, `mdls`, `afplay`, `caffeinate`,
   `osascript`, `sips`, `say`. No compiling against Apple frameworks (AVFoundation,
   VideoToolbox, CoreMedia, Metal). If a job needs a native helper, it needs one that builds
   on Windows too, or it does not ship.
2. **Build paths with `node:path`.** `join()` and `resolve()`, never string concatenation with
   `/`. Never hardcode `/Users/...`, `/opt/homebrew`, or `/tmp` — use `os.tmpdir()`.
3. **Reach external binaries through an env var with a sane default**, the way the Python hooks
   already do: `FRAME_LINE_COLOR_PYTHON`, `FRAME_LINE_IMPORT_PYTHON`,
   `FRAME_LINE_CAPTION_PYTHON`, `FRAME_LINE_MASK_PYTHON`, `FFMPEG_PATH`. A venv interpreter is
   `.venv-x/bin/python` on macOS and `.venv-x\Scripts\python.exe` on Windows — the env var is
   what makes that somebody else's problem.
4. **Kill child processes the way `smartMask.ts` and `linkImport.ts` do.** `process.kill(-pid)`
   for process groups is POSIX-only; both already branch on `process.platform !== 'win32'`.
   Copy that pattern, do not invent a new one.
5. **No symlinks.** They need elevated privileges on Windows. Copy or hard-link instead.
6. **FFmpeg hardware acceleration must be detected, never assumed.** `server/media.ts` probes
   `ffmpeg -hwaccels` and degrades to software. Any new accel path does the same — VideoToolbox
   on the Mac, CUDA/NVDEC on Windows, software everywhere else.
7. **File modes (`0o700`, `0o600`) are no-ops on Windows.** Fine to keep, never rely on them
   for correctness.
8. **GPU work belongs in the browser where it can.** Color and motion preview are WebGL2 and
   run on the editor's machine, not the server. That code is already portable — keep new visual
   work there rather than adding server-side GPU dependencies.

**The one known violation** is `server/opticalFlow.ts`: it compiles an Objective-C worker with
`xcrun clang` and throws on non-Darwin. It is a tracked blocker with a planned replacement
(RIFE via ONNX/TensorRT), not a pattern to copy. Do not add a second one.

If a feature genuinely cannot be done cross-platform, say so and ask before writing it
Mac-only.

## Branches

- `main` — the Windows line. Merge target, and where the port lands.
- `mac` — the Apple silicon host in production today.

Work happens on `mac` while the Mac is still the live server. Merge `mac` into `main` often;
the two share ~95% of their code and long gaps make painful merges.

## Moving a project between machines

`data/` is 125 GB and gitignored — projects do not travel through git.

```
node scripts/project-bundle.mjs export "Newspaper" ~/Desktop/newspaper-bundle
node scripts/project-bundle.mjs import ~/Desktop/newspaper-bundle
```

Stop the server on both ends first; the script writes the SQLite workspace row directly and a
running server will overwrite the import on its next save.
