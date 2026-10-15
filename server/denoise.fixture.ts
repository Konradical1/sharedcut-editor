// A stand-in for scripts/denoise.py for tests (node, no torch): it speaks the worker's protocol and passes the decoded frames
// through untouched, so a test checks what the server asks for and what the viewer does with the chunks, not the denoising.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FAKE = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
const here = dirname(process.argv[1]), emit = m => process.stdout.write(JSON.stringify(m) + '\n');
const planes = { yuv420p16le: 3, yuv422p16le: 4, yuv444p16le: 6 };
function render(job, report, running) {
  appendFileSync(join(here, 'jobs.log'), JSON.stringify(job) + '\n');
  if (!existsSync(job.profile)) { report({ progress: 5, stage: 'profile' }); writeFileSync(job.profile, '{"sigmaY":1}'); }
  report({ progress: 10, stage: 'denoise' });
  const fps = job.fps.split('/').reduce((a, b) => a / b);
  const decode = spawn(job.ffmpeg, ['-v', 'error', '-nostdin', ...job.inputArgs, '-ss', String(Math.max(0, (job.first - .5) / fps)), '-i', job.input, '-an', '-sn', '-dn', '-vf', 'scale=' + job.width + ':' + job.height + ',format=' + job.pixfmt, '-r', job.fps, '-fps_mode', 'cfr', '-frames:v', String(job.frames), '-f', 'rawvideo', '-']);
  const c = job.colors, encode = spawn(job.ffmpeg, ['-v', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', job.pixfmt, '-s', job.width + 'x' + job.height, '-r', job.fps, '-color_range', c.range, '-colorspace', c.matrix, '-color_primaries', c.primaries, '-color_trc', c.transfer, '-i', '-', ...job.encode], { stdio: ['pipe', 'ignore', 'pipe'] });
  running.push(decode, encode);
  let bytes = 0, errors = '';
  decode.stdout.on('data', d => { bytes += d.length; });
  decode.stdout.pipe(encode.stdin);
  encode.stderr.on('data', d => { errors += d; });
  return new Promise((resolve, reject) => encode.on('close', code => {
    if (running.cancelled) return reject(new Error('Cancelled'));
    // Hold the job while the test keeps a "slow" file beside the worker (queue and cancel tests).
    const finish = () => existsSync(join(here, 'slow')) && !running.cancelled ? setTimeout(finish, 20) : running.cancelled ? reject(new Error('Cancelled')) : code ? reject(new Error(errors.trim() || 'encode ' + code)) : resolve({ frames: Math.round(bytes / (job.width * job.height * planes[job.pixfmt])), fps: job.fps, profile: { sigmaY: 1, device: 'cpu', seconds: 0 } });
    finish();
  }));
}
const mode = process.argv[2];
if (mode === '--check') emit({ available: true, engine: 'denoise', device: 'cpu', workerIdentity: { fake: 1 } });
else if (mode === '--serve') {
  appendFileSync(join(here, 'serve.log'), 'started\n');
  // A "hang" file beside the worker: it never says ready, as one stuck starting CUDA would not.
  if (!existsSync(join(here, 'hang'))) emit({ ready: true, device: 'cpu' });
  const queue = [], jobs = new Map(); let busy = false;
  const next = async () => {
    if (busy || !queue.length) return; busy = true;
    const { id, job } = queue.shift(), running = []; jobs.set(id, running);
    try { emit({ id, ok: true, result: await render(job, m => emit({ id, ...m }), running) }); } catch (error) { emit({ id, error: error.message }); }
    jobs.delete(id); busy = false; next();
  };
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.cancel) appendFileSync(join(here, 'cancel.log'), message.id + '\n');
    if (message.cancel) { const running = jobs.get(message.id); if (running) { running.cancelled = true; for (const child of running) child.kill(); } else { const i = queue.findIndex(q => q.id === message.id); if (i >= 0) { queue.splice(i, 1); emit({ id: message.id, error: 'Cancelled' }); } } return; }
    queue.push(message); next();
  });
} else {
  const running = [];
  render(JSON.parse(readFileSync(mode, 'utf8')), emit, running).then(result => emit(result), error => { process.stderr.write('Noise Reduction: ' + error.message + '\n'); process.exit(1); });
}
`;

/** Writes the stand-in into `dir` (its jobs.log, serve.log and cancel.log land there, a `slow` file there holds every job and a
 *  `hang` file keeps a starting resident from ever saying ready)
 *  and points the server at it. */
export function useDenoiseStandIn(dir: string) {
  const worker = join(dir, 'fake-denoise.mjs');
  writeFileSync(worker, FAKE);
  process.env.FRAME_LINE_DENOISE_PYTHON = process.execPath; process.env.FRAME_LINE_DENOISE_WORKER = worker;
  return worker;
}
