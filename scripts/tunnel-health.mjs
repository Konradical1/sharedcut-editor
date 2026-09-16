import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function recoverTunnel(probe, restart, wait = setTimeout) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await probe()) return false;
    if (attempt < 2) await wait(5000);
  }
  restart();
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await recoverTunnel(async () => {
    try {
      const response = await fetch('http://127.0.0.1:20241/ready', { signal: AbortSignal.timeout(5000) });
      const health = await response.json();
      return response.ok && health.readyConnections > 0;
    } catch { return false; }
  }, () => {
    console.log(`${new Date().toISOString()} Tunnel unready after three checks; restarting`);
    execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.cloudflare.tunnel.frameline`], { timeout: 20000, stdio: 'inherit' });
  });
}
