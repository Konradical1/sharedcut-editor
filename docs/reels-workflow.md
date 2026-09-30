# Vertical reels workflow

How to make a 1080 × 1920 reel in SharedCut from scripts. An agent can do all of it; a person can take
over in the browser at any point.

## 0. Before you start

- Use a session cookie, not a password. Sign in at the site, copy the `frameline_session=…` cookie
  from the browser's dev tools, and export it: `FRAME_LINE_COOKIE='frameline_session=…'`.
  (PowerShell: `$env:FRAME_LINE_COOKIE='frameline_session=…'`.)
- Or, on the server itself, mint one without a password: `node scripts/agent/agent-session.mjs <email> [days]`
  writes `~/sharedcut-agent/cookie.txt` (outside the repo, mode 600). The scripts read that file when
  `FRAME_LINE_COOKIE` is unset. `node scripts/agent/create-project.mjs "<name>" "1080 × 1920" 30` creates an
  empty project with the ids `import-folder.mjs` uses.
- Run the scripts on the machine that hosts SharedCut and point them at loopback
  (`FRAME_LINE_URL=http://127.0.0.1:4310`, the default). The public tunnel caps uploads at the home
  upload speed.
- Trim long 120 fps phone clips to the parts you use first. `-c copy` keeps the HLG metadata:
  `ffmpeg -ss A -to B -i IMG_1234.MOV -c copy IMG_1234_cut.MOV`.
- Fonts: upload static TTFs (for example Montserrat Black) in the Text inspector under Shared fonts,
  or with `POST /api/fonts?name=…` and the file as the body. Each upload returns a family id such as
  `FL-3a…`; use that id as `fontFamily`. One static file answers every weight.

## 1. Create the project and import media

```
node scripts/import-folder.mjs --name "fisch.builds Part 1" ~/Footage/part1
```

- It defaults to 1080 × 1920 at 30 fps. Use `--resolution` and `--fps` to change that. Use 30 or 60,
  not 29.97.
- If a project with that name already exists, even one made in the browser, the script reuses it.
  The timeline is at least 60 s long.
- Rerunning resumes interrupted uploads. Media ids are per project, so one folder can feed two
  projects.

What happens to iPhone footage on import:
- A portrait clip reports 1080 × 1920. Its display rotation is read, and FFmpeg decodes it upright.
- HLG/PQ (HDR) clips are tone-mapped to Rec.709 SDR in previews and exports, using a hable curve.
  The Mac's Homebrew FFmpeg has no zscale, so this runs as a generated 3D LUT and gives the same
  result on every machine. If highlights look too dim or too hot, set `FRAME_LINE_HDR_NPL`
  (default 100; 203 is darker) and re-prepare the clip.
- Assets imported before this change are re-probed on the next server start. HDR clips then prepare
  their previews again.

## 2. Transcribe

`POST /api/captions` with `{projectId, timelineId, start, end, trackIds:[<voice track id>], wordsPerLine:3, preset:'reel'}`.
Poll `GET /api/captions/<job id>` until `status` is `complete`. You only need the job id for the next step.

## 3. Write the edit JSON

```jsonc
{
  "project": "fisch.builds Part 1",          // name or id; "timeline" is optional (defaults to the first)
  "tracks": [                                 // matched to existing tracks by kind + number, else created
    { "id": "v1", "kind": "video", "number": 1 },
    { "id": "v2", "name": "Graphics", "kind": "video", "number": 2 },
    { "id": "a1", "name": "Voice", "kind": "audio", "number": 1 },
    { "id": "a2", "name": "Music", "kind": "audio", "number": 2, "gain": -8 }
  ],
  "clips": [                                  // media by file name or id; "out" or "duration"
    { "id": "hook", "track": "v1", "media": "IMG_6454.MOV", "start": 0, "in": 12.5, "out": 15.5,
      "properties": { "flipH": true, "zoom": 110 },
      "keyframes": { "properties.zoom": [[0, 118, "outCubic"], [0.4, 110]] } },
    { "id": "music", "track": "a2", "media": "beat.mp3", "start": 0, "in": 0, "duration": 60,
      "gain": [[0.9, 0, "outCubic"], [1.1, -14], [2.4, -14, "inOutCubic"], [2.7, 0]] }   // ducking: [time, dB, ease]
  ],
  "text": [ { "id": "title", "track": "v2", "start": 0, "duration": 1.5, "doc": { /* TextDocument */ } } ],
  "graphics": [ { "id": "bar", "track": "v2", "start": 1, "duration": 2,
                  "shape": { "kind": "rounded", "fill": "#c4f876", "x": 0.1, "y": 0.1, "width": 0.8, "height": 0.06 },
                  "keyframes": { "properties.zoom": [[0, 80, "outBack"], [0.3, 100]] } } ],
  "captions": { "job": "caption-…", "tracks": ["a1"], "wordsPerLine": 3, "preset": "reel",
    "style": { "fontFamily": "FL-…", "fontWeight": 400, "fontSize": 190, "outlineWidth": 25,
               "outlineColor": "#101116", "shadowOpacity": 80, "y": 0.65, "accent": "#c4f876", "wordPop": true } },
  "render": { "name": "reel1.mp4", "duration": 60 }
}
```

- Times are in seconds. Keyframe times count from the clip's start. Keys are
  `[time, value, ease]`, or full keyframe objects. The ease shapes the move from that key to the
  next one, so put it on the key where the move starts (an ease on the last key does nothing).
- Eases: `linear`, `hold`, `inOutCubic`, `outCubic`, `inCubic`, `outBack`, `inOutBack`, `outExpo`, `inOutExpo`.
- `gain` keys stay in the single fast export pass. A keyframed graphic no longer splits the sound into
  per-frame pieces: animated timelines render the picture silent, render the sound once, then mux
  the two. Keyed pan and audio fades still take the per-frame sound path.
- Captions: the preset is applied first and `style` last. At 1080 wide, `outlineWidth` 25 gives
  about a 14 px stroke. Caption sizes and strokes are scaled by 0.5625 on a vertical canvas.
- `wordPop` pops each word as it is spoken, from 0.8 up to 1.06 and back to 1.0 on an easeOutBack,
  with motion blur. The `reel` preset uses the same snap for the line entrance. `accent` sets the
  highlight color. The preview and the export draw captions with the same code.
- For motion graphics that need masks, glows or 3D, render them elsewhere as ProRes 4444 `.mov`,
  import that file, and place it under `clips`. The export keeps the alpha.

## 4. Build and render

```
node --experimental-strip-types scripts/build-timeline.mjs reel1.json --dry-run   # counts only
node --experimental-strip-types scripts/build-timeline.mjs reel1.json             # one PATCH
node --experimental-strip-types scripts/build-timeline.mjs reel1.json --render    # and queue the export
```

- Rerunning replaces what the previous run wrote and leaves clips made by hand alone.
- Review and adjust the result in the browser.
- The render uses the project size: H.264 at High · 20 Mb/s, AAC at 320 kb/s. Download it from
  `/api/renders/<id>/download`.
- An export size with a different aspect ratio from the project is refused, so a vertical project
  can't be squashed into 1920 × 1080. Deliver also starts at the project's size.
