import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, cycleKind, detectKind, nextKind, pageCount, parseFountain, toDocx, toFountain, toHtml, zip, type ScriptDoc } from './screenplay.ts';

const scene: ScriptDoc['blocks'] = [
  { kind: 'scene', text: 'INT. LIGHTHOUSE - NIGHT' },
  { kind: 'action', text: 'Rain hammers the glass. MAYA (30s) climbs the stairs.\nShe stops at the top.' },
  { kind: 'character', text: 'MAYA (V.O.)' },
  { kind: 'parenthetical', text: '(quietly)' },
  { kind: 'dialogue', text: 'Every night the same light.' },
  { kind: 'note', text: 'Check the lamp prop with art' },
  { kind: 'character', text: 'McCLANE' },
  { kind: 'dialogue', text: 'Then stop counting.' },
  { kind: 'lyric', text: 'Keep the light on\nfor the boats at sea' },
  { kind: 'action', text: 'BANG!\nThe door gives.' },
  { kind: 'transition', text: 'CUT TO:' },
  { kind: 'scene', text: 'Cliff top, later' },
  { kind: 'transition', text: 'FADE OUT.' },
];
const doc: ScriptDoc = { name: 'The Keeper', format: 'screenplay', credit: 'Written by', author: 'Ana Ruiz', blocks: scene };

test('Fountain round trip keeps every element, title page included', () => {
  const text = toFountain(doc);
  assert.match(text, /^Title: The Keeper\nCredit: Written by\nAuthor: Ana Ruiz\n\nINT\. LIGHTHOUSE - NIGHT #1#\n/);
  assert.match(text, /\nMAYA \(V\.O\.\)\n\(quietly\)\nEvery night the same light\.\n/);
  assert.match(text, /\n\[\[Check the lamp prop with art\]\]\n/);
  assert.match(text, /\n@McCLANE\n/);
  assert.match(text, /\n!BANG!\nThe door gives\.\n/);
  assert.match(text, /\n\.Cliff top, later #2#\n\n>FADE OUT\.\n$/);
  assert.deepEqual(parseFountain(text), { title: 'The Keeper', credit: 'Written by', author: 'Ana Ruiz', blocks: scene });
  // Stage format leaves the scene numbers out but still round-trips.
  assert.deepEqual(parseFountain(toFountain({ ...doc, format: 'stage' })).blocks, scene);
  assert.doesNotMatch(toFountain({ ...doc, format: 'stage' }), /#1#/);
});

test('plain text and Fountain extras import sensibly', () => {
  assert.deepEqual(parseFountain('We open on a beach.\r\nThe tide is out.\r\n\r\n\r\nA dog runs past.\r\n').blocks, [{ kind: 'action', text: 'We open on a beach.\nThe tide is out.' }, { kind: 'action', text: 'A dog runs past.' }]);
  const text = '﻿Title:\n    _**Big Fish**_\nAuthor: Jo\nDraft date: 1/2/26\n\n# Act one\n= The setup\n.SNOW GLOBE #4A#\n\n/* cut this\nwhole bit */\n>THE END<\n\n===\n\nBOB ^\n(beat)\nHi.\nStill here.\n\nDISSOLVE TO:\n\n~La la\n~la';
  assert.deepEqual(parseFountain(text), { title: 'Big Fish', credit: undefined, author: 'Jo', blocks: [
    { kind: 'scene', text: 'SNOW GLOBE' }, { kind: 'action', text: 'THE END' }, { kind: 'character', text: 'BOB' }, { kind: 'parenthetical', text: '(beat)' }, { kind: 'dialogue', text: 'Hi.\nStill here.' }, { kind: 'transition', text: 'DISSOLVE TO:' }, { kind: 'lyric', text: 'La la\nla' },
  ] });
  assert.deepEqual(parseFountain('').blocks, []);
  assert.deepEqual(parseFountain('EXT. PARK - DAY\nKids play.').blocks, [{ kind: 'scene', text: 'EXT. PARK - DAY' }, { kind: 'action', text: 'Kids play.' }]);
});

test('element keys: Enter, Tab and smart typing', () => {
  assert.deepEqual(['scene', 'action', 'character', 'parenthetical', 'dialogue', 'transition', 'shot', 'lyric', 'note'].map(k => nextKind(k as never)), ['action', 'action', 'dialogue', 'dialogue', 'character', 'scene', 'action', 'lyric', 'action']);
  assert.equal(cycleKind('action', 1), 'character'); assert.equal(cycleKind('note', 1), 'action'); assert.equal(cycleKind('action', -1), 'note'); assert.equal(cycleKind('scene', -1), 'transition');
  for (const [text, kind, previous, expected] of [
    ['int. kitchen - day', 'action', undefined, 'scene'], ['EXT HOUSE', 'action', undefined, 'scene'], ['I/E CAR', 'action', undefined, 'scene'], ['INT./EXT. CAR', 'action', undefined, 'scene'], ['EST. CITY', 'action', undefined, 'scene'],
    ['Interior design', 'action', undefined, 'action'], ['INT. KITCHEN', 'dialogue', undefined, 'dialogue'], ['SMASH CUT TO:', 'action', undefined, 'transition'], ['CUT TO:', 'character', undefined, 'transition'], ['Cut to:', 'action', undefined, 'action'],
    ['(beat)', 'dialogue', 'character', 'parenthetical'], ['(beat)', 'dialogue', 'dialogue', 'parenthetical'], ['(beat)', 'action', 'scene', 'action'], ['Hello', 'dialogue', 'character', 'dialogue'],
  ] as const) assert.equal(detectKind(text, kind, previous), expected, text);
  // Enter turns a short all-caps action line into a character cue; blur and sentences leave it alone.
  for (const [text, enter, expected] of [['THEO', true, 'character'], ['THEO (V.O.)', true, 'character'], ['THEO', false, 'action'], ['THE END.', true, 'action'], ['BANG!', true, 'action'], ['Theo waves', true, 'action']] as const) assert.equal(detectKind(text, 'action', 'action', enter), expected, text);
});

test('html escapes every string and lays out the page', () => {
  const evil: ScriptDoc = { name: 'A & B <script>', format: 'screenplay', blocks: [{ kind: 'scene', text: 'INT. <script>alert(1)</script>' }, { kind: 'dialogue', text: 'Tom & "Jerry"' }, { kind: 'note', text: 'secret team note' }] };
  for (const html of [toHtml(evil), toHtml(evil, { page: true })]) {
    assert.doesNotMatch(html, /<script|secret team note/);
    assert.match(html, /A &amp; B &lt;script&gt;/); assert.match(html, /Tom &amp; &quot;Jerry&quot;/); assert.match(html, /1\. INT\. &lt;SCRIPT&gt;/);
  }
  assert.match(toHtml(evil), /margin:12pt 0in 0 0\.5in/); // Google Docs' 1in margin + 0.5in
  assert.match(toHtml(evil, { page: true }), /@page \{ size: letter; margin: 1in 1in 1in 1\.5in \}/);
  assert.doesNotMatch(toHtml({ ...evil, format: 'stage' }), /1\. INT/);
});

test('docx is a valid STORED zip with escaped text', () => {
  const bytes = toDocx({ ...doc, blocks: [...scene, { kind: 'action', text: 'Fish & <chips>\u0007' }] }), text = new TextDecoder().decode(bytes);
  assert.equal(text.slice(0, 2), 'PK');
  assert.match(text, /\[Content_Types\]\.xml/); assert.match(text, /word\/document\.xml/); assert.match(text, /Fish &amp; &lt;chips&gt;</); assert.doesNotMatch(text, /Check the lamp/);
  assert.match(text, /<w:ind w:left="3168" w:right="0"\/><\/w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New"[^]*?MAYA \(V\.O\.\)/);
  assert.match(text, /w:left="2160" w:right="2880"/); assert.match(text, /w:left="1440" w:right="2160"/); assert.match(text, /<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="2160"/);
  const view = new DataView(bytes.buffer), end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50); assert.equal(view.getUint16(end + 10, true), 3);
  // Walk the central directory and check each entry's local header and CRC.
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < 3; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const size = view.getUint32(at + 20, true), nameLength = view.getUint16(at + 28, true), local = view.getUint32(at + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const data = bytes.subarray(local + 30 + view.getUint16(local + 26, true), local + 30 + view.getUint16(local + 26, true) + size);
    assert.equal(crc32(data), view.getUint32(at + 16, true));
    at += 46 + nameLength;
  }
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  assert.deepEqual(zip([]), Uint8Array.from([0x50, 0x4b, 5, 6, ...new Array(18).fill(0)]));
  assert.match(new TextDecoder().decode(toDocx({ ...doc, format: 'stage' })), /<w:jc w:val="center"\/>[^]*?<w:i\/>/);
});

test('page estimate grows with content and depends on the format', () => {
  const empty: ScriptDoc = { name: 'x', format: 'screenplay', blocks: [] };
  assert.equal(pageCount(empty), 1);
  const long = (n: number, format: ScriptDoc['format']): ScriptDoc => ({ name: 'x', format, blocks: Array.from({ length: n }, (_, i) => i % 2 ? { kind: 'dialogue', text: 'word '.repeat(40) } : { kind: 'character', text: 'ANA' }) });
  assert.ok(pageCount(long(200, 'screenplay')) > pageCount(long(20, 'screenplay')));
  // Dialogue is 35 characters wide in a screenplay and full width on stage.
  assert.ok(pageCount(long(200, 'screenplay')) > pageCount(long(200, 'stage')));
  assert.equal(pageCount({ ...empty, blocks: [{ kind: 'note', text: 'word '.repeat(5000) }] }), 1);
});

test('uncased scripts stay action, every action paragraph round-trips, and inline markup never prints', () => {
  for (const line of ['彼は部屋に入る。', '他走进房间。', 'वह कमरे में आता है', 'هو يدخل الغرفة']) assert.equal(detectKind(line, 'action', 'scene', true), 'action', line);
  assert.deepEqual(parseFountain('INT. 教室 - 昼\n\n彼は部屋に入る。\n彼女は窓を開ける。').blocks.map(b => b.kind), ['scene', 'action']);
  for (const name of ['THEO', 'JOSÉ', "O'BRIEN"]) assert.equal(detectKind(name, 'action', 'action', true), 'character', name);
  const cased: ScriptDoc = { name: '', format: 'screenplay', blocks: [{ kind: 'character', text: '小明' }, { kind: 'dialogue', text: '你好。' }] };
  assert.match(toFountain(cased), /^@小明\n/);
  assert.deepEqual(parseFountain(toFountain(cased)).blocks, cased.blocks);
  for (const text of ['A door slams.\n\nSILENCE.\nThen footsteps.', 'First paragraph.\n\nINT. GARAGE - NIGHT\n\nMAYA\nThis is still action.', 'One.\n\n\nCUT TO:']) {
    const blocks: ScriptDoc['blocks'] = [{ kind: 'scene', text: 'INT. HALL - NIGHT' }, { kind: 'action', text }];
    assert.deepEqual(parseFountain(toFountain({ name: '', format: 'stage', blocks })).blocks.map(b => b.kind), ['scene', ...text.split(/\n{2,}/).map(() => 'action')], text);
  }
  const html = toHtml({ name: '', format: 'screenplay', blocks: parseFountain('INT. HALL - DAY\n\nShe enters. [[check the door prop]]\n\nShe is *very* **angry** and _shouting_, 5 * 3 in file_name.\n\nMAYA\nHi. [[louder?]]').blocks });
  assert.doesNotMatch(html, /\[\[|\*very\*|_shouting_|louder/);
  assert.match(html, />She enters\.<[^]*She is very angry and shouting, 5 \* 3 in file_name\.<[^]*>Hi\.</);
});
