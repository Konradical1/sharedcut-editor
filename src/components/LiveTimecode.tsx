import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { useEditorStore } from '../state/store';
import { timecode } from '../services/timecode';

/**
 * Calls back with the playhead of each picture the viewer presents, in the same task, so anything drawn from it reaches the
 * screen in the same frame as the picture. Following the store instead redrew a frame early (its clock ticks after the
 * engine's) and at the display's rate, doubling the frames the GPU had to present; a blocked present stalled playback.
 */
export function onPicture(listener: (playhead: number) => void) {
  const presented = (event: Event) => listener((event as CustomEvent<{ playhead: number }>).detail.playhead);
  window.addEventListener('frameline:playback-health', presented);
  return () => window.removeEventListener('frameline:playback-health', presented);
}

/** The first background behind an element if it is a plain opaque colour; undefined for any transparency or image. */
export function opaqueBackdrop(element: Element): string | undefined {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const css = getComputedStyle(node);
    if (css.backgroundImage !== 'none') return undefined;
    const color = css.backgroundColor;
    if (/^rgb\(/.test(color)) return color;
    if (!/^rgba\(.*,\s*0\)$/.test(color)) return undefined;
  }
  return undefined;
}

/**
 * A timecode that follows the playhead. Paused, it is ordinary text. Playing, the digits are drawn into a canvas over
 * the box that text occupied: a text change is a layout, and every layout re-ran hover hit testing and compositing for
 * the whole page (the timeline is thousands of elements), about 20 ms a frame on a fast laptop. A hidden copy of the
 * paused text holds the box, and the canvas's fallback content keeps textContent and screen readers current; neither
 * is laid out again while playing.
 */
export function LiveTimecode({ fps, className, style }: { fps?: number; className: string; style?: CSSProperties }) {
  const playing = useEditorStore(s => s.playing);
  const label = useEditorStore(s => s.playing ? '' : timecode(s.playhead, fps));
  const box = useRef<HTMLSpanElement>(null), canvas = useRef<HTMLCanvasElement>(null), held = useRef(label);
  // Mounted mid-playback (a workspace switch), any timecode holds the same box: every label is one fixed-width shape.
  if (!playing || !held.current) held.current = label || timecode(useEditorStore.getState().playhead, fps);
  useLayoutEffect(() => {
    const element = box.current, surface = canvas.current;
    if (!playing || !element || !surface) return;
    // On the panel's own opaque colour the canvas gets the same subpixel (LCD) text the DOM does; transparent, only greyscale.
    const backdrop = opaqueBackdrop(element), context = surface.getContext('2d', { alpha: !backdrop });
    if (!context) return;
    // Everything below is in device pixels, the units layout itself snaps text and replaced elements to.
    const css = getComputedStyle(element), rect = element.getBoundingClientRect(), dpr = devicePixelRatio;
    const scale = rect.width / (parseFloat(css.width) || rect.width) * dpr, px = (value: string) => (parseFloat(value) || 0) * scale;
    // Paint snaps the box (the canvas with it) to whole pixels; text keeps its fractional x but its baseline lands on a
    // whole pixel at its layout offset from the snapped top.
    const left = Math.round(rect.left * dpr), top = Math.round(rect.top * dpr);
    surface.width = Math.max(1, Math.round(rect.right * dpr) - left); surface.height = Math.max(1, Math.round(rect.bottom * dpr) - top);
    context.font = `${css.fontStyle} ${css.fontWeight} ${px(css.fontSize)}px ${css.fontFamily}`;
    context.letterSpacing = `${px(css.letterSpacing)}px`; context.textBaseline = 'alphabetic';
    // Layout's own pen position: an empty inline-block sits on the held text's baseline, right where its first glyph starts.
    const origin = element.querySelector('.live-timecode-origin')?.getBoundingClientRect() ?? rect;
    const x = origin.left * dpr - left, y = Math.round((origin.bottom - rect.top) * dpr);
    let shown = '';
    const draw = (text: string) => {
      if (text === shown) return;
      shown = text;
      if (backdrop) { context.fillStyle = backdrop; context.fillRect(0, 0, surface.width, surface.height); }
      else context.clearRect(0, 0, surface.width, surface.height);
      context.fillStyle = css.color; context.fillText(text, x, y);
      surface.textContent = text;
    };
    draw(timecode(useEditorStore.getState().playhead, fps));
    return onPicture(playhead => draw(timecode(playhead, fps)));
  }, [playing, fps]);
  return <span ref={box} className={`${className} live-timecode`} style={style}>{playing ? <><span className="live-timecode-held" data-text={held.current} aria-hidden="true"><i className="live-timecode-origin"/></span><canvas ref={canvas} className="live-timecode-canvas"/></> : label}</span>;
}
