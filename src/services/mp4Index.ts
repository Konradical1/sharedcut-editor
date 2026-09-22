/**
 * Just enough MP4 to turn "seconds 12–19 of this proxy" into a byte range: the sample tables out of
 * `moov`. The proxies are written with `+faststart`, so `moov` sits at the head of the file and one
 * small fetch is enough to plan what the footage cache should pull ahead.
 */
export type Mp4Track = {
  /** Decode-order start time of each sample, seconds. */
  times: Float64Array;
  offsets: Float64Array;
  sizes: Uint32Array;
  /** 0-based sample indexes that are sync samples; undefined means every sample is one. */
  sync?: Uint32Array;
};
export type Mp4Index = { moovEnd: number; tracks: Mp4Track[] };

const text = (view: DataView, at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/** Walks the boxes in [start, end); returns each header so the caller can descend or skip. */
function* boxes(view: DataView, start: number, end: number) {
  let at = start;
  while (at + 8 <= end) {
    let size = view.getUint32(at), header = 8;
    const type = text(view, at + 4);
    if (size === 1) { size = Number(view.getBigUint64(at + 8)); header = 16; }
    else if (size === 0) size = end - at;
    if (size < header || at + size > end) return;
    yield { type, body: at + header, end: at + size };
    at += size;
  }
}

/** Bytes from the file head through the end of `moov`, or null when the head does not reach it yet. */
export function moovExtent(head: ArrayBuffer): number | null {
  const view = new DataView(head);
  let at = 0;
  while (at + 8 <= view.byteLength) {
    let size = view.getUint32(at);
    const type = text(view, at + 4);
    if (size === 1) { if (at + 16 > view.byteLength) return null; size = Number(view.getBigUint64(at + 8)); }
    if (size === 0 || size < 8) return null;
    if (type === 'moov') return at + size;
    if (type === 'mdat') return null;
    at += size;
  }
  return null;
}

function parseTrack(view: DataView, start: number, end: number): Mp4Track | null {
  const stts: number[] = []; let sizes = null as Uint32Array | null, fixedSize = 0, sampleCount = 0;
  const stsc: [number, number][] = [], chunkOffsets: number[] = []; let sync: Uint32Array | undefined;
  const stbl = (from: number, to: number) => {
    for (const box of boxes(view, from, to)) {
      const b = box.body + 4; // skip version/flags
      if (box.type === 'stts') { const n = view.getUint32(b); for (let i = 0; i < n; i++) stts.push(view.getUint32(b + 4 + i * 8), view.getUint32(b + 8 + i * 8)); }
      else if (box.type === 'stsz') { fixedSize = view.getUint32(b); sampleCount = view.getUint32(b + 4); if (!fixedSize) { sizes = new Uint32Array(sampleCount); for (let i = 0; i < sampleCount; i++) sizes[i] = view.getUint32(b + 8 + i * 4); } }
      else if (box.type === 'stsc') { const n = view.getUint32(b); for (let i = 0; i < n; i++) stsc.push([view.getUint32(b + 4 + i * 12), view.getUint32(b + 8 + i * 12)]); }
      else if (box.type === 'stco') { const n = view.getUint32(b); for (let i = 0; i < n; i++) chunkOffsets.push(view.getUint32(b + 4 + i * 4)); }
      else if (box.type === 'co64') { const n = view.getUint32(b); for (let i = 0; i < n; i++) chunkOffsets.push(Number(view.getBigUint64(b + 4 + i * 8))); }
      else if (box.type === 'stss') { const n = view.getUint32(b); sync = new Uint32Array(n); for (let i = 0; i < n; i++) sync[i] = view.getUint32(b + 4 + i * 4) - 1; }
    }
  };
  let timescale = 0;
  const walk = (from: number, to: number) => {
    for (const box of boxes(view, from, to)) {
      if (box.type === 'mdia' || box.type === 'minf') walk(box.body, box.end);
      else if (box.type === 'mdhd') timescale = view.getUint8(box.body) === 1 ? view.getUint32(box.body + 20) : view.getUint32(box.body + 12);
      else if (box.type === 'stbl') stbl(box.body, box.end);
    }
  };
  walk(start, end);
  if (!timescale || !stsc.length || !chunkOffsets.length || (!sizes && !fixedSize)) return null;
  const sizeTable = sizes as Uint32Array | null, count = sizeTable ? sizeTable.length : sampleCount;
  const offsets = new Float64Array(count), times = new Float64Array(count), sizeOf = (i: number) => sizeTable ? sizeTable[i] : fixedSize;
  // stsc runs: chunk numbers are 1-based, each run holds until the next run's first chunk.
  let sample = 0;
  for (let run = 0; run < stsc.length && sample < count; run++) {
    const [firstChunk, perChunk] = stsc[run], lastChunk = run + 1 < stsc.length ? stsc[run + 1][0] - 1 : chunkOffsets.length;
    for (let chunk = firstChunk; chunk <= lastChunk && sample < count; chunk++) {
      let at = chunkOffsets[chunk - 1];
      for (let i = 0; i < perChunk && sample < count; i++, sample++) { offsets[sample] = at; at += sizeOf(sample); }
    }
  }
  let t = 0; sample = 0;
  for (let i = 0; i < stts.length && sample < count; i += 2) for (let j = 0; j < stts[i] && sample < count; j++, sample++) { times[sample] = t / timescale; t += stts[i + 1]; }
  return { times, offsets, sizes: sizeTable ?? new Uint32Array(count).fill(fixedSize), sync };
}

/** Parses the head of a faststart MP4. Null when `moov` is missing or cut short. */
export function parseMp4Index(head: ArrayBuffer): Mp4Index | null {
  const moovEnd = moovExtent(head);
  if (moovEnd === null || moovEnd > head.byteLength) return null;
  const view = new DataView(head), tracks: Mp4Track[] = [];
  for (const box of boxes(view, 0, moovEnd)) if (box.type === 'moov') for (const inner of boxes(view, box.body, box.end)) if (inner.type === 'trak') { const track = parseTrack(view, inner.body, inner.end); if (track) tracks.push(track); }
  return tracks.length ? { moovEnd, tracks } : null;
}

/** Largest i with array[i] <= value, or -1. */
function floorIndex(array: Float64Array, value: number) {
  let low = 0, high = array.length - 1, found = -1;
  while (low <= high) { const mid = (low + high) >> 1; if (array[mid] <= value) { found = mid; low = mid + 1; } else high = mid - 1; }
  return found;
}

/**
 * The byte span [start, end) holding every sample of every track between `from` and `to` seconds,
 * widened back to the sync sample a decoder has to start from. Null when the file has no samples.
 */
export function byteRange(index: Mp4Index, from: number, to: number): { start: number; end: number } | null {
  let start = Infinity, end = 0;
  for (const track of index.tracks) {
    const count = track.times.length;
    if (!count) continue;
    let first = Math.max(0, floorIndex(track.times, Math.max(0, from)));
    if (track.sync) { let k = track.sync.length - 1; while (k > 0 && track.sync[k] > first) k--; first = track.sync[k] ?? 0; }
    let last = floorIndex(track.times, Math.max(from, to));
    if (last < 0) last = 0;
    // The sample that spans `to` itself is still needed to show the frame at `to`.
    if (last + 1 < count && track.times[last] < to) last++;
    start = Math.min(start, track.offsets[first]);
    end = Math.max(end, track.offsets[last] + track.sizes[last]);
  }
  return Number.isFinite(start) && end > start ? { start, end } : null;
}
