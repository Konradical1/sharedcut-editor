# Optical flow and speed curves

Enable **Optical flow** below Speed in the video inspector. On Windows/Linux,
run `npm run setup:flow` to install the portable OpenCV worker. It supports
freezes, 1% slow motion, reverse, direction-changing curves and source-end
holds. The worker uses exact source timestamps, bidirectional motion, and
16-bit source frames; the final intermediate is 10-bit ProRes. Browser previews
use H.264 4:2:0 for Windows hardware decoding. Mac hosts retain the existing
VideoToolbox engine. `FRAME_LINE_FLOW_PYTHON` overrides the portable interpreter.


The worker uses Apple's VideoToolbox frame-rate conversion with quality prioritization, its default algorithm revision, 10-bit pixel buffers, and pooled output buffers. It synthesizes at the source timestamps calculated by FrameLine's existing speed-curve integration. Exact source frames and freezes do not require interpolation. A conservative luma-change detector holds through likely hard cuts; this is a heuristic, not a guarantee against motion artifacts. Quality has been functionally checked, not ranked against every competing interpolation model.

Preview prepares four-second sections from the selected proxy quality. It warms the next section, plays finished results at timeline speed, and keeps the original audio path. Changing source trims, timing curves, frame rate, quality, or native-worker version invalidates the cache. Obsolete requests are cancelled; one native job runs at a time. Finished previews are capped at approximately 2 GiB on disk and served through authenticated range requests. Full-resolution exports use originals and temporary ProRes intermediates, removed on completion or cancellation.

Speed-only picture is rendered continuously after interpolation. If only audio remains animated, its existing audio automation runs separately so it does not force a full-resolution picture render for every frame. Other animated visual effects retain the existing per-frame export path. Reverse interpolation currently uses bounded decoder seeks and may prepare more slowly than forward ramps.

The graph now has a full-curve overview. Select a ramp there to fit its endpoints and Bézier handles in the editing view. **Fit selected ramp**, **Fit visible**, **Fit all**, and vertical zoom change only the view. The scale stays fixed during a drag.

Validation:

```sh
npm test
npm run build
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --experimental-strip-types scripts/optical-flow-check.mjs
```

The native check measures intermediate motion rather than merely checking that a video file exists. It also checks extensionless originals, cache reuse, cancellation, output duration, and audible ramp exports. Browser checks cover the toggle, authenticated cached video, both ramp scales, and playback across a cache boundary. The synthetic browser run recorded zero dropped frames. A one-second 1280 × 720 segment from the existing speed-ramp footage also rendered successfully; its first full-quality preparation took about eight seconds on this Mac. Preparation is background work, not a real-time guarantee.

The portable checks run with `npm run test:optical-flow` and
`npm run test:optical-flow:browser`. See [Windows validation](WINDOWS_VALIDATION.md).
