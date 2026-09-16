# FrameLine transitions — design

Status: proposed, awaiting approval
Date: 2026-09-11

## Goal

A complete transition system: a drag-and-drop library that snaps to cuts, ~28 built-in
transitions including motion-blurred camera moves, an overlay pack of light leaks cut from
three supplied source videos, a scrubbable preview, and a Transition property group in the
Inspector. Transitions must survive collaboration, undo, snapshots, and must actually export
through FFmpeg — not be refused at render time as they are today.

## What already exists

- `Clip.transition?: string` is in `src/state/models.ts` and set by `src/state/demo.ts:57`.
- `Timeline.tsx:218` renders a `.clip-transition` chip.
- `MediaPanel.tsx:39` has a Transitions tab wired to an empty array and the message
  "Transitions are not available in this version."
- `server/media.ts:250` throws on any clip carrying a transition.
- `server/media.ts:249` throws on any non-Normal `blendMode` at export (preview supports them).
- Preview compositing (`src/services/playback.ts`) already supports `screen` blending.
- Effects establish the pattern to copy: one definition, a canvas implementation for preview
  (`effects.ts:detailPixels`) and an FFmpeg filter string for export (`media.ts:videoFilters`).

## Data model — no new collection

A transition is stored on the **incoming** clip. This is the central decision: it inherits
collaboration merge, personal undo, snapshots, save validation, split/trim/copy and the
`operations` history with no new server plumbing, because clips already flow through all of it.

    clip.transition                    string   incoming transition at clip.start
    clip.properties.transitionDuration number   seconds
    clip.properties.transitionAlign    string   'center' | 'in' | 'out'
    clip.properties.transitionCurve    string   "x1,y1,x2,y2", same format as Keyframe.curve
    clip.properties.transitionParams   string   JSON, per-transition parameters
    clip.properties.transitionAudioId  string   set once leak audio is expanded to a track

    clip.properties.transitionOut      string   trailing transition (clip-to-nothing at the tail)
    clip.properties.transitionOut{Duration,Align,Curve,Params,AudioId}

`transitionParams` follows the precedent of `textDocument` and `shapeDocument`: a validated
JSON string inside `properties`. Server-side validation (`server/index.ts`, the `key === 'clips'`
branch) gains a `validateTransition` call alongside `validateText` / `validateShape` — rejecting
unknown transition names, non-finite durations, and out-of-range parameters at the trust boundary.

Ownership rule: a transition at the head of clip B between A and B belongs to B. A head
transition with nothing before it is a transition *in*. A tail transition is `transitionOut`.

## Geometry — clips never move

Dropping a transition changes **no clip's start, duration, or track**. The transition of
duration `d` at cut time `t` defines a virtual window. Inside it the renderer reads *past* A's
out point and *before* B's in point, consuming unused source handles. This is Resolve/Premiere
semantics and it is the collaboration-safe choice: no ripple, no overlap, nothing downstream
shifts while someone else is editing.

Handle availability, checked at drop and on every duration change:

    A needs  asset.duration - (A.sourceIn + A.duration * speed) >= d * outShare
    B needs  B.sourceIn >= d * inShare

where the shares come from `transitionAlign`. If one side is short, alignment auto-shifts
toward the side that has handles. If neither side has any handle, the drop is refused with a
message naming the clip and the shortfall, offering to shorten the transition to what fits.
Titles, shapes and compositions have unlimited handles (they are generated, not decoded).

## Transition registry

`src/services/transitions.ts` — one definition per transition, mirroring `effectDefinitions`:

    { kind: 'dissolve' | 'motion' | 'wipe' | 'stylized' | 'overlay',
      description, parameters: TransitionParameter[],
      draw(target, a, b, progress, params, size),     // canvas, used by preview AND the library card
      filters(context): string[] }                    // FFmpeg filter_complex fragment

Every transition must supply both. There is no silent fallback: a transition without a working
FFmpeg recipe does not ship.

### Dissolves
Cross dissolve · Dip to black · Dip to white (flash) · Dip to colour · Film dissolve ·
Additive dissolve

### Optical
Blur dissolve · Defocus · Glow bleed · Camera flash

Camera flash needs a **Bloom** effect, added to `effectDefinitions` as a standalone effect as
well: threshold the highlights, blur them, screen them back. Preview on the layer canvas;
export as `split` + `lutyuv` threshold + `gblur` + `blend=all_mode=screen`.

### Motion — all with baked motion blur
Push L/R/U/D · Slide · Whip pan L/R · Zoom in (punch) · Zoom out (pull) · Whip zoom ·
Spin · Impact shake

**Frame exhaustion.** Zooming out or pushing runs the frame out of pixels. Both sides are
mirror-padded: `fillborders=mode=mirror` in FFmpeg, mirrored `drawImage` calls on canvas.
Under the motion blur it is not visible.

**Motion blur** is a `shutterAngle` parameter (default 180°), not a checkbox.
- Preview: 4–6 accumulated draws at sub-frame offsets with divided alpha. Cheap, reads right.
- Export: the moving side is generated at `fps * N` through the geometry expression, averaged
  with `tmix=frames=N`, then decimated back with `fps`. `N` derives from shutter angle.
  This is the accurate one.

Both read the same motion curve, so preview and export agree in feel while export is correct.
This is the same documented preview/export split the project already has for grain, denoise
and blur.

### Wipes
Linear (angle parameter) · Iris · Barn door

### Stylized
RGB split · Luma burn-through

### Overlay
Light leak / film burn pack — see below. Renders as a cut (or short dissolve) between A and B
with the leak screen-blended on top, plus its embedded audio.

## Light leak extraction

`scripts/extract-transitions.mjs`, run once, over the three supplied files:

    Ultimate Light Leaks & Film Burns Overlay Pack   43.9s  1080p30  ~17 leaks, clean
    Enhance Your Videos with 4K Film Burn            14.3s  1080p30  flickers through black
    Vibrant Video Overlays and Dynamic Sound Effects 40.4s  1080p24  flickers through black

`blackdetect` separates the first file cleanly. The other two flicker to black *mid-burn*, so
naive detection over-segments. The script therefore applies hysteresis: black runs shorter than
`--min-gap` (default 0.3s) do not split a segment, and segments shorter than `--min-duration`
(default 0.35s) are discarded. Expect 35–45 usable leaks, not 30.

Per segment the script emits the cut clip (2 frames of padding each side, H.264 CRF 18 + AAC),
a 9-frame contact sheet PNG, and a manifest entry (id, duration, peak-luma time, audio peak).
The contact sheets are reviewed by eye, bad cuts dropped, and the survivors named before the
pack is accepted. Thresholds stay as script flags — these are real recordings and the numbers
need tuning per file.

Storage: `FRAME_LINE_DATA/transitions/`, served by new authenticated `GET /api/transitions` and
`GET /api/transitions/:id` endpoints modelled directly on the existing shared-fonts endpoints.
Shared across every project on the installation, never in the git repo, and extensible — an
"Add overlay" upload accepts new leaks and black-background clips later.

## Audio

Leak audio is embedded in the transition by default, mixed at `transitionAudioGain` (default
-6 dB). Right-click → **Expand audio to track** creates a real audio clip on
`companionAudioTrack(tracks, videoTrack)` — the helper already exists in `services/timeline.ts` —
pointing at the leak asset with `sourceIn` matched to the transition window, and sets
`transitionAudioId` so the embedded copy mutes. One `commit('ClipAdded', ...)`, fully undoable.

## Rendering

**Preview** (`src/services/playback.ts`). `playbackLayers` becomes transition-aware: inside a
transition window it emits both sides of the pair plus the transition descriptor. `renderLayers`
draws A and B to two offscreen canvases, then calls the transition's `draw` to composite into
the target in place of the normal `finishLayer` path. Overlay transitions take a shorter route:
straight cut plus a screen-blended leak layer, which the compositor already supports.

**Export** (`server/media.ts`). The throw at line 250 is removed. Each transition pair emits its
`filters()` fragment into the existing `filter_complex`. Most dissolves and wipes map onto
`xfade`; motion and overlay transitions build their own chains from `split`, `crop`/`zoompan`,
`fillborders`, `tmix` and `blend`. The `blendMode` throw at line 249 is narrowed so it still
rejects user-set clip blend modes but permits transition-owned overlay compositing. Leak audio
becomes another `amix` input.

## UI and user flow

**Library.** The existing Transitions tab, currently stubbed out, becomes a grid of cards
grouped by kind. Hovering a card loops its preview; dragging horizontally across a card scrubs
the transition frame by frame. The card renders through the *same* `draw()` the timeline uses,
over two contrasting bundled demo stills (`public/media/mountains.jpg` and `street.jpg`), so
what is previewed is literally the shipping implementation.

**Placing.** Drag a card over the timeline; the nearest cut highlights and snaps, reusing the
existing snapping in `Timeline.tsx:179`. Drop target is `application/x-frameline-transition`,
following the `x-frameline-effect` pattern already in the track lane. Three valid drops:

- on a cut between two clips → a centred two-clip transition
- on a clip head with nothing before → transition *in*
- on a clip tail with nothing after → transition *out*

`Cmd+T` applies the default transition at the cut nearest the playhead.

**On the timeline.** A bowtie chip straddling the cut. Drag its edges to change duration
(clamped to available handles, live), drag its body to change alignment.

**Inspector.** A new Transition property group: duration, alignment, timing curve (reusing the
existing bezier graph editor from keyframes), direction, shutter angle, and the transition's own
parameters — colour, angle, leak variant, leak audio gain.

**Right-click.** Replace · Copy · Delete · Expand audio to track.

**Settings.** Default transition and default duration.

## Testing

- `src/services/transitions.test.ts` — window maths, handle availability, alignment auto-shift,
  curve evaluation, parameter clamping, transition survival across split/trim/copy.
- `server/transitions.test.ts` — `validateTransition` rejects unknown names, non-finite
  durations, out-of-range parameters, oversized params JSON.
- `server/media.test.ts` — extended with real FFmpeg exports containing a cross dissolve, a
  motion-blurred push, and a light leak; decoded frames asserted (mid-transition frame differs
  from both sources; leak frame is brighter than the underlying cut).
- `scripts/transitions-check.mjs` — Playwright, same environment variables as the other checks:
  drag a transition onto a cut, scrub a library card, open the Inspector group, expand leak
  audio, reload and confirm persistence, second session sees the transition.
- `scripts/extract-transitions.mjs --report` — contact sheets for manual review of the cuts.

## Documentation

README gains a Transitions section; `docs/architecture.md` gains a transitions subsection. The
"arbitrary transitions are not implemented" claims in both files are corrected, and the
preview/export fidelity note is extended to cover motion blur sampling.

## Deliberately out of scope

- Transitions between clips on *different* tracks. Same-track cuts only.
- Audio-only transitions (crossfades) — clip fade handles already cover this.
- Transition presets / user-saved transitions.
- OTIO interchange for transitions; `server/resolve.ts` already warns that transitions need a
  Resolve render, and that warning stays accurate.

## Risks

- **Leak cut quality.** Files 2 and 3 flicker through black mid-burn. Mitigated by hysteresis
  plus a manual contact-sheet review; the count may land below 30 after culling.
- **Motion blur export cost.** `tmix` at N× frame rate multiplies decode work on a serial
  worker queue. Shutter angle caps N; the ceiling gets a `ponytail:` comment.
- **Handle exhaustion** on tightly trimmed cuts is a real workflow friction. Mitigated by
  auto-shifting alignment and a clear refusal message rather than a silent bad render.
