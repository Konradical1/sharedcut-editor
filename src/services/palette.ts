// Mood board "Pull colors": a median-cut palette from RGBA pixels (ImageData.data). Pure and DOM-free.
const hex = (pixels: number[][]) => '#' + [0, 1, 2].map(c => Math.round(pixels.reduce((sum, p) => sum + p[c], 0) / pixels.length).toString(16).padStart(2, '0')).join('');
const distance = (a: string, b: string) => Math.hypot(...[1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));

/** Up to `count` '#rrggbb' swatches, most common first; transparent pixels, near-duplicates and edge blends are dropped. */
export function palette(rgba: ArrayLike<number>, count = 5): string[] {
  const total = Math.floor(rgba.length / 4), step = Math.max(1, Math.ceil(total / 20_000)), pixels: number[][] = [];
  for (let i = 0; i < total; i += step) if (rgba[i * 4 + 3] > 127) pixels.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  if (!pixels.length || count < 1) return [];
  // Cut the box with the most spread (range × pixels) at its median; twice the boxes asked for leaves room for duplicates to drop.
  const boxes = [pixels];
  while (boxes.length < count * 2) {
    let best = -1, channel = 0, score = 0;
    boxes.forEach((box, b) => { for (let c = 0; c < 3; c++) { let lo = 255, hi = 0; for (const p of box) { lo = Math.min(lo, p[c]); hi = Math.max(hi, p[c]); } if ((hi - lo) * box.length > score) { score = (hi - lo) * box.length; best = b; channel = c; } } });
    if (best < 0) break; // every box is a single color
    const box = boxes[best].sort((p, q) => p[channel] - q[channel]), mid = box.length >> 1;
    boxes.splice(best, 1, box.slice(0, mid), box.slice(mid));
  }
  // Under 2% of the picture is where two colors meet (a scaled thumbnail blends every edge), not a color of its own.
  const swatches: string[] = [], floor = pixels.length * .02;
  for (const box of boxes.sort((a, b) => b.length - a.length)) { const color = hex(box); if (swatches.length < count && (!swatches.length || box.length >= floor) && swatches.every(s => distance(s, color) >= 24)) swatches.push(color); }
  return swatches;
}
