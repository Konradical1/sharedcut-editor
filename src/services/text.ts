import { captionHighlightLead, captionPreset, captionTiming, snapZoom, validateCaption, wordPopDuration, type CaptionData } from './captions.ts';
import type { Clip } from '../state/models.ts';

export interface TextStyle { fontFamily: string; fontSize: number; fontWeight: number; italic: boolean; underline: boolean; letterSpacing: number; color: string }
export interface TextRun { text: string; style: TextStyle }
export interface TextEffects { outlineColor: string; outlineWidth: number; shadowColor: string; shadowOpacity: number; shadowBlur: number; shadowX: number; shadowY: number; blur: number; typingEnabled: boolean; typingSpeed: number; typingRandomness: number; typingCursor: boolean; typingProgress: number; typingSeed: number }
export const defaultTextEffects: TextEffects = { outlineColor: '#000000', outlineWidth: 0, shadowColor: '#000000', shadowOpacity: 0, shadowBlur: 12, shadowX: 0, shadowY: 6, blur: 0, typingEnabled: false, typingSpeed: 18, typingRandomness: 25, typingCursor: false, typingProgress: 100, typingSeed: 17 };
export interface TextDocument extends Partial<TextEffects> { caption?: CaptionData; runs: TextRun[]; x: number; y: number; width: number; height: number; align: 'left' | 'center' | 'right'; lineHeight: number; opacity: number }
export type TextRange = { clipId: string; start: number; end: number };
export const defaultTextStyle: TextStyle = { fontFamily: 'Helvetica Neue', fontSize: 96, fontWeight: 600, italic: false, underline: false, letterSpacing: 0, color: '#ffffff' };
export const isTitle = (clip: Clip) => clip.mediaId === 'frameline-title';
export const textContent = (doc: TextDocument) => doc.runs.map(run => run.text).join('');
export const getText = (clip: Clip): TextDocument & TextEffects => {const doc={ ...defaultTextEffects, ...JSON.parse(String(clip.properties.textDocument)) };if(doc.caption)doc.caption={...doc.caption,duration:clip.sourceIn+clip.duration};return doc;};
export function validateText(value: unknown): asserts value is TextDocument {
  const d = value as TextDocument;
  if(d?.caption)validateCaption(d.caption);
  if (!d || !Array.isArray(d.runs) || !d.runs.length || d.runs.length > 1000 || !['left', 'center', 'right'].includes(d.align)) throw new Error('Invalid text document.');
  for (const [key, min, max] of [['x', -4, 4], ['y', -4, 4], ['width', .01, 1], ['height', .01, 1], ['lineHeight', .5, 4], ['opacity', 0, 100]] as const) if (!Number.isFinite(d[key]) || d[key] < min || d[key] > max) throw new Error(`Invalid text ${key}.`);
  for (const [key, min, max] of [['outlineWidth', 0, 100], ['shadowOpacity', 0, 100], ['shadowBlur', 0, 200], ['shadowX', -1000, 1000], ['shadowY', -1000, 1000], ['blur', 0, 100], ['typingSpeed', 1, 120], ['typingRandomness', 0, 100], ['typingProgress', 0, 100], ['typingSeed', 0, 2147483647]] as const) if (d[key] !== undefined && (!Number.isFinite(d[key]) || d[key]! < min || d[key]! > max)) throw new Error(`Invalid text ${key}.`);
  for (const key of ['outlineColor', 'shadowColor'] as const) if (d[key] !== undefined && !/^#[\da-f]{6}$/i.test(d[key]!)) throw new Error(`Invalid text ${key}.`);
  for (const key of ['typingEnabled', 'typingCursor'] as const) if (d[key] !== undefined && typeof d[key] !== 'boolean') throw new Error(`Invalid text ${key}.`);
  let length = 0;
  for (const run of d.runs) {
    if (!run || typeof run.text !== 'string' || !run.style) throw new Error('Invalid text run.');
    length += run.text.length;
    const s = run.style;
    if (typeof s.fontFamily !== 'string' || !s.fontFamily.trim() || s.fontFamily.length > 160 || /[\x00-\x1f"\\]/.test(s.fontFamily) || !/^#[\da-f]{6}$/i.test(s.color) || typeof s.italic !== 'boolean' || typeof s.underline !== 'boolean') throw new Error('Invalid font or text color.');
    for (const [key, min, max] of [['fontSize', 4, 600], ['fontWeight', 100, 900], ['letterSpacing', -10, 100]] as const) if (!Number.isFinite(s[key]) || s[key] < min || s[key] > max) throw new Error(`Invalid text ${key}.`);
  }
  if (length > 10000) throw new Error('Text boxes are limited to 10,000 characters.');
}
function compact(runs: TextRun[]): TextRun[] {
  const output: TextRun[] = [];
  for (const run of runs.filter(run => run.text)) {
    const previous = output.at(-1);
    if (previous && JSON.stringify(previous.style) === JSON.stringify(run.style)) previous.text += run.text;
    else output.push({ text: run.text, style: { ...run.style } });
  }
  return output.length ? output : [{ text: '', style: { ...runs[0]?.style ?? defaultTextStyle } }];
}
export function selectedRuns(doc: TextDocument, range?: { start: number; end: number }): TextRun[] {
  if (!range || range.start === range.end) return doc.runs;
  let offset = 0;
  return doc.runs.filter(run => { const start = offset; offset += run.text.length; return start < range.end && offset > range.start; });
}
export function styleText(doc: TextDocument, patch: Partial<TextStyle>, range?: { start: number; end: number }): TextDocument {
  const start = range && range.end > range.start ? range.start : 0, end = range && range.end > range.start ? range.end : textContent(doc).length;
  let offset = 0;
  const runs = doc.runs.flatMap(run => {
    const from = Math.max(0, start - offset), to = Math.min(run.text.length, end - offset); offset += run.text.length;
    if (to <= from && run.text) return [run];
    return [{ text: run.text.slice(0, from), style: run.style }, { text: run.text.slice(from, to), style: { ...run.style, ...patch } }, { text: run.text.slice(to), style: run.style }];
  });
  if (!textContent(doc)) return { ...doc, runs: [{ text: '', style: { ...doc.runs[0].style, ...patch } }] };
  return { ...doc, runs: compact(runs) };
}
// Preserve formatting outside the changed substring, including paste and native undo.
export function replaceText(doc: TextDocument, text: string): TextDocument {
  const old = textContent(doc); let start = 0, end = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) start++;
  while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) end++;
  const slice = (from: number, to: number) => { let offset = 0; return doc.runs.map(run => { const a = offset; offset += run.text.length; return { text: run.text.slice(Math.max(0, from - a), Math.max(0, Math.min(run.text.length, to - a))), style: run.style }; }).filter(run => run.text); };
  const style = selectedRuns(doc, { start: Math.max(0, start - 1), end: Math.max(1, start) })[0]?.style ?? doc.runs[0].style;
  return { ...doc, runs: compact([...slice(0, start), { text: text.slice(start, text.length - end), style }, ...slice(old.length - end, old.length)]) };
}
export function commonStyle(docs: { doc: TextDocument; range?: TextRange }[]): Partial<TextStyle> {
  const styles = docs.flatMap(({ doc, range }) => selectedRuns(doc, range).map(run => run.style));
  return Object.fromEntries(Object.entries(styles[0] ?? {}).filter(([key, value]) => styles.every(style => style[key as keyof TextStyle] === value)));
}
export const titlePresets = [
  { name: 'Cinematic', category: 'Opening', text: 'AFTER HOURS', family: 'Helvetica Neue', size: 112, weight: 300, spacing: 18, color: '#ffffff', align: 'center', y: .40 },
  { name: 'Editorial', category: 'Opening', text: 'A different\nperspective.', family: 'Baskerville', size: 140, weight: 400, spacing: -2, color: '#f5e6cf', align: 'left', y: .25 },
  { name: 'Bold statement', category: 'Opening', text: 'MAKE IT\nMATTER.', family: 'Arial', size: 156, weight: 900, spacing: -3, color: '#e9ff79', align: 'left', y: .23 },
  { name: 'Lower third', category: 'Lower thirds', text: 'ALEX MORGAN\nDirector & storyteller', family: 'Helvetica Neue', size: 58, weight: 500, spacing: 1, color: '#ffffff', align: 'left', y: .72 },
  { name: 'Location', category: 'Lower thirds', text: 'BROOKLYN, NEW YORK\n40.6782° N · 73.9442° W', family: 'Menlo', size: 42, weight: 400, spacing: 4, color: '#ffffff', align: 'left', y: .76 },
  { name: 'Chapter', category: 'Opening', text: '01 / THE BEGINNING', family: 'Avenir Next', size: 76, weight: 600, spacing: 7, color: '#ffffff', align: 'center', y: .43 },
  { name: 'Quiet luxury', category: 'Opening', text: 'The art of slowing down', family: 'Didot', size: 104, weight: 400, spacing: 1, color: '#f1dfc4', align: 'center', y: .40 },
  { name: 'Quote', category: 'Story', text: '“Stay curious.\nKeep creating.”', family: 'Georgia', size: 98, weight: 400, spacing: 0, color: '#ffffff', align: 'center', y: .30 },
  { name: 'Handwritten', category: 'Story', text: 'Wish you were here.', family: 'Snell Roundhand', size: 128, weight: 400, spacing: 0, color: '#ffd3be', align: 'center', y: .38 },
  { name: 'End credits', category: 'Credits', text: 'A FILM BY\nYOUR NAME', family: 'Avenir Next', size: 64, weight: 500, spacing: 9, color: '#ffffff', align: 'center', y: .36 },
  { name: 'Minimal caption', category: 'Story', text: 'Some moments stay with you.', family: 'Helvetica Neue', size: 48, weight: 400, spacing: 0, color: '#ffffff', align: 'center', y: .80 },
  { name: 'The end', category: 'Credits', text: 'Fin.', family: 'Baskerville', size: 176, weight: 400, spacing: 0, color: '#ffffff', align: 'center', y: .32 },
  { name: 'Clean dissolve', category: 'Simple', text: 'Less, but better.', family: 'Helvetica Neue', size: 96, weight: 400, spacing: -1, color: '#ffffff', align: 'center', y: .42 },
  { name: 'Typewriter', category: 'Simple', text: 'Every story starts here.', family: 'Menlo', size: 68, weight: 400, spacing: 0, color: '#f1eee6', align: 'left', y: .43 },
  { name: 'Widescreen', category: 'Cinematic', text: 'W I L D  H O R I Z O N S', family: 'Avenir Next', size: 86, weight: 500, spacing: 3, color: '#f5f0de', align: 'center', y: .42 },
  { name: 'Film slate', category: 'Cinematic', text: 'A STUDY IN LIGHT', family: 'Baskerville', size: 116, weight: 400, spacing: 3, color: '#ede6da', align: 'center', y: .38 },
  { name: 'Soft focus', category: 'Cinematic', text: 'Somewhere,\nsomething beautiful.', family: 'Didot', size: 116, weight: 400, spacing: -1, color: '#f2dfd8', align: 'center', y: .29 },
  { name: 'Outline impact', category: 'Bold', text: 'STAND\nOUT.', family: 'Arial', size: 180, weight: 900, spacing: -5, color: '#fff8eb', align: 'center', y: .23 },
  { name: 'Kinetic headline', category: 'Bold', text: 'THE NEXT\nBIG THING.', family: 'Helvetica Neue', size: 150, weight: 900, spacing: -3, color: '#ffffff', align: 'left', y: .28 },
  { name: 'Stacked labels', category: 'Bold', text: 'MAKE\nSOME\nNOISE.', family: 'Arial', size: 112, weight: 900, spacing: -1, color: '#ffffff', align: 'left', y: .25 },
  { name: 'Slanted tag', category: 'Bold', text: 'FRESH PERSPECTIVE', family: 'Avenir Next', size: 102, weight: 800, spacing: -1, color: '#ffffff', align: 'center', y: .42 },
  { name: 'Duotone', category: 'Colorful', text: 'GOOD\nENERGY.', family: 'Helvetica Neue', size: 146, weight: 800, spacing: -3, color: '#172e36', align: 'left', y: .29 },
  { name: 'Product launch', category: 'Colorful', text: 'Product\nLaunch', family: 'Avenir Next', size: 124, weight: 700, spacing: -1, color: '#ffffff', align: 'left', y: .32 },
  { name: 'Welcome note', category: 'Colorful', text: 'welcome', family: 'Snell Roundhand', size: 160, weight: 500, spacing: 0, color: '#634dff', align: 'center', y: .36 },
  { name: 'Color pop', category: 'Colorful', text: 'HELLO,\nTOMORROW.', family: 'Arial', size: 136, weight: 900, spacing: -3, color: '#21162d', align: 'left', y: .3 },
  { name: 'Frame it', category: 'Simple', text: 'A moment worth keeping', family: 'Georgia', size: 84, weight: 400, spacing: 0, color: '#ffffff', align: 'center', y: .43 },
  { name: 'Interview', category: 'Lower Thirds', text: 'JAMIE PARK\nCreative director', family: 'Helvetica Neue', size: 60, weight: 600, spacing: 1, color: '#ffffff', align: 'left', y: .73 },
  { name: 'Accent line', category: 'Lower Thirds', text: 'MORGAN LEE\nPhotographer', family: 'Avenir Next', size: 62, weight: 600, spacing: 1, color: '#ffffff', align: 'left', y: .73 },
  { name: 'Rounded badge', category: 'Lower Thirds', text: 'ON THE ROAD', family: 'Avenir Next', size: 48, weight: 700, spacing: 2, color: '#102e29', align: 'center', y: .78 },
  { name: 'Speaker card', category: 'Lower Thirds', text: 'SAM RIVERA\nIdeas that move us', family: 'Helvetica Neue', size: 62, weight: 700, spacing: 0, color: '#ffffff', align: 'left', y: .73 },
  { name: 'Breaking news', category: 'News', text: 'HEADLINE TEXT HERE', family: 'Arial', size: 70, weight: 900, spacing: -1, color: '#121820', align: 'left', y: .75 },
  { name: 'News desk', category: 'News', text: 'THE DAILY BRIEF', family: 'Helvetica Neue', size: 100, weight: 800, spacing: -1, color: '#ffffff', align: 'left', y: .36 },
  { name: 'Bulletin', category: 'News', text: 'A NEW PERSPECTIVE', family: 'Arial', size: 72, weight: 800, spacing: 0, color: '#ffffff', align: 'left', y: .73 },
  { name: 'Headline ribbon', category: 'News', text: 'THE STORY CONTINUES', family: 'Avenir Next', size: 80, weight: 800, spacing: 0, color: '#ffffff', align: 'center', y: .42 },
  { name: 'Rolling credits', category: 'Credits', text: 'MADE WITH CURIOSITY\n\nDirected by\nYOUR NAME\n\nPhotography\nYOUR NAME\n\nWith thanks to\nEVERYONE WHO BELIEVED', family: 'Avenir Next', size: 52, weight: 400, spacing: 3, color: '#e7e4dc', align: 'center', y: .16 },
  { name: 'End card', category: 'Credits', text: 'See you in\nthe next story.', family: 'Baskerville', size: 126, weight: 400, spacing: -1, color: '#f2e8d3', align: 'center', y: .29 },
] as const;
export function presetDocument(index = 0): TextDocument {
  const p = titlePresets[index] ?? titlePresets[0];
  const doc: TextDocument = { ...defaultTextEffects, runs: [{ text: p.text, style: { ...defaultTextStyle, fontFamily: p.family, fontSize: p.size, fontWeight: p.weight, letterSpacing: p.spacing, color: p.color } }], x: .08, y: p.y, width: .84, height: Math.min(.5, .96 - p.y), align: p.align, lineHeight: 1.2, opacity: 100 };
  if ([3, 4, 9].includes(index)) { const [a, b] = p.text.split('\n'); doc.runs = [{ text: a + '\n', style: doc.runs[0].style }, { text: b, style: { ...doc.runs[0].style, fontSize: p.size * .65, fontWeight: 400 } }]; }
  return doc;
}

type TextCanvas = Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'scale' | 'translate' | 'beginPath' | 'rect' | 'clip' | 'measureText' | 'fillText' | 'strokeText' | 'fillRect' | 'font' | 'textBaseline' | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'lineJoin' | 'globalAlpha' | 'filter' | 'shadowColor' | 'shadowBlur' | 'shadowOffsetX' | 'shadowOffsetY'>;
export const canvasFont = (s: TextStyle) => `${s.italic ? 'italic ' : ''}${s.fontWeight} ${s.fontSize}px "${s.fontFamily}"`;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (text: string) => Array.from(segmenter.segment(text), part => part.segment);
export function typingCost(index: number, randomness: number, seed: number) {
  let hash = Math.imul(index + 1, 374761393) ^ seed; hash = Math.imul(hash ^ hash >>> 13, 1274126177);
  const random = ((hash ^ hash >>> 16) >>> 0) / 4294967295;
  return 1 + (random * 2 - 1) * randomness / 100 * .85;
}
export function typingCount(doc: TextDocument, elapsed: number, budget?: number): number {
  const fx = { ...defaultTextEffects, ...doc }, length = graphemes(textContent(doc)).length;
  const limit = Math.floor(length * fx.typingProgress / 100 + 1e-8);
  if (!fx.typingEnabled || !Number.isFinite(elapsed)) return limit;
  let cost = 0, count = 0;
  const available = budget ?? Math.max(0, elapsed) * fx.typingSpeed;
  for (; count < limit; count++) {
    cost += typingCost(count, fx.typingRandomness, fx.typingSeed);
    if (cost > available + 1e-9) break;
  }
  return count;
}
/**
 * How a moving caption is exposed. `true` (exports, paused frames): seven samples across the shutter, each laid out and
 * drawn. `'live'` (playback): the same seven samples composited from one raster per word, so it costs one drawing instead
 * of seven. `false` (efficient playback): one sample at the frame's own time.
 */
export type CaptionShutter = boolean | 'live';
export function drawText(ctx: TextCanvas, doc: TextDocument, width: number, height: number, projectWidth = width, projectHeight = height, elapsed = Infinity, visibleCharacters?: number, shutter: CaptionShutter = true) {
  if(doc.caption){drawCaption(ctx as CanvasRenderingContext2D,doc,width,height,projectWidth,projectHeight,elapsed,shutter);return;}
  const fx = { ...defaultTextEffects, ...doc };
  const reveal = fx.typingEnabled && visibleCharacters !== undefined ? Math.min(visibleCharacters, typingCount({...doc,typingEnabled:false},elapsed)) : typingCount(doc, elapsed);
  ctx.save(); ctx.scale(width / projectWidth, height / projectHeight); ctx.translate(doc.x * projectWidth, doc.y * projectHeight);
  const boxWidth = doc.width * projectWidth, boxHeight = doc.height * projectHeight;
  const padding = Math.max(fx.outlineWidth, fx.blur * 3, fx.shadowOpacity ? fx.shadowBlur * 3 + Math.max(Math.abs(fx.shadowX), Math.abs(fx.shadowY)) : 0);
  ctx.beginPath(); ctx.rect(-padding, -padding, boxWidth + padding * 2, boxHeight + padding * 2); ctx.clip(); ctx.globalAlpha *= doc.opacity / 100; ctx.textBaseline = 'alphabetic';
  ctx.filter = fx.blur ? `blur(${fx.blur * width / projectWidth}px)` : 'none';
  ctx.strokeStyle = fx.outlineColor; ctx.lineWidth = fx.outlineWidth * 2; ctx.lineJoin = 'round';
  type Part = { text: string; style: TextStyle; width: number };
  let line: Part[] = [], lineWidth = 0, y = 0, index = 0, cursorX = 0, cursorY = 0, cursorSize = doc.runs[0].style.fontSize, cursorStyle = doc.runs[0].style;
  const shadow = () => { ctx.shadowColor = fx.shadowColor + Math.round(fx.shadowOpacity / 100 * 255).toString(16).padStart(2, '0'); ctx.shadowBlur = fx.shadowBlur * width / projectWidth; ctx.shadowOffsetX = fx.shadowX * width / projectWidth; ctx.shadowOffsetY = fx.shadowY * height / projectHeight; };
  const flush = () => {
    const size = Math.max(...line.map(part => part.style.fontSize), doc.runs[0].style.fontSize);
    let x = doc.align === 'center' ? (boxWidth - lineWidth) / 2 : doc.align === 'right' ? boxWidth - lineWidth : 0;
    if (index === 0) { cursorX = x; cursorY = y; }
    for (const part of line) {
      ctx.font = canvasFont(part.style); ctx.fillStyle = part.style.color;
      const chars = graphemes(part.text), visible = chars.slice(0, Math.max(0, reveal - index)).join('');
      const paint = (text: string, at: number) => { shadow(); if (fx.outlineWidth) { ctx.strokeText(text, at, y + size * .9); ctx.shadowColor = 'transparent'; } ctx.fillText(text, at, y + size * .9); };
      let visibleWidth = 0;
      if (!part.style.letterSpacing) { if (visible) paint(visible, x); visibleWidth = ctx.measureText(visible).width; }
      else for (const char of graphemes(visible)) { paint(char, x + visibleWidth); visibleWidth += ctx.measureText(char).width + part.style.letterSpacing; }
      if (part.style.underline && visible) ctx.fillRect(x, y + size * .98, visibleWidth, Math.max(1, part.style.fontSize / 24));
      if (index < reveal || index === 0) { cursorX = x + visibleWidth; cursorY = y; cursorSize = size; cursorStyle = part.style; }
      index += chars.length; x += part.width;
    }
    y += size * doc.lineHeight; line = []; lineWidth = 0;
  };
  for (const run of doc.runs) for (const token of run.text.split(/(\n|[^\S\n]+)/).filter(Boolean)) {
    if (token === '\n') { flush(); index++; if (index <= reveal) { cursorX = 0; cursorY = y; } continue; }
    ctx.font = canvasFont(run.style);
    const measure = (text: string) => run.style.letterSpacing ? graphemes(text).reduce((sum, c) => sum + ctx.measureText(c).width + run.style.letterSpacing, 0) : ctx.measureText(text).width;
    const measured = measure(token);
    if (lineWidth + measured > boxWidth && line.length && token.trim()) flush();
    ctx.font = canvasFont(run.style);
    if (measured > boxWidth) {
      for (const char of graphemes(token)) { const w = measure(char); if (lineWidth + w > boxWidth && line.length) flush(); ctx.font = canvasFont(run.style); line.push({ text: char, style: run.style, width: w }); lineWidth += w; }
    } else { line.push({ text: token, style: run.style, width: measured }); lineWidth += measured; }
    if (y > boxHeight) break;
  }
  if (line.length) flush();
  if (fx.typingEnabled && fx.typingCursor && Number.isFinite(elapsed) && Math.floor(Math.max(0, elapsed) * 2) % 2 === 0) {
    ctx.shadowColor = 'transparent'; ctx.fillStyle = cursorStyle.color; ctx.fillRect(cursorX + cursorSize * .07, cursorY + cursorSize * .12, Math.max(2, cursorSize * .045), cursorSize * .85);
  }
  ctx.restore();
}

/** Invert the clip transform before editing normalized text-box geometry. */
export function textLocalPoint(point: {x:number;y:number}, properties: Clip['properties'], width:number, height:number) {
  const x = width / 2 + Number(properties.anchorX ?? 0), y = height / 2 + Number(properties.anchorY ?? 0);
  const dx = point.x * width - x - Number(properties.x ?? 0), dy = point.y * height - y - Number(properties.y ?? 0);
  const rotation = -Number(properties.rotation ?? 0) * Math.PI / 180, zoom = Math.max(.01, Number(properties.zoom ?? 100) / 100);
  return { x: ((dx * Math.cos(rotation) - dy * Math.sin(rotation)) / zoom + x) / width, y: ((dx * Math.sin(rotation) + dy * Math.cos(rotation)) / zoom + y) / height };
}

/** Keep animation attached to its character spans when rich-text runs split or merge. */
export function remapTextRuns(base: TextDocument, current: TextDocument, next: TextDocument, channels: NonNullable<Clip['keyframes']>, newId: () => string) {
  if (!Object.keys(channels).some(path => path.startsWith('text.runs.')) || current.runs.length === next.runs.length && current.runs.every((run,i)=>run.text===next.runs[i].text)) return { next, current, base, keyframes: channels };
  const before = textContent(current), after = textContent(next);
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  const spans = (doc: TextDocument) => { let offset = 0; return doc.runs.map((run,index) => { const start = offset; offset += run.text.length; return { run,index,start,end:offset }; }); };
  const oldSpans = spans(current), newSpans = spans(next), boundaries = new Set([0,after.length,...newSpans.map(s=>s.end)]);
  for (const span of oldSpans) {
    if (span.end <= prefix) boundaries.add(span.end);
    else if (span.end >= before.length - suffix) boundaries.add(span.end + after.length - before.length);
  }
  const offsets = [...boundaries].filter(n=>n>=0&&n<=after.length).sort((a,b)=>a-b);
  if (offsets.length === 1) offsets.push(0);
  const keyframes: NonNullable<Clip['keyframes']> = Object.fromEntries(Object.entries(channels).filter(([path])=>!path.startsWith('text.runs.')));
  const nextRuns: TextRun[] = [], currentRuns: TextRun[] = [], baseRuns: TextRun[] = [];
  for (let i=0;i<offsets.length-1;i++) {
    const start=offsets[i],end=offsets[i+1],oldOffset=start<prefix?start:start>=after.length-suffix?start+before.length-after.length:Math.max(0,prefix-1);
    const source=oldSpans.find(s=>oldOffset>=s.start&&oldOffset<s.end)??oldSpans.at(-1)!,destination=newSpans.find(s=>start>=s.start&&start<s.end)??newSpans.at(-1)!;
    const relative=Math.max(0,oldOffset-source.start),partEnd=relative+end-start,whole=start===0&&end===after.length&&oldSpans.length===1;
    const slice=(value:string)=>whole?value:value.slice(relative,partEnd>=source.run.text.length?undefined:partEnd);
    nextRuns.push({text:after.slice(start,end),style:{...destination.run.style}});
    currentRuns.push({text:slice(source.run.text),style:{...source.run.style}});
    baseRuns.push({text:slice(base.runs[source.index]?.text??source.run.text),style:{...(base.runs[source.index]?.style??source.run.style)}});
    const oldPrefix=`text.runs.${source.index}.`;
    for(const [path,keys] of Object.entries(channels)) if(path.startsWith(oldPrefix)) {
      const field=path.slice(oldPrefix.length);
      keyframes[`text.runs.${i}.${field}`]=keys.map(key=>({...key,id:newId(),value:field==='text'&&typeof key.value==='string'?slice(key.value):key.value}));
    }
  }
  return { next:{...next,runs:nextRuns},current:{...current,runs:currentRuns},base:{...base,runs:baseRuns},keyframes };
}

// Reuse two transparent canvases per target; temporal samples add before compositing once.
// `sum` also keeps the last composite: a caption holds one pose for most of its frames.
const captionSurfaces=new WeakMap<object,{sample:HTMLCanvasElement;sum:HTMLCanvasElement;doc?:TextDocument;pose?:string}>();
/** Live-shutter rasters per caption document: a word keeps its picture through its pop, frame after frame. */
type Sprite={canvas:HTMLCanvasElement;x:number;y:number;w:number;h:number};
const captionSprites=new WeakMap<TextDocument,Map<string,Sprite>>();
function drawCaption(ctx:CanvasRenderingContext2D,doc:TextDocument,width:number,height:number,pw:number,ph:number,elapsed:number,shutter:CaptionShutter) {
  const data=doc.caption!,preset=captionPreset(data.preset),time=Number.isFinite(elapsed)?elapsed:.5;
  if(time<0||time>=data.duration)return;
  const timing=captionTiming(data),entrance=Math.min(data.duration,timing.entranceDuration),exit=Math.min(data.duration,timing.exitDuration);
  const motion=(t:number)=>{
    const u=Math.max(0,Math.min(1,entrance>0?t/entrance:1)),ease=1-(1-u)**3;
    let zoom=1,y=0,blur=0;
    if(preset.motion==='pull')zoom=1.28-.28*ease;
    if(preset.motion==='pop')zoom=.82+.18*ease+.07*Math.sin(u*Math.PI);
    if(preset.motion==='snap')zoom=snapZoom(u);
    if(preset.motion==='bounce'){zoom=.9+.1*ease;y=-10*Math.sin(u*Math.PI*1.5)*(1-u);}
    if(preset.motion==='rise')y=22*(1-ease);
    if(preset.motion==='blur')blur=10*(1-ease);
    const fade=entrance*(preset.motion==='none'||preset.motion==='fade'?1:.055/.16);
    const alpha=(fade>0?Math.min(1,t/fade):1)*(exit>0?Math.min(1,(data.duration-t)/exit):1);
    return {zoom,y,blur,alpha:Math.max(0,alpha)};
  };
  // A word pops from its own start; the shutter below then smears the scale along its direction of travel.
  const wordZoom=(w:CaptionData['words'][number],t:number)=>{const local=t-captionHighlightLead-w.start;return data.wordPop&&local>=0&&local<wordPopDuration?snapZoom(local/wordPopDuration):1;};
  const popping=Boolean(data.wordPop)&&data.words.some(w=>{const local=time-captionHighlightLead-w.start;return local>=0&&local<wordPopDuration+1/60;});
  const moving=['pull','pop','rise','bounce','snap'].includes(preset.motion)&&entrance>0&&time<entrance+1/60;
  const count=shutter&&(moving||popping)?7:1,exposure=Math.min(1/60,Math.max(entrance,popping?wordPopDuration:0)/4);
  const make=()=>{if(typeof document!=='undefined')return document.createElement('canvas');return new (ctx.canvas.constructor as {new(w:number,h:number):HTMLCanvasElement})(width,height);};
  let surfaces=captionSurfaces.get(ctx);
  if(!surfaces){surfaces={sample:make(),sum:make()};captionSurfaces.set(ctx,surfaces);}
  const cue=Math.max(data.words[0]?.start??0,time-captionHighlightLead),active=data.words.findIndex(w=>cue>=w.start&&cue<w.end);
  // A single sample is fully described by its motion, word pops and highlighted word; the document object stands for the rest.
  const still=count===1?motion(time):undefined,pose=still&&`${width}:${height}:${pw}:${ph}:${active}:${still.zoom}:${still.y}:${still.blur}:${still.alpha}:${data.words.map(w=>wordZoom(w,time)).join()}`;
  if(pose&&surfaces.doc===doc&&surfaces.pose===pose&&surfaces.sum.width===width&&surfaces.sum.height===height){ctx.drawImage(surfaces.sum,0,0);return;}
  surfaces.doc=doc;surfaces.pose=pose||undefined;
  for(const canvas of [surfaces.sample,surfaces.sum])if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  const scale=Math.min(pw/1920,ph/1080),style={...doc.runs[0].style,fontSize:doc.runs[0].style.fontSize*scale};
  // A line stays within its safe width even when a corrected word is unusually long.
  ctx.save();ctx.font=canvasFont(style);const measured=ctx.measureText(data.words.map(w=>w.text).join(' ')).width;ctx.restore();
  style.fontSize*=Math.min(1,pw*doc.width/Math.max(1,measured));
  const sum=surfaces.sum.getContext('2d')!,sample=surfaces.sample.getContext('2d')!;
  const cx=(doc.x+doc.width/2)*width,cy=(doc.y*ph+style.fontSize*.55)*height/ph;
  const color=(n:number)=>(preset.highlight||data.accent)&&n===active?data.accent??preset.accent:style.color;
  const plain=(blur:number):TextDocument=>({...doc,caption:undefined,blur:blur*scale,outlineWidth:(doc.outlineWidth??0)*scale,shadowBlur:(doc.shadowBlur??8)*scale,shadowX:(doc.shadowX??0)*scale,shadowY:(doc.shadowY??4)*scale,runs:data.words.map((w,n)=>({text:(n?' ':'')+w.text,style:{...style,color:color(n)}}))});
  // The line always fits on one row (the font shrinks to fit above), so each word sits at its measured offset.
  type Placed={n:number;x:number;width:number;wx:number;text:string};
  let placed:Placed[]|undefined;
  const words=()=>placed??=(()=>{
    sample.font=canvasFont(style);const line=sample.measureText(data.words.map(w=>w.text).join(' ')).width,left=doc.x*pw+(doc.width*pw-line)/2;
    return data.words.map((w,n)=>{const offset=sample.measureText(data.words.slice(0,n).map(v=>v.text+' ').join('')).width,size=sample.measureText(w.text).width;return {n,x:(left+offset)/pw,width:(size+style.fontSize*.2)/pw,wx:(left+offset+size/2)*width/pw,text:w.text};});
  })();
  const word=(base:TextDocument,p:Placed):TextDocument=>({...base,x:p.x,width:p.width,align:'left',runs:[{text:p.text,style:{...style,color:color(p.n)}}]});
  const samples=Array.from({length:count},(_,i)=>{const t=Math.max(0,time-(count===1?0:(1-i/(count-1))*exposure));return {t,m:motion(t),zooms:data.words.map(w=>wordZoom(w,t))};});
  // Live: one raster per word (one for the whole line when nothing pops), each at the largest zoom its samples reach so
  // no sample enlarges it; a word that holds still stays 1:1. Canvas shadows ignore the transform, so they scale by hand.
  const live=shutter==='live'&&count>1,pops=samples.some(s=>s.zooms.some(z=>z!==1));
  const reach=(n?:number)=>Math.ceil(Math.max(1,...samples.map(s=>(n===undefined?1:s.zooms[n])*s.m.zoom))*8)/8;
  const sprite=(d:TextDocument,key:string,raster:number):Sprite=>{
    let cache=captionSprites.get(doc);
    if(!cache){cache=new Map();captionSprites.set(doc,cache);}
    const id=`${width}:${height}:${pw}:${ph}:${raster}:${key}`,hit=cache.get(id);
    if(hit)return hit;
    const fx={...defaultTextEffects,...d},pad=Math.max(fx.outlineWidth,fx.shadowOpacity?fx.shadowBlur*3+Math.max(Math.abs(fx.shadowX),Math.abs(fx.shadowY)):0);
    const x=Math.floor((d.x*pw-pad)*width/pw),y=Math.floor((d.y*ph-pad)*height/ph),w=Math.ceil((d.x*pw+d.width*pw+pad)*width/pw)-x,h=Math.ceil((d.y*ph+d.height*ph+pad)*height/ph)-y;
    const canvas=make();canvas.width=Math.max(1,Math.ceil(w*raster));canvas.height=Math.max(1,Math.ceil(h*raster));
    const c=canvas.getContext('2d')!;c.setTransform(raster,0,0,raster,-x*raster,-y*raster);
    drawText(c,{...d,shadowBlur:fx.shadowBlur*raster,shadowX:fx.shadowX*raster,shadowY:fx.shadowY*raster},width,height,pw,ph,time);
    const made={canvas,x,y,w:canvas.width/raster,h:canvas.height/raster};
    cache.set(id,made);return made;
  };
  const rasters=!live?[]:pops?words().map(p=>({p,s:sprite(word(plain(0),p),`${p.n}:${color(p.n)}`,reach(p.n))})):[{p:undefined,s:sprite(plain(0),`line:${active}`,reach())}];
  const backing=[doc.x*width-8*scale*width/pw,doc.y*height-5*scale*height/ph,doc.width*width+16*scale*width/pw,style.fontSize*1.3*height/ph] as const;
  // Live, every pixel a sample can touch is known (its rasters and backing, moved by its zooms and lift, plus its blur), so
  // the seven clears and composites cover that band instead of the whole frame.
  let region:[number,number,number,number]=[0,0,width,height];
  if(live){
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for(const {m,zooms} of samples){
      const lift=m.y*scale*height/ph,spread=m.blur*scale*width/pw*3;
      const cover=(x:number,y:number,w:number,h:number,wx=cx,z=1)=>{const k=m.zoom*z,X=cx+m.zoom*((x-wx)*z+wx-cx),Y=cy+lift+k*(y-cy);x0=Math.min(x0,X-spread);y0=Math.min(y0,Y-spread);x1=Math.max(x1,X+w*k+spread);y1=Math.max(y1,Y+h*k+spread);};
      if(preset.backing)cover(...backing);
      for(const {p,s} of rasters)cover(s.x,s.y,s.w,s.h,p?.wx,p?zooms[p.n]:1);
    }
    const left=Math.max(0,Math.floor(x0)-1),top=Math.max(0,Math.floor(y0)-1);
    region=[left,top,Math.max(0,Math.min(width,Math.ceil(x1)+1)-left),Math.max(0,Math.min(height,Math.ceil(y1)+1)-top)];
  }
  sum.clearRect(...region);
  for(const {t,m,zooms} of samples){
    sample.clearRect(...region);sample.save();sample.globalAlpha=m.alpha;
    sample.translate(cx,cy+m.y*scale*height/ph);sample.scale(m.zoom,m.zoom);sample.translate(-cx,-cy);
    if(preset.backing){sample.fillStyle='#080b10cc';sample.fillRect(...backing);}
    const around=(p:Placed,paint:()=>void)=>{sample.save();sample.translate(p.wx,cy);sample.scale(zooms[p.n],zooms[p.n]);sample.translate(-p.wx,-cy);paint();sample.restore();};
    if(live){
      if(m.blur)sample.filter=`blur(${m.blur*scale*width/pw}px)`;
      for(const {p,s} of rasters){const paint=()=>sample.drawImage(s.canvas,s.x,s.y,s.w,s.h);if(p)around(p,paint);else paint();}
    }
    else if(zooms.every(z=>z===1))drawText(sample,plain(m.blur),width,height,pw,ph,t);
    else for(const p of words())around(p,()=>drawText(sample,word(plain(m.blur),p),width,height,pw,ph,t));
    sample.restore();
    sum.globalCompositeOperation='lighter';sum.globalAlpha=1/count;
    if(region[2]&&region[3])sum.drawImage(surfaces.sample,...region,...region);
  }
  sum.globalCompositeOperation='source-over';sum.globalAlpha=1;
  if(region[2]&&region[3])ctx.drawImage(surfaces.sum,...region,...region);
}
