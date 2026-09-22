# Footage cache and render bar — design

Date: 2026-09-16. Product: SharedCut.

## Problem

Every byte of footage a viewer plays travels browser → Cloudflare edge → tunnel → server, at
70–100 ms per request against 1 ms on the LAN. `<video>` fetches in many small byte ranges and every
seek opens a new one, so cuts and scrubs pay that round trip several times. Nothing keeps footage on
the client: proxies are `Cache-Control: private` (Cloudflare will not cache them) and Chrome's
media cache is small and evicts quickly. One decoder still loading holds the whole composite.

The Stream proxy is ~2 Mb/s (≈15 MB per minute of source), so keeping the used parts of every
timeline clip on the client's disk is cheap.

## Decision

Cache **byte ranges** of the existing proxy files on the client, transparently, and prefetch the
range each clip actually uses plus handles. Long source clips of which the edit uses ten seconds
cost ten seconds of bytes, not the whole file.

Two halves:

1. **Service Worker `public/footage-worker.js`** intercepts same-origin `GET` requests carrying a
   `Range` header for `/api/**/*.mp4|m4a|mov|webm` (not `/original`). Files are addressed in
   1 MiB aligned chunks stored in Cache Storage (`footage-v1`), one entry per chunk keyed
   `url#c=<index>`, plus one `url#meta` entry holding size and content type. A request is answered
   as a streamed 206 built from cached chunks; a missing chunk is fetched from the network as an
   aligned 1 MiB range (with credentials), stored, and served. One chunk is fetched ahead while the
   previous one streams. Anything that is played therefore becomes cached; nothing is held in memory
   beyond the chunk in flight. Requests without `Range`, suffix ranges, or non-OK network answers
   pass through untouched.
2. **Page-side `src/services/footageCache.ts`** decides *what* to have cached before it is needed.
   For each clip on the active timeline it resolves the playback URL for the current viewer quality
   (via `playbackUrl`), fetches the `moov` (first chunk; faststart puts it at the head), and parses the
   sample tables (`src/services/mp4Index.ts`: mvhd/mdhd timescales, stts, stsz, stsc, stco/co64,
   stss) into a time → byte mapping. The wanted range is `[sourceIn − 2 s, sourceOut + 2 s]`
   snapped back to the preceding sync sample, across every track in the file. Wanted chunks are
   fetched two at a time in playhead order (clips ahead of the playhead first, then behind, nearest
   first), through the normal fetch path so the Service Worker stores them. Audio clips use the audio
   proxy the same way. Titles, shapes, compositions and originals are skipped.

   Coverage is tracked per clip from `cache.keys()` at start plus `stored` messages the worker posts
   after each write. A 2 GiB cap is enforced by the page: files are ranked by last use (`#meta`)
   and the oldest chunks are deleted when `navigator.storage.estimate()` reports usage over the cap.
   `navigator.storage.persist()` is requested once.

   Browsers without Service Workers or Cache Storage get today's behaviour and a yellow bar.

## Render bar

A 3 px strip at the bottom of the timeline ruler, computed by `src/services/renderBar.ts` from the
clips of the active timeline:

| Colour | Meaning |
| --- | --- |
| Green | every layer under that time has its wanted chunks cached and nothing is processing |
| Yellow | playable, but at least one layer streams from the server |
| Red | server work in progress or failed under that time: media not `ready`, or a Stabilize / Optical flow / Smart Mask activity (`clipStatus.ts`) |
| none | no clip there |

Red beats yellow beats green where clips overlap. Segments are merged so the DOM holds one element
per colour run, not one per clip.

## Settings

Playback → **Footage cache** (On/Off, default On) and a **Clear cache** button showing current usage.
Off unregisters the worker and clears the cache.

## Out of scope

Edge caching at Cloudflare, caching originals, per-user cache limits, and the 26 MB state document
(history and waveforms) — the latter is a separate follow-up.

## Verification

- `mp4Index.test.ts`: a tiny FFmpeg-generated MP4; parsed sample offsets match `ffprobe -show_packets`.
- `renderBar.test.ts`: overlapping clips resolve to the right colour runs.
- `npm run build`; the QA harness at `QA_DOWNLOAD_MBPS=25` before/after, judged by `media[]` network
  request counts and dropped frames, not fps (SwiftShader ceiling).
