import type { Clip } from '../src/state/models.ts';
import { isTitle, getText } from '../src/services/text.ts';

/**
 * Keyframed position, zoom, rotation and anchor rendered inside the one streaming export pass, instead of one
 * whole-timeline render per frame. The Girls Soccer export spent 10 of its 78 minutes rendering 553 frames that
 * way for nothing but Ken Burns zooms and adjustment-layer shakes.
 *
 * The layer is drawn by FFmpeg's `perspective` filter, whose corner expressions are evaluated every frame from the
 * sampled keyframes. That filter works in 8-bit RGB, which is why only exports that end in 8-bit (H.264, H.265)
 * stream; ProRes keeps the per-frame path and its 16-bit transform.
 */
export const TRANSFORM_KEYS = ['properties.x', 'properties.y', 'properties.zoom', 'properties.rotation', 'properties.anchorX', 'properties.anchorY'];

/** Whether every keyframe on the clip is one this pass can stream (gain is sound and never needed a frame render). */
export function streamsTransform(clip: Clip) {
  const keyed = Object.entries(clip.keyframes ?? {}).filter(([, keys]) => keys?.length).map(([path]) => path);
  if (!keyed.some(path => TRANSFORM_KEYS.includes(path))) return false;
  if (keyed.some(path => path !== 'properties.gain' && !TRANSFORM_KEYS.includes(path))) return false;
  // Motion blur samples the move inside each frame; typing reveals text frame by frame. Both stay per frame.
  return clip.properties.motionBlur !== true && !(isTitle(clip) && getText(clip).typingEnabled);
}

export type Placement = { zoom: number; rotation: number; shiftX: number; shiftY: number };

/**
 * Where a layer lands on the output: its scale, its rotation (radians, clockwise on screen, as FFmpeg's `rotate`) and
 * how far its centre sits from the frame centre, in output pixels. Rotation and zoom turn about the anchor.
 * `x`, `y` and the anchor are project pixels; `anchorShift` is an extra output-pixel anchor (a shape's own centre).
 */
export function placement(values: { x: number; y: number; zoom: number; rotation: number; anchorX: number; anchorY: number }, width: number, height: number, projectWidth: number, projectHeight: number, anchorShift = { x: 0, y: 0 }): Placement {
  const zoom = values.zoom / 100, rotation = values.rotation * Math.PI / 180;
  const x = values.x * width / projectWidth, y = values.y * height / projectHeight;
  const ax = values.anchorX * width / projectWidth + anchorShift.x, ay = values.anchorY * height / projectHeight + anchorShift.y;
  return { zoom, rotation,
    shiftX: x + ax - zoom * (ax * Math.cos(rotation) - ay * Math.sin(rotation)),
    shiftY: y + ay - zoom * (ax * Math.sin(rotation) + ay * Math.cos(rotation)) };
}

/**
 * One coordinate's per-frame values as an FFmpeg expression of the frame number `frame` (0 for the first frame):
 * straight runs become one linear term each, so a linear keyframe costs a handful of terms and an eased one a few
 * per second. Every frame stays within `tolerance` pixels of its sampled value. Past the last frame the last value holds.
 */
export function piecewise(values: number[], tolerance = .02, frame = 'in') {
  const terms: string[] = [], number = (value: number) => (Math.abs(value) < 5e-5 ? 0 : value).toFixed(4);
  for (let start = 0; start < values.length;) {
    let end = start;
    while (end + 1 < values.length) {
      const next = end + 1, slope = (values[next] - values[start]) / (next - start);
      if (values.slice(start, next + 1).some((value, i) => Math.abs(values[start] + slope * i - value) > tolerance)) break;
      end = next;
    }
    const slope = end > start ? (values[end] - values[start]) / (end - start) : 0, last = end === values.length - 1;
    const line = slope ? `(${number(values[start])}+(${last ? `min(${frame},${end})` : frame}-${start})*${slope.toFixed(6)})` : number(values[start]);
    terms.push(start === 0 && last ? line : `${last ? `gte(${frame},${start})` : `between(${frame},${start},${end})`}*${line}`);
    start = end + 1;
  }
  return terms.join('+');
}

/**
 * The filters that draw a layer, already fitted to a canvas of the project's shape, onto a transparent output-sized
 * frame at each frame's placement. The work happens at `supersample` times the output size (the clip's largest
 * zoom, up to 2) and is shrunk after, so a zoomed-in layer keeps its detail and a zoomed-out one is filtered rather
 * than aliased. A transparent margin keeps `perspective`'s edge clamp from smearing the picture's border outward.
 */
export function transformFilters(frames: Placement[], width: number, height: number, supersample: number) {
  const layerWidth = Math.round(width * supersample / 2) * 2, layerHeight = Math.round(height * supersample / 2) * 2, margin = 4;
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const;
  const coordinates = corners.flatMap(([sx, sy]) => {
    const xs: number[] = [], ys: number[] = [];
    for (const frame of frames) {
      const halfWidth = frame.zoom * (layerWidth / 2 + margin), halfHeight = frame.zoom * (layerHeight / 2 + margin);
      const centreX = margin + layerWidth / 2 + frame.shiftX * layerWidth / width, centreY = margin + layerHeight / 2 + frame.shiftY * layerHeight / height;
      const dx = sx * halfWidth, dy = sy * halfHeight, cos = Math.cos(frame.rotation), sin = Math.sin(frame.rotation);
      xs.push(centreX + dx * cos - dy * sin); ys.push(centreY + dx * sin + dy * cos);
    }
    // perspective counts `in` from 1 for the first frame.
    return [piecewise(xs, .02, '(in-1)'), piecewise(ys, .02, '(in-1)')];
  });
  const names = ['x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'];
  return [`scale=${layerWidth}:${layerHeight}`, 'format=gbrap', `pad=${layerWidth + 2 * margin}:${layerHeight + 2 * margin}:${margin}:${margin}:color=black@0`,
    `perspective=${names.map((name, i) => `${name}='${coordinates[i]}'`).join(':')}:sense=destination:eval=frame:interpolation=cubic`,
    `crop=${layerWidth}:${layerHeight}:${margin}:${margin}`, `scale=${width}:${height}:flags=area`];
}
