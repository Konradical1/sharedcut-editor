// End-to-end check of the packaged Mac app with the internet cut off: it boots its own server, a new local account and
// project take camera-like footage, the bundled FFmpeg prepares it and exports the timeline, the editor shows the
// project, and quitting stops the server. Run after `npm run dist`:  node offline-check.mjs
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchState } from '../scripts/state-patch.mjs';

const desktop = dirname(fileURLToPath(import.meta.url)), root = join(desktop, '..');
const bundle = join(desktop, 'release', 'mac-arm64', 'SharedCut.app'), bin = name => join(bundle, 'Contents', 'Resources', 'bin', name);
const port = 41300 + Math.floor(Math.random() * 500), origin = `http://127.0.0.1:${port}`;
const work = await mkdtemp(join(tmpdir(), 'sharedcut-offline-')), shots = join(desktop, 'release', 'offline-check');
const step = message => console.log(`• ${message}`);
const until = async (what, test, seconds) => { for (const end = Date.now() + seconds * 1000; Date.now() < end; await new Promise(r => setTimeout(r, 1000))) { const value = await test(); if (value) return value; } throw new Error(`Timed out waiting for ${what}.`); };

// Footage like a mirrorless camera's (4K HEVC 10-bit 4:2:2) and a phone's (1080p H.264), three seconds each.
await mkdir(join(work, 'card')); await mkdir(shots, { recursive: true });
execFileSync(bin('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv422p10le', '-tag:v', 'hvc1', '-c:a', 'aac', join(work, 'card', 'A001.mov')]);
execFileSync(bin('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(work, 'card', 'phone.mp4')]);

// A proxy that leads nowhere: only 127.0.0.1, the app's own server, is reachable, as in a park with no signal.
const app = await electron.launch({ executablePath: join(bundle, 'Contents', 'MacOS', 'SharedCut'), args: ['--proxy-server=http://127.0.0.1:9'], env: { ...process.env, SHAREDCUT_USER_DATA: join(work, 'user-data'), SHAREDCUT_PORT: String(port) } });
const outside = new Set();
try {
  const page = await app.firstWindow();
  page.on('request', request => { if (!/^(http:\/\/127\.0\.0\.1:\d+|data:|blob:|devtools:|chrome-extension:)/.test(request.url())) outside.add(request.url()); });
  await page.locator('input[type="email"]').waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(shots, '1-first-launch.png') });
  step('the app opened on its own server, at the sign-in screen');

  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const signup = await fetch(`${origin}/api/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ name: 'Offline Check', email: 'offline-check@example.com', password: 'offline check password' }) });
  if (signup.status !== 201) throw new Error(`Sign-up answered ${signup.status}: ${await signup.text()}`);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const call = async (path, init = {}) => {
    const response = await fetch(origin + path, { ...init, headers: { ...headers, cookie, ...init.headers } }), text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`${path} answered ${response.status}: ${text}`), { status: response.status });
    return text ? JSON.parse(text) : null;
  };
  step('a local account was created');

  execFileSync(process.execPath, [join(root, 'scripts', 'import-folder.mjs'), join(work, 'card'), '--server', origin, '--name', 'Offline check', '--resolution', '1920 × 1080', '--fps', '25'], { env: { ...process.env, FRAME_LINE_COOKIE: cookie }, stdio: 'ignore' });
  const project = (await call('/api/state')).state.projects.find(p => p.name === 'Offline check');
  const media = await until('the footage to be prepared', async () => {
    const list = (await call('/api/state')).state.media.filter(m => m.projectId === project.id);
    const failed = list.find(m => m.status === 'failed');
    if (failed) throw new Error(`${failed.name} failed to prepare: ${failed.error ?? failed.preparationStage ?? 'no reason given'}`);
    return list.length === 2 && list.every(m => m.status === 'ready') && list;
  }, 600);
  step(`imported and prepared ${media.map(m => `${m.name} (${m.resolution})`).join(', ')}`);

  let timeline, end = 0;
  await patchState(call, state => {
    timeline = state.timelines.find(t => t.projectId === project.id);
    const track = state.tracks.find(t => t.timelineId === timeline.id && t.kind === 'video' && t.number === 1);
    end = 0;
    const clips = media.sort((a, b) => a.name.localeCompare(b.name)).map(m => { const clip = { id: `clip-${m.id}`, projectId: project.id, timelineId: timeline.id, trackId: track.id, mediaId: m.id, name: m.name, start: end, duration: m.duration, sourceIn: 0, color: '#8aadac', disabled: false, properties: {}, effects: [] }; end += m.duration; return clip; });
    return { clips: { upsert: clips, remove: [] } };
  });
  const settings = { destination: 'Server exports', resolution: project.resolution, fps: String(project.fps), codec: 'H.264', quality: 'High · 20 Mb/s', masterGain: '0', masterMuted: 'false', range: 'Entire timeline', rangeIn: '0', rangeOut: String(end), duration: String(end), timecodeIn: '00:00:00:00', timecodeOut: '00:00:06:00', sourceFrameRate: String(project.fps), audio: 'AAC · 320 kb/s · 48 kHz', subtitles: 'None', timeline: timeline.name, timelineId: timeline.id };
  const { job } = await call('/api/renders', { method: 'POST', body: JSON.stringify({ projectId: project.id, name: 'Offline check.mp4', preset: 'Quick Export', settings }) });
  const done = await until('the export', async () => {
    const found = (await call('/api/renders')).jobs.find(j => j.id === job.id);
    if (found.status === 'failed') throw new Error(`The export failed: ${found.error}`);
    return found.status === 'complete' && found;
  }, 600);
  const file = Buffer.from(await (await fetch(origin + done.outputUrl, { headers: { cookie } })).arrayBuffer());
  await writeFile(join(work, 'export.mp4'), file);
  const seconds = Number(execFileSync(bin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(work, 'export.mp4')], { encoding: 'utf8' }));
  if (Math.abs(seconds - end) > 0.2) throw new Error(`The export is ${seconds} s long; the timeline is ${end} s.`);
  step(`exported ${(file.length / 1e6).toFixed(1)} MB, ${seconds.toFixed(2)} s, with the bundled FFmpeg`);

  const [name, ...value] = cookie.split('=');
  await app.evaluate(({ session }, details) => session.defaultSession.cookies.set(details), { url: origin, name, value: value.join('=') });
  await page.reload();
  await page.getByText('Offline check').first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(shots, '2-projects.png') });
  await page.getByRole('button', { name: 'Open Offline check' }).click();
  await page.waitForURL(/\/project\//, { timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(shots, '3-editor.png') });
  await page.locator('.timeline').first().waitFor({ timeout: 30_000 });
  step('the editor opened the project');
  if (outside.size) console.log(`  requests that needed the internet (failed offline): ${[...outside].join(', ')}`);
} finally {
  await app.close();
}
await until('the server to stop after quitting', async () => { try { await fetch(origin); return false; } catch { return true; } }, 20);
step(`quitting stopped the server. Screenshots: ${shots}`);
await rm(work, { recursive: true, force: true });
