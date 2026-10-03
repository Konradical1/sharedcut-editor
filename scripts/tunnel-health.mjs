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

// Optional: FRAME_LINE_ALERT_WEBHOOK receives a one-line JSON message (Slack reads `text`, Discord `content`).
async function alert(message) {
  console.log(`${new Date().toISOString()} ${message}`);
  const url = process.env.FRAME_LINE_ALERT_WEBHOOK;
  if (url) await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `SharedCut: ${message}`, content: `SharedCut: ${message}` }), signal: AbortSignal.timeout(10000) }).catch(error => console.log(`Alert webhook failed: ${error.message}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform === 'win32') {
    // scripts/windows-host.ps1 runs this every 5 minutes. A disabled tunnel task means another machine serves the site.
    // Decided by exit code from the task's boolean Enabled setting, not schtasks' translated status text. A missing task counts as off.
    const enabled = (() => { try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (-not (Get-ScheduledTask -TaskName 'SharedCut Tunnel' -ErrorAction Stop).Settings.Enabled) { exit 1 }"], { timeout: 20000, stdio: 'ignore' }); return true; } catch { return false; } })();
    if (!enabled) process.exit(0);
    const url = process.env.FRAME_LINE_HEALTH_URL || 'https://sharedcut.com/api/health';
    let unhealthy = '';
    // Any JSON answer from the server means the tunnel works; a 503 from it (low disk, database) is alerted, not "fixed" by a tunnel restart.
    const restarted = await recoverTunnel(async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'cache-control': 'no-cache' } });
        const health = await response.json();
        if (!response.ok) unhealthy = `${url} answered ${response.status}: ${health.status ?? 'unknown'}`;
        return typeof health.status === 'string';
      } catch { return false; }
    }, () => {
      // The tunnel task loops cloudflared, so ending the process restarts it; /run starts the task if it had stopped.
      try { execFileSync('taskkill', ['/F', '/IM', 'cloudflared.exe'], { timeout: 20000, stdio: 'ignore' }); } catch { /* not running */ }
      try { execFileSync('schtasks', ['/run', '/tn', 'SharedCut Tunnel'], { timeout: 20000, stdio: 'ignore' }); } catch { /* already running */ }
    });
    if (restarted) await alert(`${url} failed three checks; restarted the Cloudflare tunnel.`);
    else if (unhealthy) await alert(unhealthy);
  } else {
    const restarted = await recoverTunnel(async () => {
      try {
        const response = await fetch('http://127.0.0.1:20241/ready', { signal: AbortSignal.timeout(5000) });
        const health = await response.json();
        return response.ok && health.readyConnections > 0;
      } catch { return false; }
    }, () => {
      console.log(`${new Date().toISOString()} Tunnel unready after three checks; restarting`);
      execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/com.cloudflare.tunnel.frameline`], { timeout: 20000, stdio: 'inherit' });
    });
    if (restarted) await alert('The tunnel was unready after three checks and was restarted.');
  }
}
