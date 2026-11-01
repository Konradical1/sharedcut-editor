# Browser playback and caching — September 21, 2026

SharedCut stays entirely web based. The Mac hosts the application and media today; the Lenovo Windows machine is the production target. No cloud storage or manual download-for-editing workflow is required. The public-access tunnel does not change where media lives.

## What changed

The previous queue captured pictures from a hidden, playing video element. A missed browser presentation callback could leave a permanent hole in that queue. Pausing that decoder when the queue filled also added repeated startup delays. Cached file bytes could therefore coexist with “preparing playback frames” interruptions.

Forward MP4 preview now uses Mediabunny's demuxer and WebCodecs in a dedicated worker. It decodes samples in presentation order, independently of UI presentation callbacks. The compositor consumes exact timestamp intervals, closes consumed frames, and requests more through a bounded credit queue. Up to half a second, 24 pictures, or approximately 32 MiB is retained per clip (at least two pictures, plus the decoder library's small internal queue). Current and upcoming clips stay warm; seeks invalidate obsolete output. Unsupported codecs/browsers, originals, reverse/freeze and extreme retiming retain the native fallback.

The display clock advances on the timeline's frame grid. Grading prepares the next *displayed* samples, which matters when a 60 fps source appears in a 24 fps project. Masks and color readback use the prepared picture's timestamp. Embedded audio has its own timeline-following decoder; decoding pictures ahead cannot play sound early.

Three caches have different jobs:

- **Prepared media on the host:** reusable 960-pixel Stream and 480-pixel StreamLow variants, alongside existing editing/color proxies. Auto preview can choose the smaller stream from measured network capacity or sustained buffering. Selection is conservative and stays reduced until playback is retried; this is a two-level policy, not a complete HLS/DASH quality ladder. Originals and exports remain unchanged.
- **Encoded bytes in the browser:** verified 1 MiB chunks in Cache Storage, automatically fetched near the playhead and upcoming cuts, then through the rest of the timeline. Current/next playable windows take priority over distant footage. The approximate 2 GiB rolling budget stops distant prefetch near its ceiling and evicts older unprotected chunks; active windows and indexes are retained. Browser quota and eviction still apply.
- **Decoded pictures in memory:** the bounded worker queue above. These are short-lived, larger than encoded bytes, and never confused with persistent cache coverage.

Decoder reads are bounded byte ranges with small local read-ahead. Unbounded file prefetch would request unrelated, uncached portions of a long source and break replay even when every timeline range was already saved. The service worker shares overlapping requests, streams needed bytes immediately and saves complete validated chunks in the background. Cache Off also applies to decoder workers.

## Automatic rendered previews

Sustained compositor cost exceeding the frame budget triggers background requests for four-second timeline previews in Auto mode. The host reuses the existing export renderer and bounded work queue. The interactive renderer remains available until a matching prepared picture exists; audio continues through the normal mixer.

Preview identities include edit state and source-file metadata. Edits invalidate client entries immediately; transient slider/text edits keep the interactive renderer. Finished files publish atomically. Requests and file access require project authorization. Server work is bounded to two pending preview jobs, 64 recent records and approximately 512 MiB of finished files. A costly section may take longer than real time to prepare; its first pass is not guaranteed smooth on an underpowered client. Prepared sections can be reused.

## Truthful indicators

Green means the required clip bytes are **saved on this computer**, not that every picture has been decoded. Gray means not cached/queued, blue means downloading, and failed or retrying downloads have separate error states. Playback preparation/errors are shown independently, so a decoder wait cannot erase verified green coverage. Video gaps and audio-only sections do not paint the picture ruler green.

The expandable Footage on this computer panel shows per-clip progress, stored coverage, transferred bytes, speed and retry controls. Trusted HTTPS (or localhost) is required for browser caching. Another computer starts with its own empty cache. Cache persistence is automatic but subject to the browser's storage policy.

The application also negotiates gzip for its initial state. Project-scoped state/history loading remains separate work; omitting unloaded project arrays from the existing save contract would risk deleting data.

## Validation

All browser fixtures use isolated accounts, databases and media copies. They do not edit the live Newspaper project.

- `scripts/newspaper-playback-check.mjs`: real Newspaper footage, every cut and its next six pictures, continuous loading/error telemetry, pause stability, seek-back, optional embedded audio and long 60 fps footage. Its HTTP proxy throttles aggregate media traffic, including service-worker downloads.
- `QA_OFFLINE_REPLAY=1`: waits for timeline coverage, blocks media at the origin, reopens the project and plays the later graded cuts. This catches unnecessary uncached reads as well as false-green coverage.
- `scripts/media-loading-check.mjs`: new-computer cache, real writes, offline non-header range, original-to-Stream fallback. `QA_RENDER_PREVIEW=1` adds controlled compositor pressure, verifies automatic server rendering is displayed, then edits the clip and checks stale-preview invalidation.
- Unit/integration checks cover 24/60 fps queue refill, generation cancellation and resource disposal, rolling cache eviction, range validation and shared downloads, HTTP authorization and preview invalidation. GPU color checks include a queued planar picture whose native video clock is deliberately ahead.

Run after `npm run build`, setting `PLAYWRIGHT_MODULE` if Playwright is installed outside the repository:

```sh
npm test
QA_DOWNLOAD_MBPS=10 QA_EMBEDDED_AUDIO=1 QA_PLAY_SECONDS=120 node --experimental-strip-types scripts/newspaper-playback-check.mjs data artifacts/qa/newspaper-webcodecs-continuous.json
QA_OFFLINE_REPLAY=1 QA_START=104.9 QA_PLAY_SECONDS=14 node --experimental-strip-types scripts/newspaper-playback-check.mjs data artifacts/qa/newspaper-webcodecs-offline.json
QA_LONG_CLIP=1 QA_QUALITY=Color QA_START=0 QA_PLAY_SECONDS=35 node --experimental-strip-types scripts/newspaper-playback-check.mjs data artifacts/qa/newspaper-webcodecs-color-long.json
QA_RENDER_PREVIEW=1 node --experimental-strip-types scripts/media-loading-check.mjs
node scripts/color-gpu-check.mjs
```

Browser performance measurements use hardware-accelerated Chromium on this Mac (`QA_BROWSER_ARGS='["--use-angle=metal","--enable-gpu"]'` in the Newspaper/media-loading harnesses). These flags are test configuration, not an application dependency. Physical Windows and remote Internet client acceptance still needs the Lenovo: check trusted HTTPS, browser hardware acceleration, cold cache, reopen/reuse, rapid cuts and graded footage near 1:47. New runtime paths use browser APIs, Node and FFmpeg without adding Mac-only workers.

### Recorded results

The production build and all **224 automated tests** passed. Browser runs:

| Scenario | Result |
| --- | --- |
| Newspaper, 120 seconds at 10 Mbps, embedded audio | 2,880 distinct pictures/timeline ticks, 35 cuts, largest picture interval 51.6 ms; zero loading interruptions. |
| Newspaper, 20 seconds at 4 Mbps | 482 pictures/ticks, 15 cuts, largest interval 51 ms; zero loading or decoder errors. All 31 clip ranges subsequently cached. |
| Reopen cache, media origin blocked, 14 seconds from 1:44.9 | 337 pictures/ticks, eight cuts, largest interval 53 ms; zero loading interruptions and zero requests reaching the media origin. |
| Continuous 60 fps C1064 source, Color preview, 35 seconds | 840 displayed pictures, largest interval 50.5 ms; zero loading interruptions. |

Reports are in `artifacts/qa/newspaper-webcodecs-{continuous,slow-link,offline,color-long}.json`. The project contains genuine picture gaps; timeline ticks through those gaps are included in its frame totals. The slow-link harness initially timed out waiting for the *entire project* cache after smooth playback; the completion allowance was corrected independently of playback thresholds, and the complete rerun passed.

The automatic server-render browser check passed displayed-preview and edit-invalidation checks. GPU color/mask parity, pause stability, seeking back and embedded audio checks passed. These measurements establish the tested hardware/network cases, not a guarantee for every browser, codec or effects stack.

### Black-picture regression correction

The timing checks above counted delivered frames but missed black graded pictures. The planar color renderer still fitted its source using the unloaded native video's zero dimensions. It now uses the decoded frame's display dimensions, independently of native video metadata.

The GPU regression uses a nonuniform queued picture and an unloaded video element; it failed before the fix and passes afterward. `QA_VERIFY_PICTURES=1` in the Newspaper harness checks actual camera pixels in all five quality presets in both Edit and Color. The old build reproduced black footage with only about 1% lit pixels from text; the corrected build passes all ten cases with about 62% lit pixels. The production build, GPU color/mask parity and all 224 automated tests pass. Local and public HTML serve the corrected bundle; existing tabs need a reload.

## Activation

Run the production build and restart the application server through its normal deployment process to enable the preview routes and automatic preparation of missing StreamLow variants. Reload editor tabs for the new decoder and worker. Existing variants stay usable while additional previews prepare. See `docs/WINDOWS_NATIVE.md` for running on Windows.

This build was activated on the existing Mac host with a graceful server restart. Local and public health checks returned 200, and both served the current frontend bundle. The host began preparing missing smaller streams automatically. No cloud migration or live project edits were performed; the normal preparation queue adds derivative media and updates its metadata.
