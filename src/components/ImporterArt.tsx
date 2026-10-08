// The importer's illustrations (sharedcut.com/importer). Every scene is drawn here in SharedCut's own colors, with no
// outside artwork (the CSP is default-src 'self'), and is aria-hidden: the written steps beside it say everything.
// A scene loops 3 times, then rests on its last frame, which is the explanatory still. CSS scenes get that from
// `animation-iteration-count: 3; animation-fill-mode: both` (the global reduced-motion rule lands on the still at once);
// motion scenes from useLoops. Each lays out on a 60 × 40 em canvas (.ia-frame) that scales with the stage.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { animate, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, ArrowUp, Check, CloudOff, HardDrive, Laptop, WifiOff } from 'lucide-react';

/** Remounts a motion scene (`key`) every `ms`, 3 times, then rests; with reduced motion `still` is true from the start. */
function useLoops(ms: number, times = 3) {
  const still = !!useReducedMotion(), [key, setKey] = useState(still ? times : 1);
  useEffect(() => { if (key >= times) return; const timer = setTimeout(() => setKey(key + 1), ms); return () => clearTimeout(timer); }, [key, ms, times]);
  return { key, still };
}
const Frame = ({ className = '', style, children }: { className?: string; style?: CSSProperties; children: ReactNode }) => <div className={`ia-frame ${className}`} style={style} aria-hidden="true">{children}</div>;
const Dots = () => <><i/><i/><i/></>;
const Win = ({ title, className, children }: { title: string; className: string; children?: ReactNode }) => <div className={`ia-win ${className}`}><div className="ia-bar"><Dots/><span>{title}</span></div>{children}</div>;
const Cursor = ({ className }: { className: string }) => <svg className={`ia-cursor ${className}`} viewBox="0 0 16 22"><path d="M1.5 1.5v16l4.3-3.9 3 6.6 2.6-1.1-2.9-6.4h5.7z"/></svg>;
const Browser = ({ className, children }: { className: string; children?: ReactNode }) => <div className={`ia-browser ${className}`}><div className="ia-bar"><Dots/><span>sharedcut.com/importer</span></div><div className="ia-browser-body"><img src="/brand/sharedcut-logo-colored.png" alt="" width="22" height="22"/>{children}</div></div>;
/** A Final Cut export or a font file: a page with a folded corner and a badge. */
const Doc = ({ label, badge = 'XML', className }: { label: string; badge?: string; className: string }) => <div className={`ia-doc ${className}`}><svg viewBox="0 0 30 38"><path className="ia-doc-page" d="M2.5 1.5h17l8 8v27h-25z"/><path className="ia-doc-fold" d="M19.5 1.5v8h8"/><rect className="ia-doc-badge" x="5" y="22" width="20" height="8" rx="2"/><text x="15" y="28.4">{badge}</text></svg><span>{label}</span></div>;
const Arrow = ({ d, className }: { d: string; className: string }) => <svg className={`ia-arrow ${className}`} viewBox="0 0 600 400"><defs><marker id={`${className}-head`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0l10 5-10 5z"/></marker></defs><path d={d} markerEnd={`url(#${className}-head)`}/></svg>;
/** Numbered markers matching the written steps, on the still a reduced-motion viewer sees. */
const Marks = ({ at }: { at: [number, number][] }) => <>{at.map(([x, y], i) => <b key={i} className="ia-mark" style={{ left: `${x}em`, top: `${y}em` }}>{i + 1}</b>)}</>;

// A1: clip bars leave the Mac's Final Cut timeline along a dotted arc and land on SharedCut's tracks.
const BARS = [
  { color: '#78AAEF', from: [46, 196, 58, 14], to: [362, 184] }, { color: '#78AAEF', from: [106, 196, 74, 14], to: [422, 184] },
  { color: '#78AAEF', from: [182, 196, 50, 14], to: [498, 184] }, { color: '#B298F5', from: [110, 178, 40, 12], to: [424, 155] },
  { color: '#87C9AC', from: [46, 214, 90, 10], to: [362, 220] }, { color: '#87C9AC', from: [140, 214, 80, 10], to: [454, 220] },
];
const CLIP_COLORS = ['#78AAEF', '#B298F5', '#EBC876', '#F06A70', '#ED99C4', '#87C9AC'];
/** SharedCut's timeline panel (x 318–580, y 120–300): V2, V1 and A1, with the logo and wordmark at its foot, below where bars land. */
const Panel = () => <>
  <rect x="318" y="120" width="262" height="180" rx="16" fill="#181b1e" stroke="#303438"/>
  {([['V2', 150, 22], ['V1', 180, 22], ['A1', 216, 18]] as const).map(([name, y, h]) => <g key={name}><rect x="334" y={y} width="230" height={h} rx="6" fill="#202428"/><text x="342" y={y + h / 2 + 3.5} className="ia-track-name">{name}</text></g>)}
  <image href="/brand/sharedcut-logo-colored.png" x="334" y="255" width="22" height="22"/><text x="364" y="271" className="ia-wordmark">SharedCut<tspan fill="#bce8c7">.</tspan></text>
</>;
export function Handoff() {
  const { key, still } = useLoops(7000);
  return <Frame className="ia-handoff"><svg viewBox="0 0 600 400">
    <rect x="24" y="92" width="252" height="166" rx="12" className="ia-shell"/><rect x="34" y="102" width="232" height="140" rx="4" fill="#101214"/>
    <path d="M4 262h292l-14 12H18z" className="ia-shell"/><rect x="128" y="262" width="44" height="4" rx="2" fill="#303438"/>
    <rect x="44" y="110" width="118" height="58" rx="3" fill="#1b1f22"/><rect x="168" y="110" width="88" height="58" rx="3" fill="#171a1c"/>
    {[0, 1, 2, 3].map(i => <rect key={i} x={174 + i % 2 * 40} y={116 + Math.floor(i / 2) * 25} width="34" height="19" rx="2" fill="#24292d"/>)}
    <rect x="40" y="174" width="220" height="62" rx="3" fill="#15181a"/><line x1="96" y1="174" x2="96" y2="236" stroke="#e1e6df" strokeOpacity=".5"/>
    {BARS.map((b, i) => <rect key={i} x={b.from[0]} y={b.from[1]} width={b.from[2]} height={b.from[3]} rx="3" fill={b.color} opacity=".18"/>)}
    <Panel/>
    {/* Over the panel: the arc ends on V1's left edge, where the clips land. */}
    <path d="M262 170C285 20 326 24 334 191" fill="none" stroke="#bce8c7" strokeOpacity=".45" strokeWidth="2" strokeDasharray="2 7" strokeLinecap="round"/>
    <g key={key}>
      {BARS.map((b, i) => { const dx = b.to[0] - b.from[0], dy = b.to[1] - b.from[1];
        return <motion.g key={i} initial={still ? false : { x: 0, y: 0 }} animate={{ x: [0, dx * .5, dx, dx], y: [0, 36 - b.from[1], dy + 2, dy] }} transition={{ duration: 1.15, delay: .5 + i * .35, times: [0, .5, .86, 1], ease: 'easeInOut' }}>
          <rect x={b.from[0]} y={b.from[1]} width={b.from[2]} height={b.from[3]} rx="3" fill={b.color}/>
        </motion.g>; })}
      {!still && <motion.circle cx="345" cy="266" fill="none" stroke="#bce8c7" strokeWidth="2" initial={{ r: 12, opacity: 0 }} animate={{ r: [12, 34], opacity: [.9, 0] }} transition={{ duration: .9, delay: 3.45 }}/>}
    </g>
  </svg></Frame>;
}

/** A mint check in a circle that pops in (SVG, centred on cx, cy). */
const Pop = ({ cx, cy, r, delay }: { cx: number; cy: number; r: number; delay: number }) => {
  const still = !!useReducedMotion();
  return <motion.g initial={still ? false : { scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 16, delay }}>
    <circle cx={cx} cy={cy} r={r} fill="#bce8c7"/><path d={`M${cx - r * .42} ${cy + r * .02}l${r * .3} ${r * .3} ${r * .56}-${r * .6}`} fill="none" stroke="#1a2a1f" strokeWidth={r * .2} strokeLinecap="round" strokeLinejoin="round"/>
  </motion.g>;
};

/** A3, once the export is read: the file drops into this window and opens into its clips on SharedCut's tracks. */
export function Received({ clips }: { clips: number }) {
  const still = !!useReducedMotion(), bars = BARS.slice(0, Math.max(1, Math.min(BARS.length, clips)));
  // The panel, moved 149 left and 22 down, is this browser window's page. The file lands at (449, 132) in its coordinates.
  return <Frame className="ia-received"><svg viewBox="0 0 600 400">
    <rect x="150" y="60" width="300" height="280" rx="14" fill="#1b1e21" stroke="#485c4d" strokeWidth="1.5"/>
    <path d="M150 74a14 14 0 0 1 14-14h272a14 14 0 0 1 14 14v12H150z" fill="#24282b"/>
    {['#d9675f', '#d8ae4f', '#62b46f'].map((c, i) => <circle key={c} cx={166 + i * 12} cy="73" r="3.6" fill={c}/>)}
    <text x="300" y="77" className="ia-url">sharedcut.com/importer</text>
    <g transform="translate(-149 22)"><Panel/>
      {bars.map((b, i) => { const w = b.from[2], h = b.from[3];
        return <motion.g key={i} initial={still ? false : { x: 449 - (b.to[0] + w / 2), y: 132 - b.to[1], opacity: 0 }} animate={{ x: 0, y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 1 + i * .12 }}>
          <rect x={b.to[0]} y={b.to[1]} width={w} height={h} rx="3" fill={b.color}/>
        </motion.g>; })}
    </g>
    {!still && <motion.g initial={{ y: -150, opacity: 0, scale: 1 }} animate={{ y: [-150, 0, 0], opacity: [0, 1, 0], scale: [1, 1, .4] }} transition={{ duration: 1.1, times: [0, .6, 1], ease: 'easeOut' }}>
      <path d="M285 135h22l8 8v30h-30z" fill="#e6ebe5" stroke="#b4bbc0"/><path d="M307 135v8h8" fill="#c9d0c8" stroke="#b4bbc0"/><rect x="289" y="155" width="22" height="8" rx="2" fill="#B298F5"/>
    </motion.g>}
    <Pop cx={436} cy={128} r={15} delay={still ? 0 : 1.9}/>
  </svg></Frame>;
}

/** The name form's stage: a Projects card with the name typed in live, the way classmates will see it. */
export function NameTag({ name, color }: { name: string; color: string }) {
  return <Frame className="ia-nametag">
    <div className="ia-card"><div className="ia-card-cover"><span className="ia-card-strip"/><div className="ia-card-news"><b><strong style={{ color }}>{name || 'Your name'}</strong><i className="ia-caret" style={{ background: color }}/> is importing a project from Final Cut</b><small>12% · 0.6 of 4.8 GB</small><span className="ia-card-bar"><i/></span></div></div>
      <div className="ia-card-meta"><b>My Film</b><span>Class</span></div></div>
    <div className="ia-remote" style={{ '--who': color } as CSSProperties}><Cursor className="ia-remote-arrow"/><span>{name || 'Your name'}</span></div>
  </Frame>;
}

// A2 (8 s): click the project, File › Export XML…, save to the Desktop, drag the file into this window.
const MENU = ['New', 'Open Library…', 'Import', 'Export XML…', 'Share', 'Close Library'];
export function ExportScene() {
  return <Frame className="ia-export">
    <div className="ia-menubar"><b style={{ left: '1.6em' }}>Final Cut Pro</b>{['File', 'Edit', 'Trim', 'Mark', 'Clip'].map((m, i) => <span key={m} className={i ? '' : 'ia-x-file'} style={{ left: `${11 + i * 3}em` }}>{m}</span>)}</div>
    <Win title="Final Cut Pro" className="ia-x-fcp"><div className="ia-x-libraries"><small>Libraries</small><span>School Library</span><span className="on">4-10-26</span></div>
      <div className="ia-x-thumb ia-x-project"><svg viewBox="0 0 40 24"><rect x="4" y="8" width="14" height="5" rx="1" fill="#78AAEF"/><rect x="19" y="8" width="17" height="5" rx="1" fill="#78AAEF"/><rect x="8" y="3" width="10" height="4" rx="1" fill="#B298F5"/><rect x="4" y="15" width="24" height="4" rx="1" fill="#87C9AC"/></svg><span>My Film</span></div>
      <div className="ia-x-thumb"><i/><span>Interview</span></div><div className="ia-x-thumb" style={{ left: '11em', top: '10.6em' }}><i/><span>B-roll</span></div>
    </Win>
    <div className="ia-x-menu">{MENU.map(m => <span key={m}>{m}</span>)}<i className="ia-x-highlight"/></div>
    <div className="ia-x-sheet"><label>Save As:<span>My Film</span></label><label>Where:<span>Desktop</span></label><div><span>Cancel</span><span className="ia-x-save">Save</span></div></div>
    <div className="ia-desktop"><small>Desktop</small></div>
    <Doc label="My Film.fcpxmld" className="ia-x-doc"/><Browser className="ia-x-browser"><i className="ia-browser-drop"/></Browser>
    <Doc label="" className="ia-x-ghost"/>
    <Arrow className="ia-x-arrow" d="M100 312C200 330 330 300 405 245"/>
    <Cursor className="ia-x-cursor"/>
    {/* 1 on the selected project, 2 inside the open menu at the end of Export XML's row, 3 on the file on the Desktop. */}
    <Marks at={[[34.4, 6.2], [22.3, 9.4], [9, 29]]}/>
  </Frame>;
}

// A4 (8 s): Font Book, right-click › Show in Finder, then drag the font file into this window.
export function FontScene({ family }: { family: string }) {
  const file = `${family.replace(/\s+/g, '')}-Bold.otf`;
  return <Frame className="ia-fonts">
    <Win title="Font Book" className="ia-f-book"><div className="ia-f-side"><span className="on">All Fonts</span><span>My Fonts</span></div>
      <div className="ia-f-list">{['Avenir Next', family, 'Gill Sans', 'Optima', 'Palatino'].map((f, i) => <span key={i} className={i === 1 ? 'ia-f-row' : ''}>{f}</span>)}</div></Win>
    <div className="ia-f-menu"><span>Show in Finder</span><span>Copy</span><span>Deactivate</span><span>Remove…</span></div>
    <Win title="Fonts" className="ia-f-finder"><Doc label={file} badge="OTF" className="ia-f-file"/></Win>
    <Browser className="ia-f-browser"><i className="ia-browser-drop"/></Browser>
    <Doc label="" badge="OTF" className="ia-f-ghost"/>
    <Arrow className="ia-f-arrow" d="M292 198C340 172 380 140 418 122"/>
    <Cursor className="ia-f-cursor"/>
    <Marks at={[[30.4, 7.1], [28.6, 9.6], [19.4, 15.6]]}/>
  </Frame>;
}

/** A4, once every font is in: the edit's own title, set in the font just added, on a dark title-safe frame. */
export function FontDone({ family, text }: { family: string; text: string }) {
  const still = !!useReducedMotion();
  return <Frame className="ia-fontdone"><div className="ia-fd-screen"><i/>
    <motion.b style={{ fontFamily: `"${family}", system-ui, sans-serif` }} initial={still ? false : { opacity: 0, y: '.3em' }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .5, delay: .2, ease: [.22, 1, .36, 1] }}>{text}</motion.b>
    <small>{family}</small>
    <motion.span className="ia-fd-check" initial={still ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 15, delay: .8 }}><Check/></motion.span>
  </div></Frame>;
}

// A5 (8 s), from the first place still missing files: Finder's sidebar item, then the item, dragged into this window.
const FAVORITES = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music'];
export function FinderScene({ sidebar, item, kind, drive }: { sidebar: string; item: string; kind: 'library' | 'drive' | 'folder'; drive: boolean }) {
  const favorites = drive || FAVORITES.includes(sidebar) ? FAVORITES : [...FAVORITES, sidebar], locations = ['Macintosh HD', ...(drive ? [sidebar] : [])];
  // The window's top is at 3 em, its sidebar rows 1.9 em apart below the title bar, a padding and the Favorites label;
  // the Locations label takes one row.
  const rowY = (name: string) => { const f = favorites.indexOf(name); return 3 + 2.2 + .6 + 1.2 + (f >= 0 ? f : favorites.length + 1 + locations.indexOf(name)) * 1.9; };
  const fromSidebar = item === sidebar, start: [number, number] = fromSidebar ? [2.4, rowY(sidebar) - 1.6] : [13, 6.4], aim: [number, number] = fromSidebar ? [5, rowY(sidebar) + .95] : [16.5, 8.1];
  const icon = (name: string, k: string) => <div key={name} className={`ia-k-item ${k}`}>{k === 'library' ? <svg viewBox="0 0 40 32"><rect x="3" y="3" width="34" height="26" rx="5" fill="#2b2140" stroke="#B298F5" strokeWidth="1.5"/><path d="M20 9l2.4 5 5.4.6-4 3.6 1.1 5.4-4.9-2.8-4.9 2.8 1.1-5.4-4-3.6 5.4-.6z" fill="#B298F5"/></svg> : k === 'drive' ? <svg viewBox="0 0 40 32"><rect x="3" y="9" width="34" height="16" rx="3" fill="#2a2f33" stroke="#90979c" strokeWidth="1.5"/><circle cx="31" cy="17" r="1.6" fill="#bce8c7"/></svg> : <svg viewBox="0 0 40 32"><path d="M3 7a2 2 0 0 1 2-2h10l3 3h17a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#3d6ea8"/><path d="M3 11h34v16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#5b8fcf"/></svg>}<span>{name}</span></div>;
  const vars = { '--sy': `${rowY(sidebar) + .95}em`, '--cx': `${aim[0]}em`, '--cy': `${aim[1]}em`, '--gx': `${start[0]}em`, '--gy': `${start[1]}em`, '--tx': '46.5em', '--ty': '19em' } as CSSProperties;
  return <Frame className="ia-finder" style={vars}>
    <Win title={sidebar} className="ia-k-win">
      <div className="ia-k-side"><small>Favorites</small>{favorites.map(f => <span key={f} className={f === sidebar ? 'ia-k-pick' : ''}>{f}</span>)}<small>Locations</small>{locations.map(l => <span key={l} className={l === sidebar ? 'ia-k-pick' : ''}>{l}</span>)}</div>
      <div className="ia-k-content">{fromSidebar ? [icon('Projects', 'folder'), icon('Footage', 'folder')] : [<div key="it" className="ia-k-target">{icon(item, kind === 'drive' && item === sidebar ? 'drive' : kind)}</div>, icon(kind === 'library' ? 'Archive' : 'Projects', 'folder'), icon('Photos', 'folder')]}</div>
    </Win>
    <Browser className="ia-k-browser"><i className="ia-browser-drop"/></Browser>
    <div className="ia-k-ghost">{icon(item, kind === 'drive' && item === sidebar ? 'drive' : kind)}</div>
    <Arrow className="ia-k-arrow" d={fromSidebar ? `M${aim[0] * 10 + 60} ${aim[1] * 10}C${aim[0] * 10 + 160} ${aim[1] * 10 + 10} 340 180 405 200` : 'M206 88C275 96 350 130 405 178'}/>
    <Cursor className="ia-k-cursor"/>
    <Marks at={fromSidebar ? [[11.7, rowY(sidebar) + .1], [40, 12.6]] : [[11.7, rowY(sidebar) + .1], [19.4, 5.6], [40, 12.6]]}/>
  </Frame>;
}

/** A5, once every clip is found: their names fly into this window, then the count with a check. */
export function Found({ names, total }: { names: string[]; total: number }) {
  const still = !!useReducedMotion();
  return <Frame className="ia-found">
    <Browser className="ia-found-browser"><motion.div className="ia-found-count" initial={still ? false : { opacity: 0, scale: .8 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 18, delay: .5 + Math.min(6, names.length) * .14 }}>
      <span className="ia-fd-check"><Check/></span><b>{total} of {total}</b><small>clips found</small></motion.div></Browser>
    {!still && names.slice(0, 6).map((n, i) => <span key={n + i} className="ia-chip" style={{ top: `${9 + i * 3.4}em`, animationDelay: `${.1 + i * .14}s` }}>{n}</span>)}
  </Frame>;
}

/** A6: how fast this connection sends. The needle follows each sample on a spring; the number counts up once it settles. */
export function Gauge({ bytesPerSecond, settled, failed }: { bytesPerSecond: number; settled: boolean; failed?: boolean }) {
  const reduced = useReducedMotion(), mbps = bytesPerSecond / 1e6, share = failed ? 0 : Math.min(1, Math.sqrt(Math.max(0, mbps) / 16)), [shown, setShown] = useState(0);
  useEffect(() => { if (!settled || failed) return; if (reduced) { setShown(mbps); return; } const run = animate(0, mbps, { duration: .9, ease: [.22, 1, .36, 1], onUpdate: setShown }); return () => run.stop(); }, [settled, failed, mbps, reduced]);
  const spring = { type: 'spring' as const, stiffness: 120, damping: 18 };
  return <Frame className="ia-gauge"><svg viewBox="0 0 600 400">
    <path d="M110 300A190 190 0 0 1 490 300" fill="none" stroke="#202428" strokeWidth="30" strokeLinecap="round"/>
    <motion.path d="M110 300A190 190 0 0 1 490 300" fill="none" stroke="#bce8c7" strokeWidth="30" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: Math.max(.001, share), opacity: share ? 1 : 0 }} transition={spring}/>
    {[0, .25, .5, .75, 1].map(t => { const a = Math.PI * (1 - t); return <line key={t} x1={300 + Math.cos(a) * 222} y1={300 - Math.sin(a) * 222} x2={300 + Math.cos(a) * 234} y2={300 - Math.sin(a) * 234} stroke="#485c4d" strokeWidth="3" strokeLinecap="round"/>; })}
    <motion.g initial={{ rotate: -90 }} animate={{ rotate: -90 + 180 * share }} transition={spring}><rect x="294" y="112" width="12" height="376" fill="none"/><path d="M300 128L306 300H294z" fill="#e1e6df"/></motion.g>
    <circle cx="300" cy="300" r="13" fill="#e1e6df"/><circle cx="300" cy="300" r="5" fill="#151a18"/>
    <text x="110" y="344" className="ia-gauge-end">slow</text><text x="490" y="344" className="ia-gauge-end">fast</text>
    {settled ? failed ? <text x="300" y="368" className="ia-gauge-note">Couldn't check</text> : <text x="300" y="372" className="ia-gauge-value">{shown.toFixed(1)}<tspan className="ia-gauge-unit"> MB/s</tspan></text> : <text x="300" y="368" className="ia-gauge-note">Checking…</text>}
  </svg></Frame>;
}

/** A7: one SharedCut track (V1–V4) per lane that is sending, its clip filling mint; each finished file snaps onto the timeline below. */
export type Lane = { id: string; name: string; share: number } | undefined;
const WAIT = { offline: [WifiOff, 'Waiting for Wi‑Fi'], server: [CloudOff, 'Waiting for SharedCut'], full: [HardDrive, 'SharedCut is out of room'] } as const;
export function Lanes({ lanes, done, total, state }: { lanes: Lane[]; done: { id: string; name: string; size: number }[]; total: number; state: '' | 'dim' | keyof typeof WAIT }) {
  const wait = state && state !== 'dim' ? WAIT[state] : undefined, Icon = wait?.[0];
  let x = 362;
  return <Frame className={`ia-lanes${state ? ` ${state === 'dim' ? 'dim' : 'waiting'}` : ''}`}>
    <div className="ia-l-tracks">{lanes.filter(lane => lane !== undefined).map((lane, i) => <div key={lane.id} className="ia-l-track"><b>V{i + 1}</b><div className="ia-l-body"><div key={lane.id} className="ia-l-clip"><span>{lane.name}</span><i style={{ clipPath: `inset(0 ${100 - Math.min(100, lane.share * 100)}% 0 0)` }}><span>{lane.name}</span></i></div></div></div>)}</div>
    {/* V1 runs from x 362 to 556 in the panel: each sent file takes its share of it, with its sound on A1. */}
    <svg className="ia-l-sent" viewBox="318 120 262 180"><Panel/>{done.map((d, i) => { const w = d.size / (total || 1) * 194, at = x; x += w;
      return <motion.g key={d.id} initial={{ y: -36, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 20 }}><rect x={at} y="184" width={Math.max(3, w - 2)} height="14" rx="3" fill={CLIP_COLORS[i % CLIP_COLORS.length]}/><rect x={at} y="220" width={Math.max(3, w - 2)} height="10" rx="3" fill="#87C9AC" opacity=".75"/></motion.g>; })}</svg>
    {wait && Icon && <div className="ia-l-wait"><div className="ia-l-link"><Laptop/><i/><img src="/brand/sharedcut-logo-colored.png" alt=""/></div><span className="ia-l-pill"><Icon/>{wait[1]}</span></div>}
  </Frame>;
}

/** A8: the sent clips, striped while SharedCut prepares them, each with its name and a spinner that turns into a check. */
export function Preparing({ clips }: { clips: { id: string; name: string; ready: boolean; failed: boolean; thumbnail?: string }[] }) {
  // Tiles sized to the clips (up to six a row): two clips read as two clips, not two specks in an empty panel.
  return <Frame className="ia-prep"><div className="ia-p-grid" style={{ '--n': Math.max(1, Math.min(6, clips.length)) } as CSSProperties}>{clips.slice(0, 24).map((c, i) => <figure key={c.id} className={c.failed ? 'failed' : c.ready ? 'ready' : ''}>
    <span style={{ transitionDelay: `${(i % 6) * .05}s` }}>{c.ready && c.thumbnail && <img src={c.thumbnail} alt=""/>}</span>
    <figcaption>{c.ready ? <Check className="ia-p-done"/> : c.failed ? <AlertTriangle className="ia-p-failed"/> : <i className="ia-p-spin"/>}<span>{c.name}</span></figcaption>
  </figure>)}</div></Frame>;
}

/** A9: the project drops into the class's Projects grid, glows and gets its check; 20 sparks, unless motion is reduced. */
const CLASSMATES = ['Soccer Highlights', 'Science Fair', 'Field Trip', 'Drama Club', 'Morning News'];
const Strip = ({ bars = 4 }: { bars?: number }) => <svg viewBox="0 0 40 24">{[<rect key="a" x="4" y="8" width="14" height="5" rx="1" fill="#78AAEF"/>, <rect key="b" x="4" y="15" width="24" height="4" rx="1" fill="#87C9AC"/>, <rect key="c" x="19" y="8" width="17" height="5" rx="1" fill="#78AAEF"/>, <rect key="d" x="8" y="3" width="10" height="4" rx="1" fill="#B298F5"/>].slice(0, bars)}</svg>;
export function Arrived({ name }: { name: string }) {
  const still = !!useReducedMotion();
  return <Frame className="ia-arrived">
    <div className="ia-a-grid">{[0, 1, 2, 3, 4, 5].map(i => i ? <span key={i} className="ia-a-other"><span className="ia-a-cover"><Strip bars={2 + i % 2}/></span><b>{CLASSMATES[i - 1]}</b></span> : <motion.div key={i} className="ia-a-new" initial={still ? false : { y: -90, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 18, delay: .2 }}>
      <div className="ia-a-cover"><Strip/></div><b>{name}</b>
      <motion.svg className="ia-a-check" viewBox="0 0 24 24" initial={still ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 15, delay: .75 }}><circle cx="12" cy="12" r="11"/><path d="M7 12.5l3.2 3.2L17 9"/></motion.svg>
      {!still && Array.from({ length: 20 }, (_, p) => { const a = p / 20 * Math.PI * 2, r = 70 + (p * 37 % 50); return <motion.i key={p} className="ia-a-spark" style={{ background: ['#bce8c7', '#78AAEF', '#B298F5', '#87C9AC', '#EBC876'][p % 5] }} initial={{ x: 0, y: 0, opacity: 0 }} animate={{ x: Math.cos(a) * r, y: Math.sin(a) * r * .7, opacity: [0, 1, 0], scale: [1, 1, .4] }} transition={{ duration: .9, delay: .8, ease: 'easeOut' }}/>; })}
    </motion.div>)}</div>
  </Frame>;
}

/** Blocked on a phone or tablet: the phone fades out and a MacBook, SharedCut on its screen, fades in. */
export function DeviceSwap() {
  return <Frame className="ia-swap"><svg viewBox="0 0 600 400"><defs><radialGradient id="ia-glow"><stop offset="0" stopColor="#bce8c7" stopOpacity=".3"/><stop offset="1" stopColor="#bce8c7" stopOpacity="0"/></radialGradient></defs>
    <g className="ia-s-phone"><rect x="255" y="90" width="90" height="180" rx="16" className="ia-shell lit"/><rect x="263" y="104" width="74" height="146" rx="6" fill="#101214"/><rect x="263" y="104" width="74" height="146" rx="6" fill="url(#ia-glow)"/><rect x="286" y="96" width="28" height="4" rx="2" fill="#303438"/></g>
    <g className="ia-s-mac"><rect x="150" y="96" width="300" height="190" rx="12" className="ia-shell lit"/><rect x="161" y="107" width="278" height="166" rx="4" fill="#101214"/><rect x="161" y="107" width="278" height="166" rx="4" fill="url(#ia-glow)"/><path d="M128 290h344l-16 14H144z" className="ia-shell lit"/>
      <image href="/brand/sharedcut-logo-colored.png" x="283" y="166" width="34" height="34"/></g>
  </svg></Frame>;
}

/** Blocked on a browser too old for the page: a browser window with an update badge. */
export function BrowserUpdate() {
  return <Frame className="ia-update"><Browser className="ia-u-browser"><span className="ia-u-badge"><ArrowUp/></span><span className="ia-u-label">Software Update</span></Browser></Frame>;
}

/** "Reading your project…": clip bars assembling into a strip. */
export const ReadingStrip = () => <span className="ia-reading" aria-hidden="true">{['#78AAEF', '#B298F5', '#78AAEF', '#87C9AC', '#78AAEF'].map((c, i) => <i key={i} style={{ background: c, animationDelay: `${i * .12}s` }}/>)}</span>;

/** A3: the export's document turns into a mint check with a ring burst. */
export function GotIt() {
  const still = !!useReducedMotion();
  return <svg className="ia-gotit" viewBox="0 0 56 56" aria-hidden="true">
    {!still && <motion.path d="M17 9h15l8 8v30H17z" fill="none" stroke="#90979c" strokeWidth="2" initial={{ opacity: 1 }} animate={{ opacity: 0, scale: .7 }} transition={{ duration: .25 }}/>}
    {!still && <motion.circle cx="28" cy="28" r="20" fill="none" stroke="#bce8c7" strokeWidth="2" initial={{ scale: .6, opacity: .9 }} animate={{ scale: 1.5, opacity: 0 }} transition={{ duration: .55, delay: .2 }}/>}
    <motion.circle cx="28" cy="28" r="20" fill="#223c2d" initial={still ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ duration: .3, delay: .15 }}/>
    <motion.path d="M19 28.5l6.2 6.2L37.5 22" fill="none" stroke="#bce8c7" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" initial={still ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .4, delay: .25 }}/>
  </svg>;
}
