import { ease, linearCurve } from './animation.ts';
import { isShape } from './shapes.ts';
import { isTitle } from './text.ts';
import type { Clip, MediaAsset, Track } from '../state/models.ts';

/**
 * A transition lives on the incoming clip, never in its own collection: clips already flow
 * through save validation, three-way merge, personal undo and snapshots, so a transition
 * stored there inherits all of it. `transition` is the head transition at `clip.start`;
 * `properties.transitionOut` is the tail transition at `clip.start + clip.duration`.
 */
export type TransitionSide = 'in' | 'out';
export type TransitionKind = 'Dissolves' | 'Optical' | 'Motion' | 'Wipes' | 'Stylized' | 'Overlays';
export const transitionKinds: TransitionKind[] = ['Dissolves', 'Optical', 'Motion', 'Wipes', 'Stylized', 'Overlays'];

export interface TransitionParameter { key: string; label: string; initial: number | string; min?: number; max?: number; step?: number; suffix?: string; choices?: string[] }
export type TransitionParams = Record<string, number | string>;

/** Both sides of the cut, already rendered full-frame, plus the eased progress between them. */
export interface TransitionDrawContext {
  target: CanvasRenderingContext2D;
  outgoing: CanvasImageSource | null;
  incoming: CanvasImageSource | null;
  overlay: CanvasImageSource | null;
  progress: number;
  raw: number;
  params: TransitionParams;
  width: number;
  height: number;
}

/** Everything the FFmpeg planner needs; `tag` keeps generated filter labels unique per graph. */
export interface TransitionPlanContext {
  duration: number;
  width: number;
  height: number;
  fps: number;
  params: TransitionParams;
  /** Motion-blur sub-frame multiplier derived from shutter angle; 1 disables sub-framing. */
  samples: number;
  tag: string;
}

export interface TransitionExport {
  /** Name passed to FFmpeg's xfade filter. */
  xfade?: string | ((params: TransitionParams) => string);
  /** Per-side filters applied inside the window branch, before the xfade. */
  side?(role: TransitionSide, context: TransitionPlanContext): string[];
  /**
   * Filters applied to the xfade result. The first entry is the inbound label placeholder and
   * the remainder are emitted verbatim, so a definition can introduce its own extra streams.
   */
  after?(context: TransitionPlanContext): string[];
}

export interface TransitionDefinition {
  kind: TransitionKind;
  description: string;
  parameters: TransitionParameter[];
  /** Motion transitions carry baked motion blur and default to a longer, eased window. */
  motion?: boolean;
  /** Peak travel across the window; both the preview blur and the export sampler read it. */
  travel?: Travel;
  /** Overlay transitions composite a light-leak clip over an otherwise straight cut. */
  overlay?: boolean;
  defaultDuration?: number;
  defaultCurve?: [number, number, number, number];
  draw(context: TransitionDrawContext): void;
  ffmpeg: TransitionExport;
}

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

/** How far the picture travels across the whole window, in pixels. Sizes the shutter sampling. */
export type TravelContext = { width: number; height: number; params: TransitionParams };
export type Travel = (context: TravelContext) => number;
const travelAcross: Travel = c => c.width;
const travelDown: Travel = c => c.height;
const travelAxis: Travel = c => ['Up', 'Down'].includes(String(c.params.direction ?? 'Left')) ? c.height : c.width;
const travelZoom: Travel = c => clamp(Number(c.params.amount ?? 60), 5, 100) / 100 * Math.hypot(c.width, c.height) / 2;
const travelSpin: Travel = c => clamp(Number(c.params.turns ?? 35), 5, 180) * Math.PI / 180 * Math.hypot(c.width, c.height) / 2;
const travelShake: Travel = c => clamp(Number(c.params.amount ?? 40), 0, 100) / 100 * c.width * .04 * 6;
const directionParam: TransitionParameter = { key: 'direction', label: 'Direction', initial: 'Left', choices: ['Left', 'Right', 'Up', 'Down'] };
const shutter: TransitionParameter = { key: 'shutterAngle', label: 'Shutter angle', initial: 180, min: 0, max: 360, step: 5, suffix: '°' };
const intensity: TransitionParameter = { key: 'intensity', label: 'Intensity', initial: 60, min: 0, max: 100, suffix: '%' };
const softness: TransitionParameter = { key: 'softness', label: 'Softness', initial: 20, min: 0, max: 100, suffix: '%' };

/** Cross-fade the two sides; every dissolve-shaped transition starts from this. */
function fadeDraw({ target, outgoing, incoming, progress, width, height }: TransitionDrawContext) {
  target.globalAlpha = 1;
  if (outgoing) target.drawImage(outgoing, 0, 0, width, height);
  if (incoming) { target.globalAlpha = progress; target.drawImage(incoming, 0, 0, width, height); }
  target.globalAlpha = 1;
}

/** Dip through a solid colour: out to the colour across the first half, in from it across the second. */
function dipDraw(colour: (params: TransitionParams) => string) {
  return ({ target, outgoing, incoming, progress, params, width, height }: TransitionDrawContext) => {
    const source = progress < .5 ? outgoing : incoming;
    target.globalAlpha = 1;
    target.fillStyle = '#000';
    target.fillRect(0, 0, width, height);
    if (source) target.drawImage(source, 0, 0, width, height);
    target.globalAlpha = 1 - Math.abs(progress - .5) * 2;
    target.fillStyle = colour(params);
    target.fillRect(0, 0, width, height);
    target.globalAlpha = 1;
  };
}

/**
 * Placement of the mirrored tile at (column, row) around the original frame: a flipped tile is
 * drawn from its far edge back, so its translate lands on the far side. Reflecting about each edge
 * repeats with a period of two frames, which is what lets the surround be one repeating pattern.
 */
export function mirrorTile(column: number, row: number, width: number, height: number) {
  const flipX = Math.abs(column % 2) === 1, flipY = Math.abs(row % 2) === 1;
  return {
    translateX: (column + (flipX ? 1 : 0)) * width, scaleX: flipX ? -1 : 1,
    translateY: (row + (flipY ? 1 : 0)) * height, scaleY: flipY ? -1 : 1,
  };
}

/** The 2×2 period of the reflection, ready to repeat. Its own buffer, because the motion-blur
 *  scratch is mid-draw whenever a blurred zoom asks for its surround. */
function mirrorPeriod(image: CanvasImageSource, width: number, height: number) {
  const buffer = scratchCanvas(width * 2, height * 2, 'mirror');
  if (!buffer) return null;
  const { context } = buffer;
  clearBuffer(context, width * 2, height * 2);
  for (const column of [0, 1]) for (const row of [0, 1]) {
    const tile = mirrorTile(column, row, width, height);
    context.save();
    context.translate(tile.translateX, tile.translateY);
    context.scale(tile.scaleX, tile.scaleY);
    context.drawImage(image, 0, 0, width, height);
    context.restore();
  }
  return buffer.canvas;
}

/** Region of the current transform's local space that still lands on the canvas — how far out the
 *  surround has to reach for this zoom, spin or shake. */
function exposedArea(target: CanvasRenderingContext2D, width: number, height: number) {
  try {
    const inverse = target.getTransform().inverse();
    const points = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => inverse.transformPoint({ x, y }));
    const xs = points.map(point => point.x), ys = points.map(point => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  } catch { return { x: -width, y: -height, width: width * 3, height: height * 3 }; }
}

/**
 * Mirror-tile a frame across whatever the current transform exposes, so a zoom-out, spin or shake
 * always has pixels to reveal — the canvas equivalent of the export's `fillborders=mode=mirror`.
 * A fixed ring of reflected draws only reaches as far as its own radius, and it has to land each
 * tile in the right place to begin with; the reflection repeats every two frames, so one repeating
 * pattern covers any depth at a fixed cost.
 */
function drawMirrored(target: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number) {
  const period = mirrorPeriod(image, width, height);
  const pattern = period && target.createPattern(period as CanvasImageSource, 'repeat');
  if (!pattern) { target.drawImage(image, 0, 0, width, height); return; }
  const area = exposedArea(target, width, height);
  target.fillStyle = pattern;
  target.fillRect(area.x, area.y, area.width, area.height);
}

const curveOf = (params: TransitionParams): [number, number, number, number] => {
  const parsed = String(params.__curve ?? '').split(',').map(Number);
  return parsed.length === 4 && parsed.every(Number.isFinite) ? parsed as [number, number, number, number] : linearCurve;
};

/**
 * Real motion blur is the shutter integrating movement, so a frame is the *average* of the frame
 * composited at many sub-shutter instants — not a stack of ghosts at a fixed alpha.
 *
 * Two things make the difference between smear and slop. First the sample count has to follow how
 * far the picture actually travels in one frame: a slow 1s zoom needs a handful, a 0.3s whip pan
 * across the full width needs dozens. Second, whatever samples are left still sit a few pixels
 * apart, so a small blur at half that spacing closes the gaps and the stack reads as one
 * continuous smear. Accumulating with alpha 1/(i+1) makes each step an exact running mean, so the
 * result is the true average rather than a weighted blend that favours the last sample.
 */
function motionBlur(
  frame: (target: CanvasRenderingContext2D, context: TransitionDrawContext) => void,
  travel: (context: TransitionDrawContext) => number,
): TransitionDefinition['draw'] {
  return context => {
    const { target, params, raw, width, height } = context;
    const shutter = clamp(Number(params.shutterAngle ?? 180), 0, 360);
    const duration = Math.max(1 / 240, Number(params.__duration ?? 1));
    const fps = Math.max(1, Number(params.__fps ?? 24));
    // Shutter width expressed in progress units, so sampling follows the real time scale.
    const open = Math.min(1, shutter / 360 / (duration * fps));
    const curve = curveOf(params);
    const smear = Math.abs(travel(context)) * shutterStep(open, curve, raw);
    const samples = shutter <= 0 || smear < 1.5 ? 1 : clamp(Math.ceil(smear / 1.4), 2, 32);
    if (samples < 2) { frame(target, context); return; }
    const scratch = scratchCanvas(width, height);
    if (!scratch) { frame(target, context); return; }
    const gap = smear / (samples - 1);
    // Half the spacing is what actually merges neighbouring samples; a narrower blur leaves the
    // stack reading as discrete ghosts precisely where the move is fastest. Blurring the average is
    // the same as averaging the blurred samples and costs one filtered pass instead of one per
    // sample, which matters — a canvas filter inside the loop is far too slow to hold frame rate.
    const stack = gap > 1.2 ? scratchCanvas(width, height, 'stack') : null;
    const accumulator = stack?.context ?? target;
    target.save();
    if (stack) clearBuffer(stack.context, width, height);
    accumulator.setTransform(1, 0, 0, 1, 0, 0);
    accumulator.globalCompositeOperation = 'source-over';
    accumulator.filter = 'none';
    for (let i = 0; i < samples; i++) {
      const at = clamp(raw + (i / (samples - 1) - .5) * open, 0, 1);
      clearBuffer(scratch.context, width, height);
      frame(scratch.context, { ...context, target: scratch.context, raw: at, progress: clamp(ease(at, curve), 0, 1) });
      accumulator.globalAlpha = 1 / (i + 1);
      accumulator.drawImage(scratch.canvas, 0, 0);
    }
    if (stack) {
      target.setTransform(1, 0, 0, 1, 0, 0);
      target.globalAlpha = 1;
      target.globalCompositeOperation = 'source-over';
      target.filter = `blur(${clamp(gap / 2, .4, 24).toFixed(2)}px)`;
      target.drawImage(stack.canvas, 0, 0);
    }
    target.filter = 'none';
    target.restore();
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
  };
}

/** Reset a buffer to a clean, empty, untransformed state before it is drawn into. */
function clearBuffer(context: CanvasRenderingContext2D, width: number, height: number) {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  context.filter = 'none';
  context.clearRect(0, 0, width, height);
}

const scratches = new Map<string, { canvas: HTMLCanvasElement | OffscreenCanvas; context: CanvasRenderingContext2D }>();
/** Shared draw buffers, one per named slot. Motion blur composites each sub-frame in `sample` and
 *  accumulates into `stack`; the mirrored surround builds its repeating period in `mirror`. */
function scratchCanvas(width: number, height: number, slot = 'sample') {
  try {
    let entry = scratches.get(slot);
    if (!entry) {
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      const context = (canvas as OffscreenCanvas).getContext('2d') as unknown as CanvasRenderingContext2D | null;
      if (!context) return null;
      entry = { canvas, context };
      scratches.set(slot, entry);
    }
    if (entry.canvas.width !== width || entry.canvas.height !== height) { entry.canvas.width = width; entry.canvas.height = height; }
    return entry as { canvas: CanvasImageSource & { width: number; height: number }; context: CanvasRenderingContext2D };
  } catch { return null; }
}

/**
 * Fraction of the window the picture crosses while the shutter is open at `at`. An eased window
 * moves far faster through its middle than its end-to-end travel suggests — a whip pan on a
 * [.8,0,.2,1] curve covers nearly three times the average — and the middle is exactly where an
 * under-sampled stack stops reading as a smear and starts reading as steps.
 */
export function shutterStep(open: number, curve: [number, number, number, number] = linearCurve, at = .5) {
  const from = clamp(at - open / 2, 0, 1), to = clamp(at + open / 2, 0, 1);
  return Math.abs(ease(to, curve) - ease(from, curve));
}

/**
 * Sub-frame count for baked motion blur, sized from how far the picture travels in one frame so a
 * fast whip gets the samples it needs and a slow zoom does not pay for them. Capped because the
 * render queue is serial; whatever gap is left is closed by a matching blur inside the branch.
 * Export leaves the curve linear because `xfade` ramps its own progress; the preview passes the
 * real curve and the moment being drawn.
 */
export function motionSamples(shutterAngle: number, travelPixels = 0, duration = 1, fps = 24, curve = linearCurve, at = .5) {
  if (shutterAngle <= 0) return 1;
  const open = Math.min(1, shutterAngle / 360 / Math.max(1 / 240, duration * fps));
  const smear = Math.abs(travelPixels) * shutterStep(open, curve, at);
  if (smear < 1.5) return 1;
  return clamp(Math.ceil(smear / 1.2), 2, 32);
}

/** Residual spacing between export sub-frames, in pixels; blurred away inside the window branch. */
export function motionGap(shutterAngle: number, travelPixels = 0, duration = 1, fps = 24, curve = linearCurve, at = .5) {
  const samples = motionSamples(shutterAngle, travelPixels, duration, fps, curve, at);
  if (samples < 2) return 0;
  const open = Math.min(1, shutterAngle / 360 / Math.max(1 / 240, duration * fps));
  return Math.abs(travelPixels) * shutterStep(open, curve, at) / (samples - 1);
}

/** Mirror-pad to twice the canvas so zoom-out, spin and shake have surrounding pixels to reveal. */
const mirrorPad = (width: number, height: number) => {
  const x = Math.round(width / 2), y = Math.round(height / 2);
  return [`pad=${width * 2}:${height * 2}:${x}:${y}:color=black`,
    `fillborders=left=${x}:right=${width * 2 - x - width}:top=${y}:bottom=${height * 2 - y - height}:mode=mirror`];
};

const scaleSpan = (context: TransitionPlanContext) => (clamp(Number(context.params.amount ?? 60), 5, 100) / 100).toFixed(4);

/**
 * zoompan drives its own output frame counter, so window-relative progress comes from `on`.
 * The padded frame is twice the canvas, meaning z=2 reproduces the original 1:1 framing and
 * z=1 shows the full mirrored surround — one filter covers both zoom directions.
 */
function zoomSide(z: (progress: string) => string, context: TransitionPlanContext): string[] {
  const rate = context.fps * context.samples;
  const progress = `(min(1,max(0,(on/${rate})/${context.duration})))`;
  return [...mirrorPad(context.width, context.height),
    `zoompan=z='${z(progress)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${context.width}x${context.height}:fps=${rate}`];
}

export const transitionDefinitions: Record<string, TransitionDefinition> = {
  'Cross dissolve': {
    kind: 'Dissolves', description: 'Fade one shot directly into the next.', parameters: [],
    draw: fadeDraw, ffmpeg: { xfade: 'fade' },
  },
  'Dip to black': {
    kind: 'Dissolves', description: 'Fade down to black and back up into the next shot.', parameters: [],
    draw: dipDraw(() => '#000000'), ffmpeg: { xfade: 'fadeblack' },
  },
  'Dip to white': {
    kind: 'Dissolves', description: 'Flash through white — the classic impact cut.', parameters: [],
    defaultDuration: .4, draw: dipDraw(() => '#ffffff'), ffmpeg: { xfade: 'fadewhite' },
  },
  'Dip to colour': {
    kind: 'Dissolves', description: 'Dip through any colour you choose.',
    parameters: [{ key: 'colour', label: 'Colour', initial: '#ffd9a0' }],
    draw: dipDraw(params => String(params.colour ?? '#ffd9a0')),
    ffmpeg: {
      xfade: 'fade',
      after: context => {
        const colour = /^#[0-9a-f]{6}$/i.test(String(context.params.colour ?? '')) ? String(context.params.colour).replace('#', '0x') : '0xffd9a0';
        const half = (context.duration / 2).toFixed(4);
        return [`color=c=${colour}:s=${context.width}x${context.height}:r=${context.fps * context.samples}:d=${context.duration.toFixed(4)},format=yuva444p10le,fade=t=in:st=0:d=${half}:alpha=1,fade=t=out:st=${half}:d=${half}:alpha=1[dip${context.tag}]`,
          `[IN][dip${context.tag}]overlay=format=yuv444p10:alpha=straight:eof_action=pass:repeatlast=0[OUT]`];
      },
    },
  },
  'Additive dissolve': {
    kind: 'Dissolves', description: 'Both shots hold full brightness through the middle — a hot, blooming blend.', parameters: [],
    draw: ({ target, outgoing, incoming, progress, width, height }) => {
      target.globalAlpha = 1; target.fillStyle = '#000'; target.fillRect(0, 0, width, height);
      target.globalCompositeOperation = 'lighter';
      if (outgoing) { target.globalAlpha = 1 - progress; target.drawImage(outgoing, 0, 0, width, height); }
      if (incoming) { target.globalAlpha = progress; target.drawImage(incoming, 0, 0, width, height); }
      target.globalCompositeOperation = 'source-over'; target.globalAlpha = 1;
    },
    // RGB planes keep addition correct; the same sum on YUV would swing hue through the midpoint.
    ffmpeg: { xfade: 'fadefast', side: () => ['format=gbrp'] },
  },
  'Grain dissolve': {
    kind: 'Dissolves', description: 'Dissolve through a grain pattern rather than a flat mix.', parameters: [],
    draw: ({ target, outgoing, incoming, progress, width, height }) => {
      target.globalAlpha = 1;
      if (outgoing) target.drawImage(outgoing, 0, 0, width, height);
      if (!incoming) return;
      // A coarse hashed threshold reads like the export's noise dissolve without a per-pixel pass.
      const cell = Math.max(5, Math.round(width / 110));
      target.save(); target.beginPath();
      for (let x = 0; x < width; x += cell) for (let y = 0; y < height; y += cell) {
        const hash = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663)) >>> 0;
        if (hash / 4294967296 < progress) target.rect(x, y, cell, cell);
      }
      target.clip(); target.drawImage(incoming, 0, 0, width, height); target.restore();
    },
    ffmpeg: { xfade: 'dissolve' },
  },

  'Blur dissolve': {
    kind: 'Optical', description: 'Smear both shots sideways through the cut.', parameters: [intensity],
    draw: ({ target, outgoing, incoming, progress, params, width, height }) => {
      const smear = Math.sin(progress * Math.PI) * Number(params.intensity ?? 60) / 100 * width * .06;
      const steps = smear < 1 ? 1 : 7;
      target.globalAlpha = 1; target.fillStyle = '#000'; target.fillRect(0, 0, width, height);
      for (let i = 0; i < steps; i++) {
        const offset = steps === 1 ? 0 : (i / (steps - 1) - .5) * smear * 2;
        target.globalAlpha = (1 - progress) / steps;
        if (outgoing) target.drawImage(outgoing, offset, 0, width, height);
        target.globalAlpha = progress / steps;
        if (incoming) target.drawImage(incoming, offset, 0, width, height);
      }
      target.globalAlpha = 1;
    },
    ffmpeg: { xfade: 'hblur' },
  },
  'Glow bleed': {
    kind: 'Optical', description: 'Highlights bloom and bleed across the cut.',
    parameters: [intensity, { key: 'threshold', label: 'Threshold', initial: 62, min: 0, max: 100, suffix: '%' }],
    draw: context => {
      fadeDraw(context);
      bloomPass(context.target, context.width, context.height, Number(context.params.threshold ?? 62), Number(context.params.intensity ?? 60) / 100 * Math.sin(context.progress * Math.PI));
    },
    ffmpeg: { xfade: 'fade', after: context => bloomFilters(context, .75) },
  },
  'Camera flash': {
    kind: 'Optical', description: 'Blow out the highlights, flash white, then settle into the next shot.',
    parameters: [intensity], defaultDuration: .35, defaultCurve: [.2, .9, .4, 1],
    draw: context => {
      dipDraw(() => '#ffffff')(context);
      bloomPass(context.target, context.width, context.height, 45, Number(context.params.intensity ?? 60) / 100 * Math.sin(context.progress * Math.PI) ** .6);
    },
    ffmpeg: { xfade: 'fadewhite', after: context => bloomFilters({ ...context, params: { ...context.params, threshold: 45 } }, 1) },
  },

  'Push left': { kind: 'Motion', description: 'The next shot pushes this one off to the left.', parameters: [shutter], motion: true, defaultCurve: [.4, 0, .2, 1], travel: travelAcross, draw: motionBlur((t, c) => slideFrame(t, c, 'Left', false), travelAcross), ffmpeg: { xfade: 'slideleft' } },
  'Push right': { kind: 'Motion', description: 'The next shot pushes this one off to the right.', parameters: [shutter], motion: true, defaultCurve: [.4, 0, .2, 1], travel: travelAcross, draw: motionBlur((t, c) => slideFrame(t, c, 'Right', false), travelAcross), ffmpeg: { xfade: 'slideright' } },
  'Push up': { kind: 'Motion', description: 'The next shot pushes this one off the top.', parameters: [shutter], motion: true, defaultCurve: [.4, 0, .2, 1], travel: travelDown, draw: motionBlur((t, c) => slideFrame(t, c, 'Up', false), travelDown), ffmpeg: { xfade: 'slideup' } },
  'Push down': { kind: 'Motion', description: 'The next shot pushes this one off the bottom.', parameters: [shutter], motion: true, defaultCurve: [.4, 0, .2, 1], travel: travelDown, draw: motionBlur((t, c) => slideFrame(t, c, 'Down', false), travelDown), ffmpeg: { xfade: 'slidedown' } },
  'Slide over': {
    kind: 'Motion', description: 'The next shot slides in over the top; this one stays put.',
    parameters: [directionParam, shutter], motion: true, defaultCurve: [.4, 0, .2, 1],
    travel: travelAxis, draw: motionBlur((t, c) => slideFrame(t, c, String(c.params.direction ?? 'Left'), true), travelAxis),
    ffmpeg: { xfade: params => ({ Left: 'coverleft', Right: 'coverright', Up: 'coverup', Down: 'coverdown' })[String(params.direction ?? 'Left')] ?? 'coverleft' },
  },
  'Whip pan': {
    kind: 'Motion', description: 'A hard camera whip, smeared into a single streak.',
    parameters: [directionParam, { ...shutter, initial: 320 }], motion: true, defaultDuration: .35, defaultCurve: [.7, 0, .3, 1],
    travel: travelAxis, draw: motionBlur((t, c) => slideFrame(t, c, String(c.params.direction ?? 'Left'), false), travelAxis),
    ffmpeg: { xfade: params => ({ Left: 'slideleft', Right: 'slideright', Up: 'slideup', Down: 'slidedown' })[String(params.direction ?? 'Left')] ?? 'slideleft' },
  },
  'Zoom in': {
    kind: 'Motion', description: 'Punch into the frame and out of the next one.',
    parameters: [{ key: 'amount', label: 'Amount', initial: 60, min: 5, max: 100, suffix: '%' }, shutter], motion: true, defaultCurve: [.5, 0, .2, 1],
    travel: travelZoom, draw: motionBlur((t, c) => zoomFrame(t, c, 1), travelZoom),
    ffmpeg: {
      // Padded frame is 2x, so z=2 is the original framing; both sides travel toward the viewer.
      side: (role, context) => zoomSide(p => role === 'out' ? `2+${scaleSpan(context)}*2*${p}` : `2-${scaleSpan(context)}*2*(1-${p})`, context),
      xfade: 'fade',
    },
  },
  'Zoom out': {
    kind: 'Motion', description: 'Pull back out of the frame, revealing a mirrored surround.',
    parameters: [{ key: 'amount', label: 'Amount', initial: 60, min: 5, max: 100, suffix: '%' }, shutter], motion: true, defaultCurve: [.5, 0, .2, 1],
    travel: travelZoom, draw: motionBlur((t, c) => zoomFrame(t, c, -1), travelZoom),
    ffmpeg: {
      side: (role, context) => zoomSide(p => role === 'out' ? `2-${scaleSpan(context)}*${p}` : `${(2 - Number(scaleSpan(context))).toFixed(4)}+${scaleSpan(context)}*${p}`, context),
      xfade: 'fade',
    },
  },
  'Whip zoom': {
    kind: 'Motion', description: 'A violent punch-in with a long shutter streak.',
    parameters: [{ key: 'amount', label: 'Amount', initial: 85, min: 5, max: 100, suffix: '%' }, { ...shutter, initial: 340 }], motion: true,
    defaultDuration: .3, defaultCurve: [.8, 0, .2, 1],
    travel: travelZoom, draw: motionBlur((t, c) => zoomFrame(t, c, 1), travelZoom),
    ffmpeg: {
      side: (role, context) => zoomSide(p => role === 'out' ? `2+${scaleSpan(context)}*3*${p}` : `2-${scaleSpan(context)}*3*(1-${p})`, context),
      xfade: 'fade',
    },
  },
  Spin: {
    kind: 'Motion', description: 'Whirl between the two shots.',
    parameters: [{ key: 'turns', label: 'Rotation', initial: 35, min: 5, max: 180, suffix: '°' }, shutter], motion: true, defaultCurve: [.5, 0, .2, 1],
    travel: travelSpin, draw: motionBlur((t, c) => spinFrame(t, c), travelSpin),
    ffmpeg: {
      side: (role, context) => {
        const turns = clamp(Number(context.params.turns ?? 35), 5, 180) * Math.PI / 180;
        const progress = `(min(1,max(0,t/${context.duration.toFixed(4)})))`;
        const angle = role === 'out' ? `${turns.toFixed(5)}*${progress}` : `${turns.toFixed(5)}*(${progress}-1)`;
        return [...mirrorPad(context.width, context.height), `rotate=a='${angle}':ow=iw:oh=ih:c=black`,
          `crop=${context.width}:${context.height}:${Math.round(context.width / 2)}:${Math.round(context.height / 2)}`];
      },
      xfade: 'fade',
    },
  },
  'Impact shake': {
    kind: 'Motion', description: 'A handheld jolt at the cut.',
    parameters: [{ key: 'amount', label: 'Amount', initial: 40, min: 0, max: 100, suffix: '%' }, { ...shutter, initial: 240 }], motion: true, defaultDuration: .3,
    travel: travelShake, draw: motionBlur((t, c) => shakeFrame(t, c), travelShake),
    ffmpeg: {
      side: (role, context) => {
        const amount = (clamp(Number(context.params.amount ?? 40), 0, 100) / 100 * context.width * .04).toFixed(2);
        const progress = `(min(1,max(0,t/${context.duration.toFixed(4)})))`;
        const decay = role === 'out' ? progress : `(1-${progress})`;
        const x = `${Math.round(context.width / 2)}+${amount}*${decay}*sin(t*74)`;
        const y = `${Math.round(context.height / 2)}+${amount}*${decay}*sin(t*53+1.7)`;
        return [...mirrorPad(context.width, context.height), `crop=${context.width}:${context.height}:x='${x}':y='${y}'`];
      },
      xfade: 'fade',
    },
  },

  'Linear wipe': {
    kind: 'Wipes', description: 'A straight edge sweeps the next shot across.', parameters: [directionParam, softness],
    draw: context => wipeDraw(context, 'linear'),
    ffmpeg: { xfade: params => ({ Left: 'wipeleft', Right: 'wiperight', Up: 'wipeup', Down: 'wipedown' })[String(params.direction ?? 'Left')] ?? 'wipeleft' },
  },
  Iris: {
    kind: 'Wipes', description: 'A circle opens or closes between the shots.',
    parameters: [{ key: 'mode', label: 'Mode', initial: 'Open', choices: ['Open', 'Close'] }, softness],
    draw: context => wipeDraw(context, 'iris'),
    ffmpeg: { xfade: params => String(params.mode ?? 'Open') === 'Close' ? 'circleclose' : 'circleopen' },
  },
  'Barn door': {
    kind: 'Wipes', description: 'The frame splits open down the middle.',
    parameters: [{ key: 'axis', label: 'Axis', initial: 'Vertical', choices: ['Vertical', 'Horizontal'] }, softness],
    draw: context => wipeDraw(context, 'barn'),
    ffmpeg: { xfade: params => String(params.axis ?? 'Vertical') === 'Horizontal' ? 'horzopen' : 'vertopen' },
  },

  'RGB split': {
    kind: 'Stylized', description: 'Tear the colour channels apart through the cut.', parameters: [intensity],
    draw: context => {
      fadeDraw(context);
      const { target, width, height, params, progress } = context;
      const shift = Number(params.intensity ?? 60) / 100 * width * .02 * Math.sin(progress * Math.PI);
      if (shift < .5) return;
      const copy = cloneCanvas(target.canvas);
      if (!copy) return;
      target.save();
      target.globalCompositeOperation = 'lighter';
      target.globalAlpha = .4;
      target.drawImage(copy, -shift, 0, width, height);
      target.drawImage(copy, shift, 0, width, height);
      target.restore();
      target.globalCompositeOperation = 'source-over';
      target.globalAlpha = 1;
    },
    ffmpeg: {
      xfade: 'fade',
      after: context => {
        const shift = Math.round(clamp(Number(context.params.intensity ?? 60), 0, 100) / 100 * context.width * .02);
        if (shift < 1) return [];
        return [`[IN]split=2[rgba${context.tag}][rgbb${context.tag}]`,
          `[rgbb${context.tag}]rgbashift=rh=${shift}:bh=${-shift}[rgbs${context.tag}]`,
          `[rgba${context.tag}][rgbs${context.tag}]blend=all_mode=average[OUT]`];
      },
    },
  },
  'Luma wipe': {
    kind: 'Stylized', description: 'The next shot burns through wherever the two differ most.', parameters: [softness],
    draw: context => {
      // Approximate the export's distance wipe with a spreading radial threshold.
      const { target, outgoing, incoming, progress, params, width, height } = context;
      target.globalAlpha = 1;
      if (outgoing) target.drawImage(outgoing, 0, 0, width, height);
      if (!incoming) return;
      const feather = Math.max(.02, Number(params.softness ?? 20) / 100 * .4);
      const gradient = target.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.hypot(width, height) / 2);
      gradient.addColorStop(clamp(progress * (1 + feather) - feather, 0, 1), '#fff');
      gradient.addColorStop(clamp(progress * (1 + feather), 0, 1), 'rgba(255,255,255,0)');
      maskedDraw(target, incoming, gradient, width, height);
    },
    ffmpeg: { xfade: 'distance' },
  },

  'Light leak': {
    kind: 'Overlays', description: 'A real film burn or light leak, screen-blended over the cut, with its own sound.',
    overlay: true, defaultDuration: 1,
    parameters: [
      { key: 'leak', label: 'Leak', initial: '' },
      { key: 'leakIn', label: 'Source start', initial: 0, min: 0, max: 30, step: .01, suffix: 's' },
      { key: 'leakOut', label: 'Source end', initial: 0, min: 0, max: 30, step: .01, suffix: 's' },
      { key: 'leakZoom', label: 'Overlay zoom', initial: 100, min: 100, max: 300, suffix: '%' },
      { key: 'blend', label: 'Blend', initial: 'Screen', choices: ['Screen', 'Add', 'Overlay'] },
      { key: 'leakGain', label: 'Sound', initial: -6, min: -60, max: 12, step: .5, suffix: 'dB' },
      { key: 'leakOpacity', label: 'Opacity', initial: 100, min: 0, max: 100, suffix: '%' },
      { key: 'blendPoint', label: 'Peak position', initial: 50, min: 0, max: 100, suffix: '%' },
    ],
    draw: ({ target, outgoing, incoming, overlay, raw, params, width, height }) => {
      const source = raw + 1e-9 < Number(params.__cutPoint ?? clamp(Number(params.blendPoint ?? 50), 0, 100) / 100) ? outgoing : incoming;
      target.globalAlpha = 1;
      target.fillStyle = '#000';
      target.fillRect(0, 0, width, height);
      if (source) target.drawImage(source, 0, 0, width, height);
      if (!overlay) return;
      target.globalCompositeOperation = ({ Screen: 'screen', Add: 'lighter', Overlay: 'overlay' } as Record<string, GlobalCompositeOperation>)[String(params.blend ?? 'Screen')] ?? 'screen';
      target.globalAlpha = clamp(Number(params.leakOpacity ?? 100), 0, 100) / 100;
      const image = overlay as HTMLVideoElement & HTMLImageElement;
      const sourceWidth = image.videoWidth || image.naturalWidth || image.width || width;
      const sourceHeight = image.videoHeight || image.naturalHeight || image.height || height;
      const scale = Math.max(width / sourceWidth, height / sourceHeight) * clamp(Number(params.leakZoom ?? 100), 100, 300) / 100;
      target.drawImage(overlay, (width - sourceWidth * scale) / 2, (height - sourceHeight * scale) / 2, sourceWidth * scale, sourceHeight * scale);
      target.globalCompositeOperation = 'source-over';
      target.globalAlpha = 1;
    },
    // The leak layer is a separate FFmpeg input, so the exporter owns that half; see media.ts.
    ffmpeg: { xfade: 'fade' },
  },
};

/** Source seconds selected for one overlay instance; an unset end uses the whole file. */
export function leakRange(params: TransitionParams, duration: number) {
  const limit = Math.max(.001, duration);
  const start = clamp(Number(params.leakIn ?? 0), 0, limit - .001);
  const end = clamp(Number(params.leakOut) > 0 ? Number(params.leakOut) : limit, start + .001, limit);
  return { start, end, duration: end - start };
}

/** Trim source frames at the existing playback rate, keeping the source peak on the cut. */
export function trimLeak(record: Pick<TransitionRecord, 'params' | 'duration'>, sourceDuration: number, patch: TransitionParams) {
  const before = leakRange(record.params, sourceDuration);
  const after = leakRange({ ...record.params, ...patch }, sourceDuration);
  const peak = before.start + before.duration * Number(record.params.blendPoint ?? 50) / 100;
  return { duration: record.duration * after.duration / before.duration,
    params: { ...record.params, ...patch, leakIn: after.start, leakOut: after.end,
      blendPoint: patch.blendPoint ?? clamp((peak - after.start) / after.duration * 100, 0, 100) } };
}

export type TransitionPreset = Pick<TransitionRecord, 'name' | 'duration' | 'align' | 'curve' | 'params'> & { id: string };
export const transitionPresetId = (name: string, params: TransitionParams) =>
  transitionDefinitions[name]?.overlay ? `overlay:${String(params.leak ?? '')}` : `transition:${name}`;

export const transitionNames = Object.keys(transitionDefinitions);
export const defaultTransition = 'Cross dissolve';

function cloneCanvas(source: HTMLCanvasElement | OffscreenCanvas): CanvasImageSource | null {
  try {
    const copy = typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(source.width, source.height)
      : Object.assign(document.createElement('canvas'), { width: source.width, height: source.height });
    const context = (copy as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!context) return null;
    context.drawImage(source as CanvasImageSource, 0, 0);
    return copy as unknown as CanvasImageSource;
  } catch { return null; }
}

/** Both shots placed for one instant of a translation. Averaging these is the smear. */
function slideFrame(target: CanvasRenderingContext2D, context: TransitionDrawContext, axis: string, cover: boolean) {
  const horizontal = axis === 'Left' || axis === 'Right';
  const sign = axis === 'Left' || axis === 'Up' ? -1 : 1;
  const distance = horizontal ? context.width : context.height;
  const { outgoing, incoming, progress, width, height } = context;
  target.globalAlpha = 1;
  if (outgoing) {
    const shift = cover ? 0 : sign * distance * progress;
    target.drawImage(outgoing, horizontal ? shift : 0, horizontal ? 0 : shift, width, height);
  }
  if (incoming) {
    const shift = sign * distance * (progress - 1);
    target.drawImage(incoming, horizontal ? shift : 0, horizontal ? 0 : shift, width, height);
  }
}

/** Scale about the centre, mirror-tiled once the frame shrinks past its own edges. */
function placeScaled(target: CanvasRenderingContext2D, image: CanvasImageSource, factor: number, alpha: number, width: number, height: number) {
  if (alpha <= .001) return;
  target.save();
  target.globalAlpha = alpha;
  target.translate(width / 2, height / 2);
  target.scale(factor, factor);
  target.translate(-width / 2, -height / 2);
  if (factor < 1.001) drawMirrored(target, image, width, height);
  else target.drawImage(image, 0, 0, width, height);
  target.restore();
}

function zoomFrame(target: CanvasRenderingContext2D, context: TransitionDrawContext, sign: number) {
  const span = clamp(Number(context.params.amount ?? 60), 5, 100) / 100;
  const { outgoing, incoming, progress, width, height } = context;
  const outFactor = sign > 0 ? 1 + span * progress : Math.max(.05, 1 - span * progress);
  const inFactor = sign > 0 ? 1 + span * (1 - progress) : Math.max(.05, 1 - span * (1 - progress));
  target.globalAlpha = 1;
  target.fillStyle = '#000';
  target.fillRect(0, 0, width, height);
  if (outgoing) placeScaled(target, outgoing, outFactor, 1 - progress, width, height);
  if (incoming) placeScaled(target, incoming, inFactor, progress, width, height);
  target.globalAlpha = 1;
}

function spinFrame(target: CanvasRenderingContext2D, context: TransitionDrawContext) {
  const turns = clamp(Number(context.params.turns ?? 35), 5, 180) * Math.PI / 180;
  const { outgoing, incoming, progress, width, height } = context;
  const place = (image: CanvasImageSource, angle: number, alpha: number) => {
    if (alpha <= .001) return;
    target.save();
    target.globalAlpha = alpha;
    target.translate(width / 2, height / 2);
    target.rotate(angle);
    target.translate(-width / 2, -height / 2);
    drawMirrored(target, image, width, height);
    target.restore();
  };
  target.globalAlpha = 1;
  target.fillStyle = '#000';
  target.fillRect(0, 0, width, height);
  if (outgoing) place(outgoing, turns * progress, 1 - progress);
  if (incoming) place(incoming, turns * (progress - 1), progress);
  target.globalAlpha = 1;
}

function shakeFrame(target: CanvasRenderingContext2D, context: TransitionDrawContext) {
  const amount = clamp(Number(context.params.amount ?? 40), 0, 100) / 100 * context.width * .04;
  const { outgoing, incoming, progress, width, height } = context;
  const place = (image: CanvasImageSource, decay: number, alpha: number) => {
    if (alpha <= .001) return;
    target.save();
    target.globalAlpha = alpha;
    target.translate(-amount * decay * Math.sin(progress * 34), -amount * decay * Math.sin(progress * 25 + 1.7));
    drawMirrored(target, image, width, height);
    target.restore();
  };
  target.globalAlpha = 1;
  target.fillStyle = '#000';
  target.fillRect(0, 0, width, height);
  if (outgoing) place(outgoing, progress, 1 - progress);
  if (incoming) place(incoming, 1 - progress, progress);
  target.globalAlpha = 1;
}

function wipeDraw(context: TransitionDrawContext, shape: 'linear' | 'iris' | 'barn') {
  const { target, outgoing, incoming, progress, params, width, height } = context;
  target.globalAlpha = 1;
  if (outgoing) target.drawImage(outgoing, 0, 0, width, height);
  if (!incoming) return;
  const soft = clamp(Number(params.softness ?? 20), 0, 100) / 100;
  if (shape === 'iris') {
    const close = String(params.mode ?? 'Open') === 'Close';
    const reach = Math.hypot(width, height) / 2;
    const radius = Math.max(.01, reach * (close ? 1 - progress : progress));
    const gradient = target.createRadialGradient(width / 2, height / 2, Math.max(0, radius * (1 - soft * .6)), width / 2, height / 2, radius);
    gradient.addColorStop(0, close ? 'rgba(255,255,255,0)' : '#fff');
    gradient.addColorStop(1, close ? '#fff' : 'rgba(255,255,255,0)');
    maskedDraw(target, incoming, gradient, width, height);
    return;
  }
  if (shape === 'barn') {
    const horizontal = String(params.axis ?? 'Vertical') === 'Horizontal';
    const half = (horizontal ? height : width) / 2 * progress;
    target.save(); target.beginPath();
    if (horizontal) { target.rect(0, 0, width, half); target.rect(0, height - half, width, half); }
    else { target.rect(0, 0, half, height); target.rect(width - half, 0, half, height); }
    target.clip(); target.drawImage(incoming, 0, 0, width, height); target.restore();
    return;
  }
  const axis = String(params.direction ?? 'Left');
  const horizontal = axis === 'Left' || axis === 'Right';
  const { boundary, tip } = wipeEdge(axis, progress, horizontal ? width : height, soft);
  const gradient = horizontal ? target.createLinearGradient(boundary, 0, tip, 0) : target.createLinearGradient(0, boundary, 0, tip);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(1, '#fff');
  maskedDraw(target, incoming, gradient, width, height);
}

/**
 * Where a linear wipe's edge sits, and which way it softens. `boundary` is fully transparent and
 * `tip` fully opaque, so the revealed side is always the one `tip` points toward: a Left wipe
 * brings the next shot in from the right edge and sweeps it left. Getting this inverted masked the
 * incoming shot down to a sliver for most of the window, which read as the wipe not working.
 */
export function wipeEdge(axis: string, progress: number, span: number, softness: number) {
  const feather = Math.max(1, span * clamp(softness, 0, 1) * .3);
  const fromFarEdge = axis === 'Left' || axis === 'Up';
  const boundary = fromFarEdge ? span * (1 - progress) : span * progress;
  return { boundary, tip: fromFarEdge ? boundary + feather : boundary - feather, feather };
}

/** Draw `image` through an alpha mask while keeping whatever the target already held underneath. */
function maskedDraw(target: CanvasRenderingContext2D, image: CanvasImageSource, mask: CanvasGradient, width: number, height: number) {
  const base = cloneCanvas(target.canvas);
  target.save();
  target.globalAlpha = 1;
  target.globalCompositeOperation = 'copy';
  target.drawImage(image, 0, 0, width, height);
  target.globalCompositeOperation = 'destination-in';
  target.fillStyle = mask;
  target.fillRect(0, 0, width, height);
  target.globalCompositeOperation = 'destination-over';
  if (base) target.drawImage(base, 0, 0, width, height);
  target.restore();
  target.globalCompositeOperation = 'source-over';
  target.globalAlpha = 1;
}

/** Threshold the highlights, blur them, screen them back — the preview half of Bloom. */
export function bloomPass(target: CanvasRenderingContext2D, width: number, height: number, threshold: number, amount: number) {
  if (!(amount > .001)) return;
  const copy = cloneCanvas(target.canvas);
  if (!copy) return;
  const cut = clamp(threshold, 0, 100) / 100;
  target.save();
  target.globalCompositeOperation = 'lighter';
  target.globalAlpha = clamp(amount, 0, 1) * .85;
  target.filter = `blur(${Math.max(1, width * .012).toFixed(2)}px) brightness(${(1 + cut).toFixed(2)}) contrast(${(1 + cut * 2).toFixed(2)})`;
  target.drawImage(copy, 0, 0, width, height);
  target.filter = 'none';
  target.restore();
  target.globalCompositeOperation = 'source-over';
  target.globalAlpha = 1;
}

/**
 * Export half of the bloom. `[IN]` and `[OUT]` are substituted by the exporter with the real
 * stream labels, so a definition never has to know its position in the graph.
 */
export function bloomFilters(context: TransitionPlanContext, peak: number): string[] {
  const amount = clamp(Number(context.params.intensity ?? 60) / 100 * peak, 0, 1);
  if (amount <= .01) return [];
  const cut = clamp(Number(context.params.threshold ?? 62), 0, 100) / 100;
  const sigma = Math.max(2, context.width * .008).toFixed(2);
  const floor = Math.round(cut * 255), gain = (1 / Math.max(.05, 1 - cut)).toFixed(3);
  const lift = `clip((val-${floor})*${gain},0,255)`;
  // Screen only means "brighten" on RGB. Blended on the window's YUV frames it also lifted both chroma
  // planes, which is why a white flash exported pink. Alpha (c3) keeps the picture's own coverage.
  const glow = [0, 1, 2].map(c => `c${c}_mode=screen:c${c}_opacity=${amount.toFixed(3)}`).join(':');
  // Float, not 16-bit: FFmpeg 8.1's 16-bit screen overflows once both sides are dark (20% over black came out
  // 80%, 45% came out 5%), which flashed a black frame into the middle of a camera flash at 23.976.
  return [`[IN]format=gbrapf32le,split=2[bla${context.tag}][blb${context.tag}]`,
    `[blb${context.tag}]format=gbrp,lutrgb=r='${lift}':g='${lift}':b='${lift}',gblur=sigma=${sigma},format=gbrapf32le[blc${context.tag}]`,
    `[bla${context.tag}][blc${context.tag}]blend=${glow}:c3_opacity=0[OUT]`];
}

/* ---------------------------------------------------------------------------------------- */
/* Window geometry                                                                            */
/* ---------------------------------------------------------------------------------------- */

export type TransitionAlign = 'center' | 'in' | 'out';
export const transitionAligns: TransitionAlign[] = ['center', 'in', 'out'];

export interface TransitionRecord {
  /** The clip the transition is stored on, and which edge of it the transition sits at. */
  clipId: string;
  side: TransitionSide;
  name: string;
  duration: number;
  /** Duration the stored value asked for, before handle availability clamped it. */
  requested: number;
  align: TransitionAlign;
  curve: [number, number, number, number];
  params: TransitionParams;
  /** Absolute timeline time of the cut this transition straddles. */
  cut: number;
  start: number;
  end: number;
  /** The clip leaving frame and the clip arriving; either is absent at the head or the tail. */
  outgoingId?: string;
  incomingId?: string;
  audioClipId?: string;
}

const field = (side: TransitionSide, key: string) => side === 'in' ? `transition${key}` : `transitionOut${key}`;
export const transitionProperty = field;
/** Property keys a transition writes, so an edit can clear all of them in one pass. */
export const transitionFields = (side: TransitionSide) => ['Duration', 'Align', 'Curve', 'Params', 'AudioId'].map(key => field(side, key));

export function transitionName(clip: Clip, side: TransitionSide): string {
  const value = side === 'in' ? clip.transition : clip.properties?.transitionOut;
  return typeof value === 'string' && transitionDefinitions[value] ? value : '';
}

export function transitionParams(clip: Clip, side: TransitionSide): TransitionParams {
  const definition = transitionDefinitions[transitionName(clip, side)];
  const params: TransitionParams = {};
  for (const parameter of definition?.parameters ?? []) params[parameter.key] = parameter.initial;
  const raw = clip.properties?.[field(side, 'Params')];
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) if (['number', 'string'].includes(typeof value)) params[key] = value as number | string;
      }
    } catch { /* A malformed payload falls back to the definition's defaults. */ }
  }
  return params;
}

export function transitionCurve(clip: Clip, side: TransitionSide): [number, number, number, number] {
  const parts = String(clip.properties?.[field(side, 'Curve')] ?? '').split(',').map(Number);
  if (parts.length === 4 && parts.every(n => Number.isFinite(n) && Math.abs(n) <= 10)) return parts as [number, number, number, number];
  return transitionDefinitions[transitionName(clip, side)]?.defaultCurve ?? linearCurve;
}

export function transitionAlign(clip: Clip, side: TransitionSide): TransitionAlign {
  const value = String(clip.properties?.[field(side, 'Align')] ?? 'center');
  return transitionAligns.includes(value as TransitionAlign) ? value as TransitionAlign : 'center';
}

export function transitionDuration(clip: Clip, side: TransitionSide): number {
  const value = Number(clip.properties?.[field(side, 'Duration')] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : transitionDefinitions[transitionName(clip, side)]?.defaultDuration ?? 1;
}

/**
 * Share of the window sitting *before* the cut. That half is carried by the incoming clip reaching
 * back into its head handle; the half after the cut is carried by the outgoing clip reaching
 * forward into its tail. `clipSpan` extends exactly those two edges.
 */
export const alignShare = (align: TransitionAlign) => align === 'in' ? 0 : align === 'out' ? 1 : .5;

/** An overlay's measured peak is anchored to the edit; alignment only applies to other transitions. */
export const transitionShare = (name: string, params: TransitionParams, align: TransitionAlign) =>
  transitionDefinitions[name]?.overlay ? clamp(Number(params.blendPoint ?? 50), 0, 100) / 100 : alignShare(align);

/**
 * Handles available on a clip edge, in timeline seconds. Generated clips (titles, shapes,
 * compositions) and stills are unbounded because they are drawn rather than decoded.
 */
export function availableHandle(clip: Clip, edge: TransitionSide, asset?: MediaAsset): number {
  if (isTitle(clip) || isShape(clip) || clip.mediaId === 'frameline-composition') return 3600;
  if (!asset || asset.kind === 'image' || clip.properties?.freeze) return 3600;
  const speed = Math.max(.01, Number(clip.properties?.speed ?? 100) / 100);
  const media = Number(asset.duration) || 0;
  const head = clip.sourceIn, tail = Math.max(0, media - clip.sourceIn - clip.duration * speed);
  // Reversed clips read backwards, so the handle the head borrows lives at the far end.
  return Math.max(0, (clip.properties?.reverse ? (edge === 'in' ? tail : head) : (edge === 'in' ? head : tail)) / speed);
}

/** The clip immediately before or after this one on the same track, if the two actually meet. */
export function neighbourAt(clips: Clip[], clip: Clip, side: TransitionSide): Clip | undefined {
  const cut = side === 'in' ? clip.start : clip.start + clip.duration;
  // Source durations can be rounded to milliseconds while edit points land on frame boundaries.
  return clips.find(other => other.id !== clip.id && other.trackId === clip.trackId && other.timelineId === clip.timelineId && !other.disabled
    && Math.abs((side === 'in' ? other.start + other.duration : other.start) - cut) < .001);
}

/**
 * Longest window this cut can support given both sides' handles. A transition never moves a clip,
 * so it can only borrow frames the trims already left unused — and which side pays depends on where
 * the window sits. The part *after* the cut is carried by the outgoing clip's tail, the part
 * *before* it by the incoming clip's head, which is exactly the pair of edges `clipSpan` extends.
 */
export function maximumDuration(clips: Clip[], clip: Clip, side: TransitionSide, align: TransitionAlign, media: MediaAsset[], hold = false): number {
  const share = transitionShare(transitionName(clip, side), transitionParams(clip, side), align);
  const outgoing = side === 'in' ? neighbourAt(clips, clip, 'in') : clip;
  const incoming = side === 'in' ? clip : undefined;
  const limit = (target: Clip | undefined, edge: TransitionSide) => target
    ? Math.min(availableHandle(target, edge, media.find(asset => asset.id === target.mediaId)), target.duration)
    : Infinity;
  // Two clips dropped in whole have no handles anywhere, and refusing the dissolve outright is the
  // wrong answer — the outgoing clip can carry its half by holding its last frame, which is what
  // `sourceTime` already does for a span that reads past the media. `hold` offers that window, but
  // only where there is not a frame of real handle to read: a dissolve trimmed short still beats a
  // longer one made of frozen frames, so a cut with handles is left exactly as it was.
  const tail = hold && outgoing && limit(outgoing, 'out') < 1 / 48 ? outgoing.duration : limit(outgoing, 'out');
  const head = limit(incoming, 'in');
  return Math.max(0, Math.min(30, share < 1 ? tail / (1 - share) : Infinity, share > 0 ? head / share : Infinity));
}

/**
 * The alignment this cut can actually carry, preferring centred. Handles are routinely one-sided —
 * a clip trimmed to the last frame of its media has no tail to lend — and refusing the cut outright
 * while the other clip has a second to spare is a worse edit than sliding the window off the cut.
 */
export function bestAlign(clips: Clip[], clip: Clip, side: TransitionSide, media: MediaAsset[], wanted = 0): TransitionAlign {
  const room = (align: TransitionAlign, hold = false) => maximumDuration(clips, clip, side, align, media, hold);
  // Straddling the cut is the edit everyone expects, so it only gives way when it cannot carry a
  // usable window at all: a centred transition trimmed a little short still beats one shoved off
  // the cut entirely. Below that, take whichever side actually has frames.
  if (room('center') >= Math.max(1 / 48, wanted / 2) - 1e-6) return 'center';
  const handled = transitionAligns.reduce((best, align) => room(align) > room(best) ? align : best, 'center' as TransitionAlign);
  if (room(handled) >= 1 / 48) return handled;
  // Neither clip has a spare frame. A held window only works after the cut — reaching *back* would
  // slip the incoming clip's content rather than freeze it — so let the fallback pick that side.
  return transitionAligns.reduce((best, align) => room(align, true) > room(best, true) ? align : best, 'center' as TransitionAlign);
}

/** Read every transition on a timeline, resolved to absolute window bounds. */
export function timelineTransitions(clips: Clip[], timelineId: string, media: MediaAsset[] = []): TransitionRecord[] {
  const active = clips.filter(clip => clip.timelineId === timelineId && !clip.disabled);
  const records: TransitionRecord[] = [];
  for (const clip of active) for (const side of ['in', 'out'] as TransitionSide[]) {
    const name = transitionName(clip, side);
    if (!name) continue;
    // A shared cut always belongs to the incoming clip, so a tail transition needs an empty tail.
    const neighbour = neighbourAt(active, clip, side);
    if (side === 'out' && neighbour) continue;
    const align = transitionAlign(clip, side);
    const share = transitionShare(transitionName(clip, side), transitionParams(clip, side), align);
    const cut = side === 'in' ? clip.start : clip.start + clip.duration;
    const requested = transitionDuration(clip, side);
    const maximum = maximumDuration(active, clip, side, align, media, true);
    // Handles can disappear after the fact when a clip is trimmed, so the window shrinks to what
    // the outgoing clip can still cover rather than reading past the media; the requested length is
    // kept for when the handles return.
    const duration = Math.max(1 / 240, Math.min(requested, maximum));
    // A window cannot reach before the start of the timeline, so a cut at zero keeps only the
    // half that exists rather than asking the renderer for a negative range.
    const start = Math.max(0, cut - duration * share), end = cut + duration * (1 - share);
    if (end - start < 1e-6) continue;
    records.push({
      clipId: clip.id, side, name, duration: end - start, requested, align,
      curve: transitionCurve(clip, side), params: transitionParams(clip, side),
      cut, start, end,
      outgoingId: side === 'in' ? neighbour?.id : clip.id,
      incomingId: side === 'in' ? clip.id : undefined,
      // Only count an expanded sound that still exists: deleting the audio clip must bring the
      // embedded copy back, in the menu, the preview and the export alike.
      audioClipId: active.some(item => item.id === clip.properties?.[field(side, 'AudioId')]) ? String(clip.properties[field(side, 'AudioId')]) : undefined,
    });
  }
  return records.sort((a, b) => a.start - b.start);
}

/** Eased 0..1 position within a transition window; outside the window this returns null. */
export function transitionProgress(record: Pick<TransitionRecord, 'start' | 'end' | 'curve'>, time: number): { raw: number; eased: number } | null {
  if (time < record.start - 1e-9 || time >= record.end) return null;
  const raw = clamp((time - record.start) / Math.max(1e-6, record.end - record.start), 0, 1);
  return { raw, eased: clamp(ease(raw, record.curve), 0, 1) };
}

/** Where a dropped transition would land: the nearest eligible cut on the track under the pointer. */
export function nearestCut(clips: Clip[], trackId: string, timelineId: string, time: number, tolerance: number) {
  const lane = clips.filter(clip => clip.trackId === trackId && clip.timelineId === timelineId && !clip.disabled).sort((a, b) => a.start - b.start);
  let best: { clip: Clip; side: TransitionSide; cut: number; distance: number } | null = null;
  for (const clip of lane) for (const side of ['in', 'out'] as TransitionSide[]) {
    // A shared cut is addressed through the incoming clip, so only an empty tail offers 'out'.
    if (side === 'out' && neighbourAt(lane, clip, 'out')) continue;
    const cut = side === 'in' ? clip.start : clip.start + clip.duration;
    const distance = Math.abs(cut - time);
    if (distance > tolerance) continue;
    if (!best || distance < best.distance) best = { clip, side, cut, distance };
  }
  return best;
}

/* ---------------------------------------------------------------------------------------- */
/* Validation — runs in the browser before a save and again on the server                */
/* ---------------------------------------------------------------------------------------- */

export function validateTransitionParams(value: unknown): asserts value is TransitionParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid transition parameters.');
  const params = value as TransitionParams;
  for (const key of ['leakIn', 'leakOut']) if (params[key] !== undefined && (typeof params[key] !== 'number' || !Number.isFinite(params[key]) || params[key] < 0 || params[key] > 30)) throw new Error('Invalid overlay source trim.');
  if (Number(params.leakOut) > 0 && Number(params.leakOut) <= Number(params.leakIn ?? 0)) throw new Error('Overlay source end must follow source start.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new Error('Too many transition parameters.');
  for (const [key, item] of entries) {
    if (key.length > 60 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid transition parameter name.');
    if (typeof item === 'number') { if (!Number.isFinite(item) || Math.abs(item) > 1e6) throw new Error('Invalid transition parameter value.'); }
    else if (typeof item === 'string') { if (item.length > 200) throw new Error('Invalid transition parameter value.'); }
    else throw new Error('Invalid transition parameter value.');
  }
}

/** Reject unknown names, impossible durations and malformed parameters at the trust boundary. */
export function validateTransition(clip: Pick<Clip, 'transition' | 'properties'>): void {
  for (const side of ['in', 'out'] as TransitionSide[]) {
    const raw = side === 'in' ? clip.transition : clip.properties?.transitionOut;
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' || !transitionDefinitions[raw]) throw new Error(`Unknown transition: ${String(raw).slice(0, 60)}`);
    const properties = clip.properties ?? {};
    const duration = properties[field(side, 'Duration')];
    if (duration !== undefined && (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 30)) throw new Error('Invalid transition duration.');
    const align = properties[field(side, 'Align')];
    if (align !== undefined && !transitionAligns.includes(String(align) as TransitionAlign)) throw new Error('Invalid transition alignment.');
    const curve = properties[field(side, 'Curve')];
    if (curve !== undefined && curve !== '') {
      const parts = String(curve).split(',').map(Number);
      if (parts.length !== 4 || !parts.every(n => Number.isFinite(n) && Math.abs(n) <= 10) || parts[0] < 0 || parts[0] > 1 || parts[2] < 0 || parts[2] > 1) throw new Error('Invalid transition curve.');
    }
    const params = properties[field(side, 'Params')];
    if (params !== undefined && params !== '') {
      if (typeof params !== 'string' || params.length > 4000) throw new Error('Invalid transition parameters.');
      let parsed: unknown;
      try { parsed = JSON.parse(params); } catch { throw new Error('Invalid transition parameters.'); }
      validateTransitionParams(parsed);
    }
  }
}

/**
 * A leak expanded onto an audio track is an ordinary clip pointing at the shared pack rather than
 * at project media, so it uses a reserved media id the way titles and shapes do. Everything
 * downstream — trimming, fades, the mixer, undo — then treats it as any other audio clip.
 */
export const LEAK_MEDIA_PREFIX = 'frameline-leak:';
export const leakMediaId = (leak: string) => `${LEAK_MEDIA_PREFIX}${leak}`;
export const isLeakMedia = (mediaId: string) => mediaId.startsWith(LEAK_MEDIA_PREFIX);
export function leakIdOf(mediaId: string) {
  if (!isLeakMedia(mediaId)) return '';
  const id = mediaId.slice(LEAK_MEDIA_PREFIX.length);
  return /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/.test(id) ? id : '';
}

/**
 * The audio track a leak's sound expands into: the nearest unlocked audio track with nothing
 * already occupying that span. Dropping it on top of existing audio would silently overlap two
 * clips, so when every track is busy the caller creates a new one instead.
 */
export function leakAudioTrack(tracks: Track[], videoTrack: Track, clips: Clip[], start: number, end: number) {
  return tracks
    .filter(track => track.timelineId === videoTrack.timelineId && track.kind === 'audio' && !track.locked)
    .sort((a, b) => Math.abs(a.number - videoTrack.number) - Math.abs(b.number - videoTrack.number))
    .find(track => !clips.some(clip => clip.trackId === track.id && !clip.disabled && clip.start < end - 1e-6 && clip.start + clip.duration > start + 1e-6));
}
