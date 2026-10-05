import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isChunkLoadError, markStaleBuild, staleBuild, watchPreloadErrors } from './staleBuild.ts';

test('a file the last deploy replaced is recognised in every browser\'s wording, and ordinary errors are not', () => {
  const chunk = [
    new TypeError('Failed to fetch dynamically imported module: https://sharedcut.com/assets/SettingsDialog-DQvvm5WV.js'),
    new TypeError('error loading dynamically imported module: https://sharedcut.com/assets/ColorWorkspace-1.js'),
    new TypeError('Importing a module script failed.'),
    new Error('Unable to preload CSS for /assets/Dashboard-9.css'),
    Object.assign(new Error('Loading chunk 12 failed.'), { name: 'ChunkLoadError' }),
  ];
  for (const error of chunk) assert.equal(isChunkLoadError(error), true, error.message);
  const ordinary = [new TypeError('Cannot read properties of undefined (reading \'map\')'), new Error('Network request failed'), new RangeError('Maximum call stack size exceeded'), 'oops', null, undefined];
  for (const error of ordinary) assert.equal(isChunkLoadError(error), false, String(error));
});

test('marking a stale build tells every listener once and stays marked', () => {
  let heard = 0;
  const stop = staleBuild.subscribe(() => heard++);
  assert.equal(staleBuild.get(), false);
  markStaleBuild(); markStaleBuild();
  assert.equal(staleBuild.get(), true);
  assert.equal(heard, 1, 'one notification however many chunks fail');
  stop();
});

test('a failed preload reports a stale build but leaves the error alone, and nothing reloads the page', () => {
  const page = new EventTarget();
  let reported = 0;
  watchPreloadErrors(page, () => reported++);
  assert.equal(reported, 0);
  const event = new Event('vite:preloadError', { cancelable: true });
  page.dispatchEvent(event);
  assert.equal(reported, 1);
  assert.equal(event.defaultPrevented, false, 'the failing import still rejects, so the panel that needed it shows its own message');
});

test('the workspace boundary is keyed by workspace, so a chunk that failed in one workspace does not hide the others', () => {
  // ChunkBoundary never leaves its failed state; a new key per workspace gives each a fresh boundary on the switch.
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<LazySuspense key=\{workspace\} fallback=/);
});
