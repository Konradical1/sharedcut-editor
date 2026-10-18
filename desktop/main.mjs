// SharedCut Desktop. The app runs its own SharedCut server on this computer (bundled Node and FFmpeg, projects in
// the app's data folder) and opens the editor on it, so new projects, imports, editing and exports need no connection.
import { app, BrowserWindow, Menu, Notification, dialog, nativeTheme, shell } from 'electron';
import updater from 'electron-updater';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaged, the server and binaries ride in Contents/Resources; from a checkout, `npm run stage` puts them in stage/.
const resources = app.isPackaged ? process.resourcesPath : join(dirname(fileURLToPath(import.meta.url)), 'stage');
const bin = name => join(resources, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
// A fixed port keeps the editor's origin, and with it the sign-in, unsaved drafts and footage cache, the same between launches.
const PORT = Number(process.env.SHAREDCUT_PORT || 41237), LOCAL = `http://127.0.0.1:${PORT}`;
const UPDATE_EVERY = 10 * 60_000;
if (process.env.SHAREDCUT_USER_DATA) app.setPath('userData', process.env.SHAREDCUT_USER_DATA);
const dataDir = join(app.getPath('userData'), 'data'), logPath = join(app.getPath('userData'), 'server.log');

// GPU video decode and WebGL2 on every machine Chrome can drive, not only the ones its blocklist approves.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
nativeTheme.themeSource = 'dark';

let server, win, quitting = false;

function startServer() {
  const log = createWriteStream(logPath, { flags: 'a' });
  server = spawn(bin('node'), ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join('server', 'index.ts')], {
    cwd: join(resources, 'app'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', FRAME_LINE_DATA: dataDir, FRAME_LINE_STOP_WITH_STDIN: '1', FFMPEG_PATH: bin('ffmpeg'), FFPROBE_PATH: bin('ffprobe') },
  });
  server.stdout.pipe(log); server.stderr.pipe(log);
  server.on('exit', code => {
    if (quitting) return;
    dialog.showErrorBox('SharedCut stopped', `SharedCut's engine quit unexpectedly (code ${code}). The log is at ${logPath}`);
    app.quit();
  });
}

async function serverUp(timeout = 120_000) {
  for (const until = Date.now() + timeout; Date.now() < until; await new Promise(resolve => setTimeout(resolve, 250)))
    try { await fetch(LOCAL, { method: 'HEAD' }); return; } catch { /* still starting */ }
  throw new Error(`SharedCut's engine did not start. The log is at ${logPath}`);
}

function openWindow() {
  win = new BrowserWindow({ width: 1600, height: 1000, minWidth: 1024, minHeight: 640, show: false, backgroundColor: '#111315', title: 'SharedCut', webPreferences: { sandbox: true, contextIsolation: true, spellcheck: false } });
  const local = url => url === LOCAL || url.startsWith(`${LOCAL}/`);
  const outside = url => { if (/^https?:/.test(url)) void shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { if (local(url)) return { action: 'allow' }; outside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!local(url)) { event.preventDefault(); outside(url); } });
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.on('closed', () => { win = undefined; });
  void win.loadURL(LOCAL);
}

// Updates come from sharedcut.com/download when there is a connection; without one this app just keeps working.
function watchUpdates() {
  const { autoUpdater } = updater;
  autoUpdater.on('update-downloaded', ({ version }) => {
    const note = new Notification({ title: 'SharedCut update ready', body: `Version ${version} installs when you quit SharedCut. Click to restart now.` });
    note.on('click', () => autoUpdater.quitAndInstall());
    note.show();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline */ });
  check(); setInterval(check, UPDATE_EVERY);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (!win) return openWindow(); if (win.isMinimized()) win.restore(); win.focus(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!win && server) openWindow(); });
  // Closing stdin is the server's cue to finish its writes and exit (see FRAME_LINE_STOP_WITH_STDIN in server/index.ts).
  app.on('before-quit', () => { quitting = true; server?.stdin.end(); });
  app.whenReady().then(async () => {
    // Windows gets no menu bar; the Mac needs one for copy and paste in text fields to work.
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }] }, { role: 'windowMenu' }]) : null);
    startServer();
    try { await serverUp(); } catch (error) { dialog.showErrorBox('SharedCut could not start', error.message); app.quit(); return; }
    openWindow();
    if (app.isPackaged) watchUpdates();
  });
}
