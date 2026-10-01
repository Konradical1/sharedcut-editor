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

/** Width of a moving playhead's canvas strip and the room its line keeps from the strip's edges, in CSS pixels. */
const STRIP_WIDTH = 256, STRIP_MARGIN = 16;
/**
 * A moving playhead line, drawn into a canvas strip instead of moving an element: any per-frame change to an element in the
 * timeline re-layerized the whole page (~13 ms a frame on a fast laptop, ~75 ms at 4x CPU slowdown), will-change or not.
 * The strip is as tall as what the scroller shows, so each draw redraws and composites little; horizontal scrolling carries
 * it along with the content, and it jumps ahead (one layout) only when the line nears its edge. Off screen it is left blank
 * and still: zoomed in, the line leaves the view within a second, and redrawing the unseen strip every picture stalled the
 * GPU process ~100 ms every few seconds. `draw(at)` takes the line's left edge in the track area's coordinates (where the
 * paused element sits); `paint` draws it at x with the track area's top at y, in CSS pixels
 * (the context is scaled to device pixels by `scale`).
 */
export function playheadStrip(surface: HTMLCanvasElement, scroll: HTMLElement, area: HTMLElement, paint: (context: CanvasRenderingContext2D, x: number, y: number, scale: number) => void) {
  const context = surface.getContext('2d');
  let left = NaN, top = 0, scale = 1, shown = NaN, at = NaN;
  const draw = (next: number) => {
    at = next;
    if (!context) return;
    const view = scroll.scrollLeft - area.offsetLeft;
    if (at + STRIP_MARGIN < view || at - STRIP_MARGIN > view + scroll.clientWidth) {
      if (shown === shown) { context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, surface.width, surface.height); shown = NaN; }
      return;
    }
    if (!(at - STRIP_MARGIN >= left && at + STRIP_MARGIN <= left + STRIP_WIDTH)) { left = Math.floor(at - STRIP_MARGIN); surface.style.left = `${left}px`; shown = NaN; }
    const x = at - left;
    if (x === shown) return;
    shown = x;
    context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, surface.width, surface.height);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    paint(context, x, -top, scale);
  };
  const place = () => {
    top = scroll.scrollTop - area.offsetTop;
    scale = (scroll.offsetWidth ? scroll.getBoundingClientRect().width / scroll.offsetWidth : 1) * devicePixelRatio;
    Object.assign(surface.style, { top: `${top}px`, width: `${STRIP_WIDTH}px`, height: `${scroll.clientHeight}px` });
    // Resizing a canvas reallocates it; scrolling alone only moves it.
    const width = Math.max(1, Math.round(STRIP_WIDTH * scale)), height = Math.max(1, Math.round(scroll.clientHeight * scale));
    if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; }
    shown = NaN; if (at === at) draw(at);
  };
  place();
  const resize = new ResizeObserver(place);
  resize.observe(scroll);
  let scrolledTop = scroll.scrollTop;
  const scrolled = () => { if (scroll.scrollTop !== scrolledTop) { scrolledTop = scroll.scrollTop; place(); } };
  scroll.addEventListener('scroll', scrolled, { passive: true });
  return { draw, dispose: () => { resize.disconnect(); scroll.removeEventListener('scroll', scrolled); } };
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
    let shown = '', x = 0, y = 0;
    const css = getComputedStyle(element);
    const draw = (text: string) => {
      if (text === shown) return;
      shown = text;
      if (backdrop) { context.fillStyle = backdrop; context.fillRect(0, 0, surface.width, surface.height); }
      else context.clearRect(0, 0, surface.width, surface.height);
      context.fillStyle = css.color; context.fillText(text, x, y);
      surface.textContent = text;
    };
    // Everything below is in device pixels, the units layout itself snaps text and replaced elements to.
    const place = () => {
      const rect = element.getBoundingClientRect(), dpr = devicePixelRatio;
      const scale = rect.width / (parseFloat(css.width) || rect.width) * dpr, px = (value: string) => (parseFloat(value) || 0) * scale;
      // Paint snaps the box (the canvas with it) to whole pixels; text keeps its fractional x but its baseline lands on a
      // whole pixel at its layout offset from the snapped top. At 125% or 150% the panel itself can sit mid-pixel, so the
      // canvas is sized to exactly its pixels and shown unfiltered (styles.css): stretched or filtered, the digits went soft.
      const left = Math.round(rect.left * dpr), top = Math.round(rect.top * dpr);
      surface.width = Math.max(1, Math.round(rect.right * dpr) - left); surface.height = Math.max(1, Math.round(rect.bottom * dpr) - top);
      Object.assign(surface.style, { width: `${surface.width / scale}px`, height: `${surface.height / scale}px` });
      context.font = `${css.fontStyle} ${css.fontWeight} ${px(css.fontSize)}px ${css.fontFamily}`;
      context.letterSpacing = `${px(css.letterSpacing)}px`; context.textBaseline = 'alphabetic';
      // Layout's own pen position: an empty inline-block sits on the held text's baseline, right where its first glyph starts.
      const origin = element.querySelector('.live-timecode-origin')?.getBoundingClientRect() ?? rect;
      x = origin.left * dpr - left; y = Math.round((origin.bottom - rect.top) * dpr);
      const last = shown; shown = ''; draw(last || timecode(useEditorStore.getState().playhead, fps));
    };
    place();
    // A breakpoint can resize the box mid-playback (the window crossing 1250 px changes the font).
    let size = `${element.offsetWidth}x${element.offsetHeight}`;
    const resize = new ResizeObserver(() => { const now = `${element.offsetWidth}x${element.offsetHeight}`; if (now !== size) { size = now; place(); } });
    resize.observe(element);
    const unsubscribe = onPicture(playhead => draw(timecode(playhead, fps)));
    return () => { unsubscribe(); resize.disconnect(); };
  }, [playing, fps]);
  return <span ref={box} className={`${className} live-timecode`} style={style}>{playing ? <><span className="live-timecode-held" data-text={held.current} aria-hidden="true"><i className="live-timecode-origin"/></span><canvas ref={canvas} className="live-timecode-canvas"/></> : label}</span>;
}
