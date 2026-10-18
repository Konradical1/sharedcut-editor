// sharedcut.com/download: the desktop app for Mac and Windows. Its own small page, like /importer: no editor, no store.
// The installers and electron-builder's update manifests are served at /download/<file>. A missing manifest means that
// platform is not out yet, so its button says Coming soon. Phones and other systems see both platforms plainly.
import { useEffect, useState } from 'react';
import { ArrowLeft, Cpu, Download as DownloadIcon, RefreshCw, WifiOff } from 'lucide-react';
import { detectPlatform, parseRelease, type Release } from '../services/desktopRelease';
import './download.css';

type OS = 'mac' | 'windows';
/** Each platform's release: undefined while its manifest loads, null when there is none. */
type Releases = Partial<Record<OS, Release | null>>;
type OnGet = (os: OS) => void;

const PLATFORMS = {
  mac: { name: 'Mac', manifest: '/download/latest-mac.yml', extension: '.dmg', needs: 'Apple silicon, macOS 13.5 or later' },
  windows: { name: 'Windows', manifest: '/download/latest.yml', extension: '.exe', needs: 'Windows 10 and 11, 64-bit' },
} as const;
const OTHER = { mac: 'windows', windows: 'mac' } as const;
const POINTS = [
  { Glyph: WifiOff, title: 'Works offline', text: 'Create projects, import, edit and export with no connection. It all stays on your computer.' },
  { Glyph: Cpu, title: 'Uses your hardware', text: 'Playback and color run on your own GPU.' },
  { Glyph: RefreshCw, title: 'Always up to date', text: 'It updates itself. Nothing to download again.' },
];
const LOGO = '/brand/sharedcut-logo-colored.png';
const megabytes = (size: number) => `${Math.max(1, Math.round(size / 1e6)).toLocaleString('en-US')} MB`;
// The heading takes focus when the view changes, so a screen reader reads the new one. It is not a control: no ring.
const focusTitle = () => requestAnimationFrame(() => document.getElementById('download-title')?.focus());

const AppIcon = () => <span className="download-icon" aria-hidden="true"><img src={LOGO} alt=""/></span>;
const Lede = () => <p className="download-lede"><span>The whole editor, on your own computer.</span> <span>It works with no internet and updates itself.</span></p>;
const Dot = () => <> <span aria-hidden="true">·</span> </>;

/** The download button and what it gets you: version, size and what it runs on. */
function Get({ os, release, primary = false, onGet }: { os: OS; release: Release | null | undefined; primary?: boolean; onGet: OnGet }) {
  const { name, needs } = PLATFORMS[os], className = `download-button${primary ? ' primary' : ''}`;
  const label = <><DownloadIcon size={19} strokeWidth={2.25} aria-hidden="true"/>Download for {name}</>;
  return <div className="download-get">
    {release ? <a className={className} href={release.url} download onClick={() => onGet(os)}>{label}</a>
      : <button type="button" className={className} disabled aria-busy={release === undefined}>{release === null ? 'Coming soon' : label}</button>}
    <p className="download-meta">{release && <>Version {release.version}<Dot/>{megabytes(release.size)}<Dot/></>}{needs}</p>
  </div>;
}

function Hero({ os, releases, onGet, onSwitch }: { os: OS; releases: Releases; onGet: OnGet; onSwitch: (os: OS) => void }) {
  const other = OTHER[os], available = !!releases[other];
  return <section className="download-hero">
    <AppIcon/>
    <h1 id="download-title" tabIndex={-1}>SharedCut for {PLATFORMS[os].name}</h1>
    <Lede/>
    <Get os={os} release={releases[os]} primary onGet={onGet}/>
    {/* Keeps its place (hidden, so not focusable) while the other manifest loads or when that platform is not out. */}
    <button type="button" className="download-switch" style={available ? undefined : { visibility: 'hidden' }} onClick={() => onSwitch(other)}>Also available for {PLATFORMS[other].name}</button>
  </section>;
}

function Both({ releases, onGet }: { releases: Releases; onGet: OnGet }) {
  return <section className="download-hero">
    <AppIcon/>
    <h1 id="download-title" tabIndex={-1}>SharedCut for Mac and Windows</h1>
    <Lede/>
    <div className="download-both">{(['mac', 'windows'] as const).map(os => <div key={os} className="download-platform">
      <h2>{PLATFORMS[os].name}</h2>
      <Get os={os} release={releases[os]} onGet={onGet}/>
    </div>)}</div>
    <p className="download-note">Open this page on your Mac or PC to install.</p>
  </section>;
}

/** The .dmg's window, SharedCut dragged onto Applications on a loop. It pictures step 2; the list says every step. */
function DragToApplications() {
  return <div className="download-art dmg" aria-hidden="true">
    <div className="dmg-bar"><i/><i/><i/><span>SharedCut</span></div>
    <div className="dmg-body">
      <span className="dmg-item app"><AppIcon/><span>SharedCut</span></span>
      <span className="dmg-arrow"/>
      <span className="dmg-item folder"><span className="dmg-folder"><svg viewBox="0 0 24 24"><path d="M5 20 12 4l7 16M8.2 14h7.6"/></svg></span><span>Applications</span></span>
      <span className="dmg-ghost"><span><AppIcon/><svg className="dmg-cursor" viewBox="0 0 14 20"><path d="M1 1v15.6l3.9-3.7 2.8 6.3 2.5-1.1-2.8-6.2H13z"/></svg></span></span>
    </div>
  </div>;
}

/** SharedCut-Setup on Windows: it installs for this person only, then opens SharedCut by itself. */
function SetupRuns() {
  return <div className="download-art setup" aria-hidden="true">
    <div className="setup-bar"><img src={LOGO} alt=""/><span>SharedCut Setup</span><i/><i/><i/></div>
    <div className="setup-body">
      <AppIcon/>
      <div className="setup-status">
        <span className="setup-label"><span>Installing SharedCut…</span><span>Opening SharedCut…</span></span>
        <span className="setup-progress"><i/></span>
      </div>
    </div>
  </div>;
}

function Install({ os, release, onBack }: { os: OS; release: Release; onBack: () => void }) {
  const file = decodeURIComponent(release.url.slice(release.url.lastIndexOf('/') + 1));
  return <section className="download-hero download-install">
    <h1 id="download-title" tabIndex={-1}>Install SharedCut</h1>
    <p className="download-lede">Your download has started.</p>
    {os === 'mac' ? <DragToApplications/> : <SetupRuns/>}
    {/* role=list: Safari drops the list role from a list without bullets. */}
    <ol className={`download-steps ${os}`} role="list">{os === 'mac' ? <>
      <li><span>Open <b>{file}</b> from your Downloads.</span></li>
      <li><span>Drag <b>SharedCut</b> into <b>Applications</b>.</span></li>
      <li><span>Open <b>SharedCut</b> from Applications.</span></li>
    </> : <>
      <li><span>Open <b>{file}</b> from your Downloads.</span></li>
      <li><span>SharedCut installs and opens by itself. No admin prompt.</span></li>
    </>}</ol>
    <p className="download-again">Didn’t start? <a href={release.url} download>Download again</a></p>
    <button type="button" className="download-switch" onClick={onBack}><ArrowLeft size={15} aria-hidden="true"/>Back</button>
  </section>;
}

export default function Download() {
  const [detected] = useState(() => detectPlatform(navigator.userAgent, navigator.platform, navigator.maxTouchPoints));
  const [shown, setShown] = useState<OS | null>(detected === 'other' ? null : detected);
  const [installing, setInstalling] = useState<OS | null>(null);
  const [releases, setReleases] = useState<Releases>({});
  useEffect(() => {
    document.title = 'Download SharedCut';
    for (const os of ['mac', 'windows'] as const) fetch(PLATFORMS[os].manifest, { cache: 'no-cache' })
      .then(response => response.ok ? response.text() : '')
      .then(text => parseRelease(text, PLATFORMS[os].extension), () => null)
      .then(release => setReleases(all => ({ ...all, [os]: release })));
  }, []);
  // After the click, not in it: a link removed while its click is handled never starts the download.
  const get = (os: OS) => setTimeout(() => { setInstalling(os); focusTitle(); });
  const show = (os: OS | null) => { setInstalling(null); setShown(os); focusTitle(); };
  const release = installing && releases[installing];
  return <div className="download">
    <header className="download-top"><a className="brand" href="/"><img className="brand-mark" src={LOGO} width="26" height="26" alt=""/><span>SharedCut<span className="brand-period">.</span></span></a></header>
    <main className="download-main">
      {installing && release ? <Install key={installing} os={installing} release={release} onBack={() => show(shown)}/>
        : shown ? <Hero key={shown} os={shown} releases={releases} onGet={get} onSwitch={show}/>
        : <Both releases={releases} onGet={get}/>}
      <img className="download-shot" src="/brand/close-up-timeline.png" width="1672" height="941" alt="The SharedCut timeline" decoding="async"/>
      <ul className="download-points">{POINTS.map(({ Glyph, title, text }) => <li key={title}><b><Glyph size={17} strokeWidth={2} aria-hidden="true"/>{title}</b><p>{text}</p></li>)}</ul>
    </main>
    <footer className="download-foot">Rather not install? SharedCut runs in your browser too. <a href="/">Open SharedCut</a></footer>
  </div>;
}
