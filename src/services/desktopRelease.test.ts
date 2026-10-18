import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPlatform, parseRelease } from './desktopRelease.ts';

const mac = `version: 1.0.0
files:
  - url: SharedCut-1.0.0-universal.dmg
    sha512: abc==
    size: 123456789
  - url: SharedCut-1.0.0-universal-mac.zip
    sha512: def==
    size: 120000000
path: SharedCut-1.0.0-universal-mac.zip
sha512: def==
releaseDate: '2026-10-18T12:00:00.000Z'
`;
// Written on Windows: CRLF, and no release date.
const windows = 'version: 1.0.1\r\nfiles:\r\n  - url: SharedCut-Setup-1.0.1.exe\r\n    sha512: ghi==\r\n    size: 98765432\r\npath: SharedCut-Setup-1.0.1.exe\r\nsha512: ghi==\r\n';

test('reads the installer out of each manifest', () => {
  assert.deepEqual(parseRelease(mac, '.dmg'), { version: '1.0.0', url: '/download/SharedCut-1.0.0-universal.dmg', size: 123456789, releasedAt: '2026-10-18T12:00:00.000Z' });
  assert.deepEqual(parseRelease(windows, '.exe'), { version: '1.0.1', url: '/download/SharedCut-Setup-1.0.1.exe', size: 98765432 });
});

test('a missing manifest is no release', () => {
  assert.equal(parseRelease('', '.dmg'), null);
  assert.equal(parseRelease('<!doctype html><html lang="en"><head><meta charset="UTF-8"/>', '.exe'), null);
  assert.equal(parseRelease(mac, '.exe'), null);
});

test('leads with the visitor\'s desktop', () => {
  const macUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  assert.equal(detectPlatform(macUA, 'MacIntel'), 'mac');
  assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Win32'), 'windows');
  assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'iPhone'), 'other');
  assert.equal(detectPlatform(macUA, 'MacIntel', 5), 'other'); // an iPad asking for the desktop site
});
