// Script exports and Fountain import shared by the Plan workspace, the MCP script jobs and the tests.
// Pure and DOM-free: the browser wraps the results in Blobs (src/components/plan/download.ts), the MCP writes them to disk.
import type { ScriptBlockKind, ScriptFormat } from '../state/models.ts';

export interface ScriptDoc { name: string; format: ScriptFormat; credit?: string; author?: string; blocks: { kind: ScriptBlockKind; text: string }[] }
type Block = ScriptDoc['blocks'][number];

const NEXT: Record<ScriptBlockKind, ScriptBlockKind> = { scene: 'action', action: 'action', character: 'dialogue', parenthetical: 'dialogue', dialogue: 'character', transition: 'scene', shot: 'action', lyric: 'lyric', note: 'action' };
const CYCLE: readonly ScriptBlockKind[] = ['action', 'character', 'parenthetical', 'dialogue', 'transition', 'scene', 'shot', 'lyric', 'note'];
/** The element Enter starts after `kind`. */
export const nextKind = (kind: ScriptBlockKind) => NEXT[kind];
/** Tab / Shift-Tab through the elements, wrapping. */
export const cycleKind = (kind: ScriptBlockKind, direction: 1 | -1) => CYCLE[(CYCLE.indexOf(kind) + direction + CYCLE.length) % CYCLE.length];

const SCENE = /^(?:int\.?\/ext|ext\.?\/int|int|ext|est|i\/e)[. ]/i;
const TITLE_KEY = /^(?:title|credit|authors?|source|draft date|date|contact|copyright|notes|revision)\s*:/i;
// Needs an upper-case letter: Japanese, Chinese, Arabic or Hindi have no case, and their action must not read as a name.
const caps = (text: string) => /\p{Lu}/u.test(text) && text === text.toUpperCase();
const isTransition = (text: string) => caps(text) && text.endsWith('TO:');
/** A character cue without its extensions ((V.O.), (cont'd)) and dual-dialogue caret; those may be lower case. */
const characterName = (text: string) => text.replace(/\s*\^$/, '').replace(/(?:\s*\([^()]*\))+\s*$/, '').trim();
const paren = (text: string) => text.startsWith('(') ? text : `(${text})`;

/** Smart typing: what a block becomes from what was typed into it. */
export function detectKind(text: string, kind: ScriptBlockKind, previous?: ScriptBlockKind, enter = false): ScriptBlockKind {
  const t = text.trim();
  if (kind === 'action' && SCENE.test(t)) return 'scene';
  if ((kind === 'action' || kind === 'character') && isTransition(t)) return 'transition';
  if ((kind === 'action' || kind === 'character' || kind === 'dialogue') && t.startsWith('(') && (previous === 'character' || previous === 'dialogue')) return 'parenthetical';
  // Enter after a short all-caps action line ("THEO"): a character cue, as Fountain reads a name over dialogue. Only on
  // Enter, since a line merely left in caps ("THE END") stays action; a sentence end (". ! ? :") keeps it action too.
  if (enter && kind === 'action' && caps(t) && !t.includes('\n') && characterName(t).length <= 40 && !/[.!?:]$/.test(t)) return 'character';
  return kind;
}

/** Fountain (fountain.io) or plain text into blocks. Plain paragraphs read as action. */
export function parseFountain(text: string) {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
  const result: { title?: string; credit?: string; author?: string; blocks: Block[] } = { blocks: [] }, push = (kind: ScriptBlockKind, text: string) => { result.blocks.push({ kind, text }); };
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (TITLE_KEY.test(lines[i] ?? '')) {
    // Title page: `Key: value` lines up to the first blank line; indented lines continue the last key.
    const values: Record<string, string[]> = {}; let key = '';
    for (; i < lines.length && lines[i].trim(); i++) { const match = /^([^\s:][^:]*):(.*)$/.exec(lines[i]); if (match) (values[key = match[1].trim().toLowerCase()] ??= []).push(match[2]); else if (key) values[key].push(lines[i]); }
    const value = (k: string) => values[k]?.map(v => v.trim().replace(/^[*_]+|[*_]+$/g, '')).filter(Boolean).join(' ') || undefined;
    result.title = value('title'); result.credit = value('credit'); result.author = value('author') ?? value('authors');
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('=') || t.startsWith('#')) continue; // page breaks, synopses and sections are not script text
    if (t.startsWith('[[')) {
      let j = i, note = t;
      while (!note.includes(']]') && lines[j + 1]?.trim()) note += '\n' + lines[++j].trim();
      if (note.endsWith(']]')) { push('note', note.slice(2, -2).trim()); i = j; continue; }
    }
    if (t.startsWith('.') && !t.startsWith('..') || SCENE.test(t)) { push('scene', (t.startsWith('.') ? t.slice(1) : t).replace(/\s*#[\w.-]+#$/, '').trim()); continue; }
    if (t.startsWith('>') && t.endsWith('<')) { push('action', t.slice(1, -1).trim()); continue; }
    if (t.startsWith('>') || !t.startsWith('!') && !t.startsWith('@') && isTransition(t)) { push('transition', t.startsWith('>') ? t.slice(1).trim() : t); continue; }
    if (t.startsWith('~')) { const lyric = [t.slice(1).trim()]; while (lines[i + 1]?.trim().startsWith('~')) lyric.push(lines[++i].trim().slice(1).trim()); push('lyric', lyric.join('\n')); continue; }
    if (t.startsWith('@') || !t.startsWith('!') && lines[i + 1]?.trim() && caps(characterName(t))) {
      push('character', (t.startsWith('@') ? t.slice(1) : t).replace(/\s*\^$/, '').trim());
      let speech: string[] = [];
      const flush = () => { if (speech.length) push('dialogue', speech.join('\n')); speech = []; };
      while (lines[i + 1]?.trim()) { const line = lines[++i].trim(); if (line.startsWith('(') && line.endsWith(')')) { flush(); push('parenthetical', line); } else speech.push(line); }
      flush(); continue;
    }
    // Action keeps its line breaks and indents; '!' forces it.
    const paragraph = [lines[i].trimEnd().replace(/^(\s*)!/, '$1')];
    while (lines[i + 1]?.trim()) paragraph.push(lines[++i].trimEnd());
    push('action', paragraph.join('\n'));
  }
  return result;
}

const SPEECH = new Set<ScriptBlockKind>(['parenthetical', 'dialogue']), SPEAKER = new Set<ScriptBlockKind>(['character', 'parenthetical', 'dialogue']);
/** Action whose first line Fountain would read as something else gets the '!' marker. */
const forceAction = (text: string) => { const first = text.split('\n')[0].trim(); return SCENE.test(first) || isTransition(first) || TITLE_KEY.test(first) || /^(?:[.!@>~=#]|\[\[)/.test(first) || text.includes('\n') && caps(characterName(first)) ? `!${text}` : text; };

/** Fountain text (Highland, WriterDuet, Final Draft). Force markers are added wherever plain text would read back as another element. */
export function toFountain(doc: ScriptDoc) {
  const title = ([['Title', doc.name], ['Credit', doc.credit], ['Author', doc.author]] as const).filter(([, v]) => v?.trim()).map(([k, v]) => `${k}: ${v!.replace(/\s+/g, ' ').trim()}`);
  const out: string[] = []; let scene = 0, previous: ScriptBlockKind | undefined;
  for (const { kind, text: raw } of doc.blocks) {
    if (kind === 'scene') scene++;
    const lines = raw.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd());
    // Blank lines end an element in Fountain, so only action may keep them (they read back as separate paragraphs).
    const text = (kind === 'action' ? lines : lines.map(line => line.trim()).filter(Boolean)).join('\n').replace(/^\n+|\n+$/g, ''), line = text.replace(/\n/g, ' ');
    if (!text.trim()) continue;
    const element = kind === 'scene' ? `${SCENE.test(line) ? '' : '.'}${line}${doc.format === 'screenplay' ? ` #${scene}#` : ''}`
      : kind === 'character' ? `${caps(characterName(line)) && !SCENE.test(line) && !isTransition(line) && !/^(?:[.!@>~=#(]|\[\[)/.test(line) ? '' : '@'}${line}`
      : kind === 'parenthetical' ? paren(line)
      : kind === 'transition' ? (isTransition(line) ? line : `>${line}`)
      : kind === 'lyric' ? text.split('\n').map(l => `~${l}`).join('\n')
      : kind === 'note' ? `[[${text}]]`
      : kind === 'dialogue' ? text
      // Each paragraph of an action is read on its own, so each is forced on its own.
      : (kind === 'shot' ? text.toUpperCase() : text).split(/(\n{2,})/).map((part, i) => i % 2 ? part : forceAction(part)).join('');
    out.push(out.length ? SPEECH.has(kind) && previous && SPEAKER.has(previous) ? '\n' : '\n\n' : '', element);
    previous = kind;
  }
  return `${title.length ? `${title.join('\n')}\n\n` : ''}${out.join('')}\n`;
}

// Layout in inches inside the text column: 1.5in left and 1in right margins on letter paper, Courier 12pt at 10 characters an inch.
interface Layout { left: number; right: number; align?: 'center' | 'right'; bold?: boolean; italic?: boolean; caps?: boolean; before?: boolean; keep?: boolean }
type Printed = Exclude<ScriptBlockKind, 'note'>;
const SCREENPLAY: Record<Printed, Layout> = {
  scene: { left: 0, right: 0, bold: true, caps: true, before: true, keep: true },
  action: { left: 0, right: 0, before: true },
  character: { left: 2.2, right: 0, caps: true, before: true, keep: true },
  parenthetical: { left: 1.5, right: 2, keep: true },
  dialogue: { left: 1, right: 1.5 },
  transition: { left: 0, right: 0, align: 'right', caps: true, before: true },
  shot: { left: 0, right: 0, bold: true, caps: true, before: true, keep: true },
  lyric: { left: 1, right: 1.5, italic: true, before: true },
};
// Stage play: names centered, speeches full width, stage directions italic and indented.
const STAGE: Record<Printed, Layout> = { ...SCREENPLAY,
  scene: { left: 0, right: 0, align: 'center', bold: true, caps: true, before: true, keep: true },
  action: { left: 2.5, right: 0, italic: true, before: true },
  character: { left: 0, right: 0, align: 'center', caps: true, before: true, keep: true },
  parenthetical: { left: 2.5, right: 0, italic: true, keep: true },
  dialogue: { left: 0, right: 0 },
};
/** What prints, in order: notes (team notes) and empty blocks left out; scene numbers count every scene block, as the app does. */
function printed(doc: ScriptDoc) {
  const table = doc.format === 'stage' ? STAGE : SCREENPLAY; let scene = 0;
  return doc.blocks.flatMap(({ kind, text: raw }) => {
    if (kind === 'scene') scene++;
    // Inline Fountain notes ([[…]]) and emphasis markers (*, **, _) are for the writers, not the page.
    let text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]*\[\[[\s\S]*?\]\]/g, '').replace(/(\*{1,3})(?=\S)(.+?)(?<=\S)\1/g, '$2').replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1').trim();
    if (kind === 'note' || !text) return [];
    const layout = table[kind];
    if (kind === 'parenthetical') text = paren(text);
    if (layout.caps) text = text.toUpperCase();
    if (kind === 'scene' && doc.format === 'screenplay') text = `${scene}. ${text}`;
    return [{ kind, text, layout }];
  });
}
const BAD_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g; // control characters make Word refuse the whole file
const escape = (text: string) => text.replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const FONT = "font-family:'Courier New',Courier,monospace;font-size:12pt;line-height:1;color:#000";

/** Screenplay HTML. Fragment (default): inline styles for pasting into Google Docs, whose 1in margin needs 0.5in more on the left. Page: a printable document. */
export function toHtml(doc: ScriptDoc, options: { page?: boolean } = {}) {
  const shift = options.page ? 0 : .5, p = (text: string, l: Layout, top = l.before ? '12pt' : '0') =>
    `<p style="${FONT};margin:${top} ${l.right}in 0 ${l.left + shift}in;${l.align ? `text-align:${l.align};` : ''}${l.bold ? 'font-weight:bold;' : ''}${l.italic ? 'font-style:italic;' : ''}${l.keep ? 'break-after:avoid;page-break-after:avoid;' : ''}">${escape(text).replace(/\n/g, '<br>')}</p>`;
  const center: Layout = { left: 0, right: 0, align: 'center' };
  const title = doc.name.trim() ? `<div style="break-after:page;page-break-after:always;${options.page ? 'padding-top:3in' : ''}">${p(doc.name.trim(), { ...center, bold: true }, '0')}${doc.credit?.trim() ? p(doc.credit.trim(), center, '24pt') : ''}${doc.author?.trim() ? p(doc.author.trim(), center, '12pt') : ''}</div>` : '';
  const body = title + printed(doc).map(({ text, layout }) => p(text, layout)).join('');
  return options.page ? `<!doctype html><html><head><meta charset="utf-8"><title>${escape(doc.name)}</title><style>@page { size: letter; margin: 1in 1in 1in 1.5in } body { margin: 0; background: #fff }</style></head><body>${body}</body></html>` : `<div>${body}</div>`;
}

const twips = (inches: number) => Math.round(inches * 1440);
const paragraph = (text: string, l: Layout, before = l.before ? 240 : 0) => `<w:p><w:pPr>${l.keep ? '<w:keepNext/>' : ''}<w:spacing w:before="${before}" w:after="0"/><w:ind w:left="${twips(l.left)}" w:right="${twips(l.right)}"/>${l.align ? `<w:jc w:val="${l.align}"/>` : ''}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>${l.bold ? '<w:b/>' : ''}${l.italic ? '<w:i/>' : ''}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>${text.split('\n').map(line => `<w:t xml:space="preserve">${escape(line)}</w:t>`).join('<w:br/>')}</w:r></w:p>`;
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

/** A .docx (Word, Google Docs): three OOXML parts in a STORED zip, letter paper with screenplay margins. */
export function toDocx(doc: ScriptDoc): Uint8Array<ArrayBuffer> {
  const center: Layout = { left: 0, right: 0, align: 'center' };
  const title = doc.name.trim() ? paragraph(doc.name.trim(), { ...center, bold: true }, 4320) + (doc.credit?.trim() ? paragraph(doc.credit.trim(), center, 480) : '') + (doc.author?.trim() ? paragraph(doc.author.trim(), center, 240) : '') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${title}${printed(doc).map(({ text, layout }) => paragraph(text, layout)).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="2160" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const encode = (text: string) => new TextEncoder().encode(text);
  return zip([{ name: '[Content_Types].xml', data: encode(CONTENT_TYPES) }, { name: '_rels/.rels', data: encode(RELS) }, { name: 'word/document.xml', data: encode(xml) }]);
}

/** Rows a line takes when word-wrapped at `width` characters. */
function rows(line: string, width: number) {
  let n = 1, col = 0;
  for (const word of line.split(/\s+/).filter(Boolean)) {
    if (col && col + 1 + word.length <= width) { col += 1 + word.length; continue; }
    const extra = Math.ceil(word.length / width) - 1;
    if (col) n++;
    n += extra; col = word.length - extra * width;
  }
  return n;
}
// ponytail: an estimate (55 lines a page, no widow or (MORE) handling); a real pagination pass belongs to the print engine.
/** Page estimate: each element wrapped at its column width, blank lines included, 55 lines a page. */
export function pageCount(doc: ScriptDoc) {
  const lines = printed(doc).reduce((sum, { text, layout }, i) => sum + (layout.before && i ? 1 : 0) + text.split('\n').reduce((n, line) => n + rows(line, Math.round((6 - layout.left - layout.right) * 10)), 0), 0);
  return Math.max(1, Math.ceil(lines / 55));
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n; });
/** CRC-32 (zip, PNG). */
export function crc32(bytes: Uint8Array) { let c = ~0; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }
// ponytail: STORED entries, no zip64: fine for documents, not for anything over 4 GB or 65,535 files.
/** An uncompressed zip with a fixed 1980 timestamp, so the same input always makes the same bytes. */
export function zip(files: { name: string; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name), crc = crc32(file.data), size = file.data.length;
    const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer), entry = new Uint8Array(46 + name.length), c = new DataView(entry.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(12, 33, true); l.setUint32(14, crc, true); l.setUint32(18, size, true); l.setUint32(22, size, true); l.setUint16(26, name.length, true); local.set(name, 30);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(14, 33, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true); entry.set(name, 46);
    parts.push(local, file.data); central.push(entry); offset += local.length + size;
  }
  const directory = central.reduce((n, e) => n + e.length, 0), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, directory, true); e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + directory + 22); let at = 0;
  for (const part of [...parts, ...central, end]) { out.set(part, at); at += part.length; }
  return out;
}
