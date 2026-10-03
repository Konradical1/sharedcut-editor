# Media storage v3: fewer, smaller preview files

Date: 2026-10-03. Status: approved by Konrad ("you're in total control"). Production disk on the Dell:
12 GB free.

## Problem

Measured on the Dell on 2026-10-03:
- Originals: 144 GB across 841 assets.
- Derived files: about 96 GB, which is more than half the size of the originals.

| File | Total | Count | Format |
|---|---|---|---|
| proxy.mp4 | 36.7 GB | 709 | 1920, all-intra, CRF 16, 8-bit |
| color-v1.mp4 | 33.0 GB | 672 | 1920, all-intra, CRF 14, 10-bit 4:2:2 |
| proxy-half-v1.mp4 | 14.1 GB | — | 960, all-intra |
| stream-v2.mp4 | 5.0 GB | — | 960, 2 s GOP |
| proxy-quarter-v1.mp4 | 4.6 GB | — | 480, all-intra |
| proxy-v2.mp4 | 1.2 GB | 29 | pre-git Resolve imports, 30 live references |
| stream-low-v1.mp4 | 0.7 GB | — | 480, 2 s GOP |

stream-v1 (1.1 GB, an orphan) was already deleted.

## The new set

| Asset field | File | Recipe |
|---|---|---|
| `proxyUrl` (opaque video) and `colorProxyUrl` (same URL) | `full-v3.mp4` | See the full-v3 recipe below. |
| `proxyVariants.Stream` and `proxyVariants['1/2']` | `stream-v2.mp4` | **Unchanged name and recipe**, so remote footage caches stay valid. Built from full-v3, or from the original when that is easier. |
| `proxyVariants.StreamLow` and `proxyVariants['1/4']` | `stream-low-v2.mp4` | 480 wide, libx264 veryfast, CRF 20, `-maxrate 900k -bufsize 1800k`, **GOP round(fps/2)** (minimum 2), 8-bit yuv420p, tv range, bt709, AAC. Also used for scrubbing, hover thumbnails and the filmstrip. |
| `audioProxyUrl` | `audio-v1.m4a` | Unchanged, but AAC-encode it when the source audio is not already AAC. |
| alpha assets | `*-alpha-v1.webm` | Unchanged. |
| thumbnail / filmstrip / image-v2.png / audio.m4a | unchanged | |

The full-v3 recipe:
- Up to 1920 wide.
- libx264 `-preset veryfast -crf 17`, GOP round(fps/2) (minimum 2).
- `yuv422p10le`, tv range, `colorspace bt709`, primaries and transfer `unknown`.
- The same matrix, range and toneMap handling as today's color-v1 (media.ts `prepareColorProxy`).
- AAC 128k stereo 48k, faststart, built from the original.

Measured on the Dell (20 s samples, SSIM measured against color-v1):

| Clip | Old color-v1 | New full-v3 | Shrink | SSIM | Encode speed |
|---|---|---|---|---|---|
| Soccer, 4K60 log | 25.3 Mbit/s | 11.5 Mbit/s | 2.2× | 0.9959 | ~84 fps |
| 1080p interview | 29.5 Mbit/s | 6.9 Mbit/s | 4.3× | 0.9966 | — |

Chrome (Mac, channel chrome) decodes long-GOP High 4:2:2 10-bit both natively and through WebCodecs, giving VideoFrame format `I422P10`. That is a format colorPreview already accepts.

Expected result: about 96 GB of derived files becomes about 17–20 GB.

## Code changes

- **`prepareMedia` / `preparePreviewVariants` / `prepareColorProxy`** (server/media.ts):
  - Produce the new set: full-v3 first, so `onPlayable` fires on it, then the variants and the filmstrip.
  - Stop producing proxy.mp4, color-v1, half and quarter.
  - Return `colorProxyUrl` pointing at full-v3 for opaque video.
  - When a re-prepare drops a field, set it explicitly to `undefined`, because `publish()` spreads over the old row.
  - Variants built from full-v3 use `in_range=tv`, and the matrix is already bt709.
  - Keep the `?v=` cache-busting convention.
  - Fix the stale encoder comment around media.ts:157-160.
- **Filmstrip source list** (media.ts ~444): stream-low-v2, then stream-v2, then full-v3, then the original.
- **Optical flow input** (index.ts ~1347-1350):
  - Full and Color read full-v3.
  - 1/2 and Stream read stream-v2.
  - 1/4 reads stream-low-v2.
  - Alpha assets read their alpha file or the original, never an opaque proxy.
- **Startup passes** (index.ts ~1589-1650):
  - Replace the old preview-upgrade and color-fill passes with the migration below.
  - The camera-metadata pass that rebuilt color-v1 now rebuilds full-v3.
- **Client** (src/services/playback.ts, scrubFrames.ts, MediaThumbnail.tsx):
  - The `playbackUrl` chain keeps working through the fields.
  - `scrubFor` now scrubs stream-low-v2, which has a 0.5 s GOP and isn't all-intra. Make `createScrubFrames` correct and fast for short-GOP files: decode from the previous keyframe, and don't assume every frame is a keyframe.
  - Nothing may fall back to proxy.mp4 names.
- **Startup sweep:** delete `.preview-*`, `.color-*`, `.thumbnail-*` and `.filmstrip-*` temp folders inside `media/*/prepared` that are older than 1 hour. Never touch `data/transitions` or `data/sfx`.
- **Tests and checks:** update everything the survey lists:
  - media.test.ts 27-47, 155-159, 233-247, 387-389, 439-449
  - reprobe.test.ts
  - playback.test.ts 7-27
  - scrubFrames.test.ts
  - footageCache fixtures
  - scripts: playback-browser-check, newspaper-playback-check, media-loading-check, remote-playback-check, color-source-check, color-managed-browser-check
- **Docs:** architecture.md, README, playback-performance.md, WINDOWS_NATIVE.md, and the CLAUDE.md rollback note (old builds 404 on the deleted names).

## Migration of existing assets (background startup pass, resumable)

**Which assets:** every opaque video asset whose `proxyUrl` isn't full-v3, or whose StreamLow isn't stream-low-v2.

**Scheduling:** run it on the media work queue, one asset at a time, so exports and new uploads go first. Log progress.

**For each asset:**
1. Pick the source:
   - **Video:** `color-v1.mp4` if it exists (already tone-mapped, bt709, tv range, 10-bit), otherwise the original.
   - **Audio:** `audio-v1.m4a` or the original.
2. Encode full-v3 and stream-low-v2 in one FFmpeg run, into a temp folder. Rebuild stream-v2 only if it's missing.
3. Verify each output with ffprobe:
   - duration within one frame of the source;
   - video stream present;
   - audio present when the asset has audio;
   - the expected pix_fmt and size.
4. Rename the outputs into `prepared/`.
5. `updateAsset` with the new fields, through the workspace store, never raw SQL.
6. Only then delete the superseded files, with retry on Windows EPERM: proxy.mp4, proxy-v2.mp4, color-v1.mp4, proxy-half-v1.mp4, proxy-quarter-v1.mp4 and stream-low-v1.mp4.

**Alpha assets:** delete the stale opaque proxy.mp4 and color-v1.mp4, and clear `colorProxyUrl`.

**Disk guard:** before each asset, require the estimated output size plus 1 GB free.

**Interruption safe:** a hard kill leaves only a temp folder, which the startup sweep removes. Re-running picks up where it stopped.

**Orphans:** assets whose `proxyUrl` points at a missing file (proxy-v2 had 30 references against 29 files) get rebuilt from the original.
