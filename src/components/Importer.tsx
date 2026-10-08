// sharedcut.com/importer: a Final Cut project and its footage, from a person's own Mac into SharedCut over Wi-Fi.
// One thing per screen: who you are, the export, the footage, a Wi-Fi check, the upload. It loads without the editor:
// only api, upload, importer, ui, motion and lucide. Files stay in refs and are read only when matched and sent.
// "Wi‑Fi" is written with a non-breaking hyphen (U+2011) everywhere it is shown, so it never breaks as "Wi-" / "Fi".
import { Component, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, MotionConfig, animate, motion, useReducedMotion } from 'motion/react';
import { AlertTriangle, AppWindow, ArrowRight, Check, Clapperboard, Coffee, Copy, Eye, EyeOff, FileText, Folder, HardDrive, Laptop, Pause, Play, Plug, RotateCcw, Share, Type } from 'lucide-react';
import { Avatar, Brand, Button } from './ui';
import { api, ApiError } from '../services/api';
import { bytes, fingerprintOf, uploadImport, type ImportProgress } from '../services/upload';
import { assignFonts, checkFile, estimateSeconds, fontKey, friendlyDuration, lanesFor, matchSources, measureSpeed, nameKey, places, walk, type Check as FileCheck, type Found, type Place, type Source, type Speed } from '../services/importer';
import type { FcpImport, User } from '../state/models';
import { Arrived, BrowserUpdate, DeviceSwap, ExportScene, FinderScene, FontDone, FontScene, Found as FoundScene, Gauge, GotIt, Handoff, Lanes, NameTag, Preparing, ReadingStrip, Received, type Lane } from './ImporterArt';
import './importer.css';

type Me = { user: User | null; code: boolean; offline?: boolean };
type Dry = { projectId: string; name: string; duration: number; state: 'new' | 'resume' | 'changed' | 'deleted'; media: Source[]; missingFonts: string[]; warnings: string[]; limit: boolean };
type Mode = 'new' | 'resume' | 'rebuild' | 'fresh' | 'continue';
type Job = { mode: Mode; projectId: string; name: string; sources: Source[]; fonts: string[]; warnings: string[]; sent?: { percent: number; bytes: number } };
type Step = 'blocked' | 'you' | 'export' | 'decide' | 'fonts' | 'footage' | 'check' | 'upload' | 'ready' | 'done';
type Polled = { fcpImport: FcpImport | null; media: (Source & { status: string; thumbnail?: string; error?: string })[] };
type Dropped = { entries: FileSystemEntry[]; files: File[] };
type Status = 'running' | 'paused' | 'locked' | 'signedOut' | 'stuck' | 'error';

const TITLE = 'Import from Final Cut · SharedCut';
// Export, Footage and Upload are steps 1 to 3, numbered in the rail as in each step's eyebrow; You and Done are its bookends.
const RAIL = ['You', 'Export', 'Footage', 'Upload', 'Done'];
const RAIL_AT: Record<Step, number> = { blocked: 0, you: 0, export: 1, decide: 1, fonts: 1, footage: 2, check: 3, upload: 3, ready: 3, done: 4 };
const WAITING = { offline: 'Waiting for Wi‑Fi', server: 'Waiting for SharedCut', full: 'SharedCut is out of room' };
const SPOKEN: Partial<Record<Step, string>> = { export: 'Step 1 of 3: Export your project', footage: 'Step 2 of 3: Find your footage', check: 'Step 3 of 3: Check your Wi‑Fi', decide: 'You have imported this project before', fonts: 'Your titles need fonts', upload: 'Uploading', ready: 'Uploaded. SharedCut is getting it ready', done: 'Your project is in SharedCut' };
const COLORS = ['#F06A70', '#B298F5', '#78AAEF', '#EBC876', '#87C9AC', '#ED99C4'];
const XML = /\.(fcpxml|xml)$/i, PACKAGE = /\.(fcpbundle|fcpxmld)$/i, FONT = /\.(ttf|otf|ttc|woff2?)$/i, VIDEO = /\.(mp4|mov|m4v|mxf|avi|mts|m2ts|mkv|webm|braw|r3d|crm)$/i;
const SIGN_IN = '/login?next=/importer';
// A phone, or an iPad that says Macintosh but has a touch screen.
const PHONE = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const OLD = typeof AbortSignal.any !== 'function' || !globalThis.crypto?.subtle || !('webkitGetAsEntry' in DataTransferItem.prototype);
const ON_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);

const bold = (text: string) => text.split('**').map((part, i) => i % 2 ? <strong key={i}>{part}</strong> : part);
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const clock = (s: number) => s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`;
const percentOf = (i?: FcpImport | null) => i?.total ? Math.floor(i.received * 100 / i.total) : 0;
const unit = (s: number) => s < 45 ? 0 : s < 5400 ? 1 : 2;
const label = (fileName: string) => { const name = fileName.replace(/\.(fcpxmld|fcpxml|xml)$/i, ''); return name && name !== 'Info' ? name : undefined; };
const entryFile = (entry: FileSystemEntry) => new Promise<File>((ok, no) => (entry as FileSystemFileEntry).file(ok, no));
async function children(dir: FileSystemDirectoryEntry) {
  const reader = dir.createReader(), all: FileSystemEntry[] = [];
  for (;;) { const batch = await new Promise<FileSystemEntry[]>((ok, no) => reader.readEntries(ok, no)); if (!batch.length) return all; all.push(...batch); }
}
// item.webkitGetAsEntry() only works during the drop event, so this runs before anything awaits.
function grab(data: DataTransfer): Dropped {
  const entries: FileSystemEntry[] = []; let lost = false;
  for (const item of data.items) if (item.kind === 'file') { const entry = item.webkitGetAsEntry(); if (entry) entries.push(entry); else lost = true; }
  return lost || !entries.length ? { entries: [], files: [...data.files] } : { entries, files: [] };
}
async function pool<T>(items: T[], width: number, run: (item: T) => Promise<void>) {
  let next = 0; await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) await run(items[next++]); }));
}
// The words each missing font sets in the edit (its first title), for the Fonts screen's finished picture.
async function titlesIn(file: File, families: string[]) {
  const words: Record<string, string> = {};
  try {
    const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
    for (const def of doc.querySelectorAll('text-style-def')) {
      const family = families.find(f => fontKey(f) === fontKey(def.querySelector('text-style')?.getAttribute('font') ?? '')), text = family && !words[family] && doc.querySelector(`text-style[ref="${CSS.escape(def.id)}"]`)?.textContent?.trim();
      if (family && text) words[family] = text;
    }
  } catch { /* the picture shows the project's name instead */ }
  return words;
}
const message = (error: unknown) => error instanceof ApiError ? error.message : "We couldn't reach SharedCut. Check your Wi‑Fi, then try again.";

/** A number that rolls to each new value; `start` is where it rolls from when it first appears. */
function Count({ value, start = value, duration = .4 }: { value: number; start?: number; duration?: number }) {
  const reduced = useReducedMotion(), [shown, setShown] = useState(reduced ? value : start), from = useRef(start);
  useEffect(() => { if (reduced) { setShown(value); return; } const run = animate(from.current, value, { duration, onUpdate: v => setShown(Math.round(v)) }); from.current = value; return () => run.stop(); }, [value, reduced]);
  return <>{shown}</>;
}
function Ring({ done, total }: { done: number; total: number }) {
  const length = 2 * Math.PI * 15, complete = total > 0 && done >= total;
  return <svg className={`importer-ring${complete ? ' complete' : ''}`} viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15"/><circle cx="18" cy="18" r="15" className="fill" strokeDasharray={length} strokeDashoffset={length * (1 - (total ? done / total : 0))}/>{complete && <path d="M12 18.5l4 4 8-8.5"/>}</svg>;
}
function Title({ focus, children }: { focus: boolean; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  // Without scrolling, and the page back at its top: zoomed in, a focus scroll hides the stage and the rail.
  useEffect(() => { if (focus) { ref.current?.focus({ preventScroll: true }); ref.current?.closest('.importer')?.scrollTo(0, 0); } }, []);
  return <h1 ref={ref} tabIndex={-1} id="importer-title">{children}</h1>;
}
const Alert = ({ id, children }: { id?: string; children: ReactNode }) => <div id={id} className="importer-alert" role="alert"><AlertTriangle size={18}/><div>{children}</div></div>;

/**
 * "Save my account": the guest becomes a full account under the same id, so everything it imported stays its own. `saved`,
 * the email it was saved with, lives in the page: saving makes her a member, which redraws the screen around this form.
 */
function Claim({ user, projectId, saved, onSaved }: { user: User; projectId?: string; saved: string; onSaved: (user: User) => void }) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [show, setShow] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (saved) return <div className="importer-claim saved"><p role="status"><Check size={18}/><span>All set. Next time, sign in at sharedcut.com with <strong>{saved}</strong>.</span></p><a className="button button-primary importer-big" href={projectId ? `/project/${encodeURIComponent(projectId)}` : '/'}>Open in SharedCut</a></div>;
  return <form className="importer-claim" onSubmit={async event => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { const r = await api<{ user: User }>('/auth/signup', { method: 'POST', body: JSON.stringify({ name: user.name, email: email.trim(), password, upgradeGuest: true }) }); onSaved(r.user); }
    catch (e) { setError(e instanceof ApiError && e.status === 409 ? 'That email already has a SharedCut account. Sign in with it; your class project is already there for you to edit.' : message(e)); }
    finally { setBusy(false); }
  }}>
    <label className="form-field"><span>Email</span><input className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@school.org"/></label>
    <label className="form-field"><span>Password</span><span className="importer-password"><input className="input" type={show ? 'text' : 'password'} autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} aria-describedby="claim-hint"/><button type="button" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)}>{show ? <EyeOff size={17}/> : <Eye size={17}/>}</button></span></label>
    <small id="claim-hint">8 or more characters.</small>
    {error && <Alert>{error}</Alert>}
    <Button type="submit" variant="primary" className="importer-big" disabled={busy}>{busy ? 'Saving…' : 'Save my account'}</Button>
  </form>;
}

function Importer() {
  const blocked = PHONE ? 'phone' : OLD ? 'old' : undefined;
  const [step, setStep] = useState<Step>(blocked ? 'blocked' : 'you');
  const [me, setMe] = useState<Me>(), [newGuest, setNewGuest] = useState(false), [imports, setImports] = useState<{ projectId: string; name: string; fcpImport: FcpImport }[]>([]);
  const [maxBytes, setMaxBytes] = useState(10 * 1024 ** 3), [replay, setReplay] = useState(0), [said, setSaid] = useState(''), [toast, setToast] = useState(''), [dragging, setDragging] = useState(false);
  const [name, setName] = useState(''), [code, setCode] = useState(''), [color] = useState(() => COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [youError, setYouError] = useState<{ text: string; code?: boolean }>(), [busy, setBusy] = useState(false), [shaking, setShaking] = useState(false), [claim, setClaim] = useState(false), [savedAs, setSavedAs] = useState('');
  // over: which drop target a drag is over ('export' for the drop card, `place-N` for a footage row), '' for none.
  const [reading, setReading] = useState(false), [over, setOver] = useState(''), [xml, setXml] = useState<{ file: File; name?: string; fresh?: boolean }>(), [dry, setDry] = useState<Dry>(), [exportError, setExportError] = useState<{ text: ReactNode; fresh?: boolean; claim?: boolean }>();
  const [job, setJobState] = useState<Job>(), [added, setAdded] = useState<Set<string>>(new Set()), [fontErrors, setFontErrors] = useState<Record<string, string>>({}), [titles, setTitles] = useState<Record<string, string>>({});
  // misses: footage drops that found nothing new. Leaving clips out is offered once something is found, or after two.
  const [forget, setForget] = useState(false), [misses, setMisses] = useState(0);
  const [placeList, setPlaceList] = useState<Place[]>([]), [walking, setWalking] = useState<{ name: string; count: number }>(), [checking, setChecking] = useState<{ done: number; total: number }>(), [notes, setNotes] = useState<string[]>([]);
  const [flights, setFlights] = useState<{ key: string; name: string; from: [number, number]; to: [number, number]; i: number }[]>([]), [copied, setCopied] = useState('');
  const [speed, setSpeed] = useState<Speed>(), [sample, setSample] = useState(0), [probing, setProbing] = useState(false), [share, setShare] = useState(true), [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>(), [noRoom, setNoRoom] = useState<{ needed: number; room: number }>();
  const [progress, setProgress] = useState<ImportProgress>(), [status, setStatus] = useState<Status>('running'), [awake, setAwake] = useState(false), [began, setBegan] = useState(0), [nudge, setNudge] = useState(false), [showClips, setShowClips] = useState(false);
  const [polled, setPolled] = useState<Polled>(), [failed, setFailed] = useState<{ id: string; reason: string }[]>([]);
  const [, render] = useReducer((n: number) => n + 1, 0);
  const reduced = useReducedMotion();
  // Matching state lives in a ref: walks, checks and the upload read and change it across awaits.
  // lengths: each same-named candidate's check against its source (`id:path`), so the chooser can say which one matches.
  const foot = useRef({ pool: new Map<string, Found>(), found: {} as Record<string, Found>, checks: {} as Record<string, FileCheck | 'checking'>, use: new Set<string>(), ambig: {} as Record<string, Found[]>, lost: new Set<string>(), lengths: new Map<string, FileCheck | 'checking'>() }).current;
  const jobRef = useRef(job), stepRef = useRef(step), moved = useRef(false), held = useRef<{ xml?: FileSystemEntry | File; fonts: File[]; footage: Dropped[] }>({ fonts: [], footage: [] });
  const imported = useRef(''), ids = useRef(new Map<string, string>()), items = useRef<{ assetId: string; file: File; fingerprint?: string }[]>([]), control = useRef<AbortController>(undefined), wake = useRef<WakeLockSentinel>(undefined), fontFor = useRef<string | undefined>(undefined);
  const etaShown = useRef<{ at: number; value?: number }>({ at: 0 }), decile = useRef(0), announced = useRef(new Set<string>());
  // A found file's fingerprint, taken when it was found and could be read: Safari re-reads a date it can no longer read as now.
  const prints = useRef(new WeakMap<File, string>()).current, nameField = useRef<HTMLInputElement>(null), codeField = useRef<HTMLInputElement>(null);
  const xmlInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null), fontInput = useRef<HTMLInputElement>(null), intake = useRef<(d: Dropped, point?: [number, number]) => void>(() => {});
  stepRef.current = step;
  const statusRef = useRef(status); statusRef.current = status;
  const user = me?.user ?? undefined, guest = user?.guest === true, first = user?.name.split(' ')[0] ?? '';
  // Who sees "Save my account" and its "All set": a guest, and for the rest of this import the guest who just saved it.
  const claimant = guest || !!savedAs;
  const setJob = (next: Job | undefined) => { jobRef.current = next; setJobState(next); };
  const say = (text: string) => setSaid(current => current === text ? `${text} ` : text);
  const note = (text: string) => { setToast(text); say(text); };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(c => c === text ? '' : c), 2000); }, () => {});
  const go = (next: Step) => { moved.current = true; stepRef.current = next; setStep(next); const spoken = SPOKEN[next]; if (spoken) say(spoken); };
  const real = (id: string) => ids.current.get(id) ?? id;
  const dryOf = (id: string) => { for (const [from, to] of ids.current) if (to === id) return from; return id; };

  // ---- Session -------------------------------------------------------------------------------------------------
  const loadSession = async () => {
    await Promise.all([api<{ imports: typeof imports }>('/fcp/import').then(r => setImports(r.imports), () => {}), api<{ maxUploadBytes: number }>('/uploads/info').then(r => setMaxBytes(r.maxUploadBytes), () => {})]);
  };
  useEffect(() => {
    document.title = TITLE;
    if (blocked) return;
    void api<{ user: User | null; registrationRequiresCode: boolean }>('/auth/me').then(r => { setMe({ user: r.user, code: r.registrationRequiresCode }); if (r.user) void loadSession(); }, () => setMe({ user: null, code: false, offline: true }));
  }, []);
  // The name field takes focus as the form appears (before paint, so typing at once lands there), without scrolling the stage away.
  useLayoutEffect(() => { if (me && !me.user && !me.offline) nameField.current?.focus({ preventScroll: true }); }, [me]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer); }, [toast]);
  const signOut = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); };
  const startGuest = async () => {
    if (busy || !name.trim()) return; setBusy(true); setYouError(undefined);
    try {
      const r = await api<{ user: User }>('/auth/guest', { method: 'POST', body: JSON.stringify({ name: name.trim(), inviteCode: code, color }) });
      setMe(current => ({ code: false, ...current, user: r.user })); setNewGuest(true); await loadSession(); begin();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) { setYouError({ text: "That code didn't work. Check it with your teacher and try again.", code: true }); setShaking(true); codeField.current?.focus(); codeField.current?.select(); }
      else setYouError({ text: e instanceof ApiError && e.status === 429 ? 'Too many tries from this network. Wait a few minutes, then try again.' : message(e) });
    } finally { setBusy(false); }
  };
  // Let's start: the export step, reading a project file dropped before the person said who they are.
  const begin = () => { go('export'); const x = held.current.xml; held.current.xml = undefined; if (x) void readExport(x); };
  const reset = () => {
    control.current?.abort('pause'); setSavedAs(''); setDry(undefined); setXml(undefined); setExportError(undefined); setJob(undefined); setAdded(new Set()); setFontErrors({}); setTitles({}); setPlaceList([]); setNotes([]);
    foot.pool.clear(); foot.found = {}; foot.checks = {}; foot.use.clear(); foot.ambig = {}; foot.lost.clear(); foot.lengths.clear(); announced.current.clear();
    setSpeed(undefined); setProgress(undefined); setFailed([]); setPolled(undefined); setStartError(undefined); setNoRoom(undefined); setStatus('running'); setNudge(false); setShowClips(false); setMisses(0); setForget(false);
    imported.current = ''; ids.current.clear(); items.current = []; decile.current = 0; etaShown.current = { at: 0 };
  };

  // ---- Export ----------------------------------------------------------------------------------------------------
  const packed = () => { setExportError({ text: "Your browser packed that file. Drag it in from your Desktop instead. It's easier." }); setReplay(n => n + 1); };
  const readXml = async (file: File, name: string | undefined, fresh = false) => {
    setExportError(undefined); setDry(undefined); setClaim(false);
    if (/\.zip$/i.test(file.name) || PACKAGE.test(file.name) || !file.size) return packed();
    if (file.size > 95e6) return setExportError({ text: 'This project file is too big to send over the internet. Ask your teacher to import it at school.' });
    setXml({ file, name, fresh }); setReading(true);
    const query = new URLSearchParams({ dry: '1', ...(name && { name }), ...(fresh && { fresh: '1' }) });
    try {
      const result = await api<Dry>(`/fcp/import?${query}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/xml' } });
      setDry(result);
      if (result.limit) setExportError({ text: "You've imported 5 projects as a guest. Save your account to import more.", claim: true });
      else say(`Got it: ${result.name}, ${plural(result.media.length, 'clip')}`);
    } catch (e) {
      if (!(e instanceof ApiError)) setExportError({ text: message(e) });
      else if (e.status === 400) setExportError({ text: /No project in that XML/.test(e.message) ? "This file has clips but no project. In Final Cut, click the project (the timeline icon) in Final Cut's Browser, then export again." : <>Final Cut's file didn't open. Export it again with <strong>File › Export XML…</strong>, then drop the new one.</> });
      else if (e.status === 413) setExportError({ text: 'This project file is too big to send over the internet. Ask your teacher to import it at school.' });
      else if (e.status === 403 || e.status === 404) setExportError({ text: 'That project belongs to someone else in SharedCut.', fresh: true });
      else if (e.status === 401) { setMe(current => current && { ...current, user: null }); go('you'); }
      else setExportError({ text: e.message });
    } finally { setReading(false); }
  };
  const readExport = async (item: FileSystemEntry | File) => {
    if (item instanceof File) return readXml(item, label(item.name));
    try {
      if (item.isFile) return readXml(await entryFile(item), label(item.name));
      // An .fcpxmld is a folder: Info.fcpxml, or its only .fcpxml (the rule readFcpBundle uses).
      const inside = (await children(item as FileSystemDirectoryEntry)).filter(e => e.isFile && /\.fcpxml$/i.test(e.name)), info = inside.find(e => e.name === 'Info.fcpxml') ?? (inside.length === 1 ? inside[0] : undefined);
      if (!info) return setExportError({ text: <>Final Cut's file didn't open. Export it again with <strong>File › Export XML…</strong>, then drop the new one.</> });
      return readXml(await entryFile(info), label(item.name));
    } catch { packed(); }
  };
  // Something other than the export arrived on the export step.
  const notTheExport = (names: string[]) => {
    if (names.some(n => /\.fcpbundle$/i.test(n))) setExportError({ text: <>That's your whole Final Cut library. First choose <strong>File › Export XML…</strong> in Final Cut, then drop the file it saves.</> });
    else if (names.some(n => /\.zip$/i.test(n))) packed();
    else setExportError({ text: <>{names.some(n => VIDEO.test(n)) ? "That's a video. " : "That's not the export. "}We need the file Final Cut makes with <strong>File › Export XML…</strong> (it ends in .fcpxml or .fcpxmld).</> });
  };
  const afterExport = () => {
    if (!dry) return;
    if (dry.state === 'changed' || dry.state === 'deleted') return go('decide');
    choose(xml?.fresh ? 'fresh' : dry.state === 'resume' ? 'resume' : 'new');
  };
  const choose = (mode: Mode) => {
    if (!dry) return;
    // A separate copy is new media: nothing of it is on the server yet.
    const sources = mode === 'fresh' ? dry.media.map(m => ({ ...m, uploaded: false, received: 0 })) : dry.media;
    const next: Job = { mode, projectId: dry.projectId, name: dry.name, sources, fonts: mode === 'resume' ? [] : dry.missingFonts, warnings: dry.warnings };
    setJob(next);
    // Titles are measured with the library's fonts when the project is made, so fonts come before the import (not on a resume).
    if (next.fonts.length) { go('fonts'); if (xml) void titlesIn(xml.file, next.fonts).then(setTitles); const files = held.current.fonts.splice(0); if (files.length) void addFonts(files); }
    else footage(next);
  };

  // ---- Fonts -----------------------------------------------------------------------------------------------------
  const addFonts = async (files: File[], family?: string) => {
    const families = jobRef.current?.fonts ?? [], { uploads, unmatched } = assignFonts(families, files, family);
    if (unmatched.length) note(`Didn't need ${unmatched.map(f => f.name).join(', ')}.`);
    await Promise.all(uploads.map(async u => {
      try {
        await api(`/fonts?name=${encodeURIComponent(u.name)}`, { method: 'POST', body: u.file });
        // The Fonts screen sets the title in it too, from the file itself: no URL, so the page's font-src does not apply.
        for (const f of u.families) void u.file.arrayBuffer().then(data => new FontFace(f, data).load()).then(face => { document.fonts.add(face); }, () => {});
        setAdded(current => new Set([...current, ...u.families])); setFontErrors(current => { const next = { ...current }; for (const f of u.families) delete next[f]; return next; }); say(`${u.families.join(', ')} added`); }
      catch (e) { setFontErrors(current => ({ ...current, ...Object.fromEntries(u.families.map(f => [f, message(e)])) })); }
    }));
  };
  const fromThisMac = async () => {
    const families = (jobRef.current?.fonts ?? []).filter(f => !added.has(f)), files: File[] = [];
    try {
      const faces = await (window as unknown as { queryLocalFonts: () => Promise<{ family: string; fullName: string; blob: () => Promise<Blob> }[]> }).queryLocalFonts();
      for (const face of faces) {
        const family = families.find(f => fontKey(face.family) === fontKey(f) || fontKey(face.fullName).startsWith(fontKey(f)));
        if (family) files.push(new File([await face.blob()], `${face.fullName}.otf`));
      }
    } catch { return note("This browser didn't share its fonts. Drag the font files here instead."); }
    if (!files.length) return note("Those fonts aren't on this Mac. Drag the font files here instead.");
    await addFonts(files);
  };

  // ---- Footage ---------------------------------------------------------------------------------------------------
  const footage = (next: Job) => {
    const missing = next.sources.filter(s => !s.uploaded);
    if (!missing.length) return void importOnly(next);
    setPlaceList(places(missing)); go('footage');
    for (const d of held.current.footage.splice(0)) void addFootage(d);
  };
  const sourceOf = (id: string) => jobRef.current?.sources.find(s => s.id === id);
  const stateOf = (id: string): 'ok' | 'checking' | 'missing' | 'ambiguous' | FileCheck['state'] => {
    if (foot.lost.has(id)) return 'unreadable';
    const found = foot.found[id], check = foot.checks[id];
    if (!found) return foot.ambig[id] ? 'ambiguous' : 'missing';
    if (!check || check === 'checking') return 'checking';
    return check.state === 'different' && foot.use.has(id) ? 'ok' : check.state;
  };
  const needs = (id: string) => !['ok', 'tooBig', 'checking'].includes(stateOf(id));
  const recheck = async (changed: string[]) => {
    if (!changed.length) return;
    let done = 0; setChecking({ done, total: changed.length });
    await pool(changed, 8, async id => {
      const found = foot.found[id], source = sourceOf(id); foot.checks[id] = 'checking'; render();
      const result = await checkFile(found.file, source?.kind, source?.duration, maxBytes);
      if (foot.found[id] === found) { foot.checks[id] = result; if (result.state === 'ok') foot.lost.delete(id); }
      setChecking({ done: ++done, total: changed.length }); render();
    });
    setChecking(undefined);
  };
  // Every source that still needs a file takes the found file whose path agrees most with where it was.
  const rematch = () => {
    const current = jobRef.current, changed: string[] = [];
    if (!current) return changed;
    for (const m of matchSources(current.sources, [...foot.pool.values()])) {
      if (!needs(m.id)) continue;
      // A file this source already has here failed its check (a different clip, or one that won't open), so it is not the
      // answer to a tie: the only other candidate is, and several others go to the chooser.
      const tried = foot.found[m.id]?.file, others = m.state === 'ambiguous' ? m.candidates!.filter(c => c.file !== tried) : [];
      const pick = m.state === 'found' ? m.found! : others.length === 1 ? others[0] : undefined;
      if (pick && pick.file !== tried) { foot.found[m.id] = pick; delete foot.ambig[m.id]; delete foot.checks[m.id]; foot.lost.delete(m.id); changed.push(m.id); }
      else if (others.length > 1) { foot.ambig[m.id] = others; delete foot.found[m.id]; delete foot.checks[m.id]; foot.lost.delete(m.id); lengths(m.id, others); }
    }
    render(); return changed;
  };
  const lengths = (id: string, list: Found[]) => {
    const source = sourceOf(id);
    for (const c of list) { const key = `${id}:${c.path}`; if (foot.lengths.has(key)) continue; foot.lengths.set(key, 'checking'); void checkFile(c.file, source?.kind, source?.duration, maxBytes).then(r => { foot.lengths.set(key, r); render(); }); }
  };
  const pick = (id: string, c: Found) => { foot.found[id] = c; delete foot.checks[id]; render(); void recheck([id]); };
  const addFootage = async (d: Dropped, point?: [number, number]) => {
    const current = jobRef.current; if (!current) return;
    const found: Found[] = [], problems: string[] = [];
    const singles = [...d.entries.filter(e => e.isFile).map(e => e.name), ...d.files.filter(f => !f.webkitRelativePath).map(f => f.name)];
    for (const n of singles) { if (/\.zip$/i.test(n)) problems.push('zip'); else if (/\.fcpbundle$/i.test(n)) problems.push(`package:${n.replace(/\.fcpbundle$/i, '')}`); }
    const wanted = new Set(current.sources.filter(s => !s.uploaded && needs(s.id)).map(s => nameKey(s.name)));
    const title = (d.entries[0]?.name ?? d.files[0]?.webkitRelativePath.split('/')[0] ?? d.files[0]?.name ?? 'your files').replace(/\.fcpbundle$/i, '');
    if (d.entries.length) {
      setWalking({ name: title, count: 0 });
      try { found.push(...await walk(d.entries, wanted, count => setWalking({ name: title, count }))); } catch { problems.push('many'); }
      setWalking(undefined);
    }
    // Picked folders and loose files: the same rule, minus the caches and hidden files walk() skips.
    for (const file of d.files) { const path = file.webkitRelativePath || file.name; if (wanted.has(nameKey(file.name)) && !path.split('/').some(part => part.startsWith('.') || /^(Render Files|Transcoded Media|Analysis Files|Peaks Data|Thumbnail Media)$/.test(part))) found.push({ path, file }); }
    for (const f of found) { foot.pool.set(f.path, f); prints.set(f.file, fingerprintOf(f.file)); }
    setNotes(problems);
    const changed = rematch();
    setMisses(n => changed.length ? n : n + 1);
    if (point && !reduced && changed.length) {
      const flying = changed.slice(0, 12).flatMap((id, i) => {
        const row = placeList.findIndex(p => p.ids.includes(id)), box = document.getElementById(`importer-place-${row}`)?.getBoundingClientRect();
        return box ? [{ key: `${id}-${Date.now()}`, name: foot.found[id].file.name, from: point, to: [box.left + 28, box.top + box.height / 2] as [number, number], i }] : [];
      });
      setFlights(current => [...current, ...flying]);
    }
    await recheck(changed);
    if (stepRef.current === 'upload' && changed.some(id => stateOf(id) === 'ok')) restart();
  };
  // Say each place as it completes, once.
  useEffect(() => {
    if (step !== 'footage') return;
    placeList.forEach(p => { const n = p.ids.filter(id => stateOf(id) === 'ok').length; if (n === p.ids.length && !announced.current.has(p.path)) { announced.current.add(p.path); say(`${n} of ${p.ids.length} clips found in ${p.item}`); } });
  });

  // ---- Every drop, whatever step is showing ----------------------------------------------------------------------
  intake.current = (d, point) => {
    const s = stepRef.current; if (s === 'blocked') return;
    const isXml = (n: string, dir: boolean) => dir ? /\.fcpxmld$/i.test(n) : XML.test(n) || /\.fcpxmld$/i.test(n);
    const xmls = [...d.entries.filter(e => isXml(e.name, e.isDirectory)), ...d.files.filter(f => isXml(f.name, false))];
    const fontEntries = d.entries.filter(e => e.isFile && FONT.test(e.name)), fontFiles = d.files.filter(f => FONT.test(f.name));
    const rest: Dropped = { entries: d.entries.filter(e => !xmls.includes(e) && !fontEntries.includes(e)), files: d.files.filter(f => !xmls.includes(f) && !fontFiles.includes(f)) };
    const early = s === 'you' || s === 'export' || s === 'decide' || s === 'fonts';
    if (xmls.length) {
      if (!early) note('We already have your project file. Drag your footage folders here.');
      else if (!user) { held.current.xml = xmls[0]; note('Got your project file. Tell us your name first.'); }
      else { if (s !== 'export') { reset(); go('export'); } void readExport(xmls[0]); }
    }
    if (fontEntries.length || fontFiles.length) void Promise.all(fontEntries.map(e => entryFile(e).catch(() => undefined))).then(files => {
      const all = [...files.filter((f): f is File => !!f), ...fontFiles];
      if (stepRef.current === 'fonts') void addFonts(all); else if (early) held.current.fonts.push(...all); else note(`Didn't need ${all.map(f => f.name).join(', ')}.`);
    });
    if (!rest.entries.length && !rest.files.length) return;
    if (s === 'footage' || s === 'check' || s === 'upload') return void addFootage(rest, point);
    if (!early) return;
    held.current.footage.push(rest);
    const names = [...rest.entries.map(e => e.name), ...rest.files.map(f => f.name)];
    if (!xmls.length && user && (s === 'export' || s === 'you') && !dry) { if (s === 'you') go('export'); notTheExport(names); }
    else if (!xmls.length) note(user ? "Got it. We'll look through that when we find your footage." : 'Tell us your name first, then drag that in again.');
  };
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    // Always: a drop the page misses makes Safari open the file in this tab.
    const overWindow = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const drop = (e: DragEvent) => { e.preventDefault(); depth = 0; setDragging(false); setOver(''); if (e.dataTransfer) intake.current(grab(e.dataTransfer), [e.clientX, e.clientY]); };
    addEventListener('dragenter', enter); addEventListener('dragleave', leave); addEventListener('dragover', overWindow); addEventListener('drop', drop);
    return () => { removeEventListener('dragenter', enter); removeEventListener('dragleave', leave); removeEventListener('dragover', overWindow); removeEventListener('drop', drop); };
  }, []);

  // ---- Check -----------------------------------------------------------------------------------------------------
  const remaining = job?.sources.filter(s => !s.uploaded) ?? [];
  const planned = remaining.filter(s => stateOf(s.id) === 'ok');
  const sizes = planned.map(s => foot.found[s.id].file.size), left = planned.map((s, i) => Math.max(0, sizes[i] - (s.received ?? 0)));
  const total = sizes.reduce((a, b) => a + b, 0), toSend = left.reduce((a, b) => a + b, 0), already = (job?.sources.length ?? 0) - remaining.length;
  const lanes = speed ? lanesFor(speed.parallel, planned.length) : 1, seconds = speed ? estimateSeconds(left, speed.single, speed.parallel, lanes) : 0;
  const knownProject = imported.current || (job && job.mode !== 'new' && job.mode !== 'fresh' ? job.projectId : undefined);
  const probe = async () => {
    setProbing(true); setSpeed(undefined); setSample(0); setNoRoom(undefined);
    const result = await measureSpeed(Math.max(1, planned.length), { project: knownProject, onSample: setSample });
    setSpeed(result); setProbing(false); say(sentence(result));
  };
  // Konrad's sentence: what a screen reader hears once the check settles (the screen shows the time large instead).
  const sentence = (s: Speed) => {
    const secs = estimateSeconds(left, s.single, s.parallel, lanesFor(s.parallel, planned.length)), when = friendlyDuration(secs);
    return !s.measured ? `We couldn't check your Wi‑Fi. At a typical school speed it might take ${when.replace(/^about /, 'roughly ')}.`
      : `${already > 0 ? `${already} of ${job!.sources.length} clips are already in SharedCut. ${bytes(toSend)} left: ${when}.` : `This project is ${bytes(total)}. It might take ${when} to upload to SharedCut${secs > 3600 ? ' if your Wi‑Fi stays like this' : ''}.`} Your Wi‑Fi is sending about ${(s.parallel / 1e6).toFixed(1)} MB/s right now.`;
  };
  const toCheck = () => { go('check'); void probe(); };
  const roomShort = speed?.room !== undefined && toSend * 1.25 > speed.room ? { needed: toSend * 1.25, room: speed.room } : undefined;
  const short = noRoom ?? roomShort;

  // ---- Upload ----------------------------------------------------------------------------------------------------
  const holdAwake = () => {
    if (wake.current && !wake.current.released) return;
    void navigator.wakeLock?.request('screen').then(lock => { wake.current = lock; setAwake(true); lock.addEventListener('release', () => setAwake(false)); }, () => {});
  };
  const releaseAwake = () => { void wake.current?.release().catch(() => {}); wake.current = undefined; setAwake(false); };
  const planItems = () => (jobRef.current?.sources ?? []).filter(s => !s.uploaded && stateOf(s.id) === 'ok').map(s => { const file = foot.found[s.id].file; return { assetId: real(s.id), file, fingerprint: prints.get(file) }; });
  // The real import (once): skipped when the project already holds this edit (resume, continue).
  const createProject = async (current: Job) => {
    if (imported.current) return;
    if (current.mode === 'resume' || current.mode === 'continue' || !xml) { imported.current = current.projectId; return; }
    const query = new URLSearchParams({ ...(xml.name && { name: xml.name }), ...(current.mode === 'fresh' ? { fresh: '1' } : { projectId: current.projectId }), ...(current.mode === 'rebuild' && { rebuild: '1' }), ...((current.mode === 'new' || current.mode === 'fresh') && !guest && share && { class: '1' }) });
    const r = await api<{ projectId: string; warnings: string[]; media: { id: string; sourcePath?: string }[] }>(`/fcp/import?${query}`, { method: 'POST', body: xml.file, headers: { 'Content-Type': 'application/xml' } });
    imported.current = r.projectId;
    // A separate copy has new media ids: find each source's by its original path.
    if (current.mode === 'fresh') { const byPath = new Map(r.media.map(m => [m.sourcePath, m.id])); for (const s of current.sources) { const id = s.sourcePath && byPath.get(s.sourcePath); if (id) ids.current.set(s.id, id); } }
    setJob({ ...current, warnings: r.warnings });
  };
  // Nothing left to send (an update whose footage all arrived before): make the project, then wait for it.
  const importOnly = async (current: Job) => {
    try { await createProject(current); go('ready'); } catch (e) { note(message(e)); }
  };
  const start = async () => {
    const current = jobRef.current; if (!current) return;
    holdAwake(); setStarting(true); setStartError(undefined); setNoRoom(undefined);
    try {
      await createProject(current);
      items.current = planItems();
      if (!items.current.length) { releaseAwake(); return go('done'); }
      setProgress(undefined); setBegan(Date.now()); decile.current = 0; etaShown.current = { at: 0 }; go('upload'); void run();
    } catch (e) {
      releaseAwake();
      if (e instanceof ApiError && e.status === 403 && guest) { setStartError(e.message); setClaim(true); }
      else setStartError(message(e));
    } finally { setStarting(false); }
  };
  const run = async () => {
    const id = imported.current, width = lanesFor(speed?.parallel ?? 1.5e6, items.current.length);
    const going = async () => {
      for (;;) {
        const controller = new AbortController(); control.current = controller; setStatus('running');
        try {
          const result = await uploadImport(id, items.current, { lanes: width, signal: controller.signal, onProgress: p => { setProgress(p); for (const f of p.failed) if (f.reason === 'unreadable') foot.lost.add(dryOf(f.id)); } });
          setFailed(result.failed);
          if (result.failed.some(f => f.reason === 'unreadable')) { setStatus('stuck'); releaseAwake(); return; }
          releaseAwake(); return go('ready');
        } catch (e) {
          if (controller.signal.aborted) { if (controller.signal.reason === 'restart') { items.current = planItems(); continue; } setStatus('paused'); releaseAwake(); return; }
          releaseAwake();
          if (e instanceof ApiError && e.status === 401) return setStatus('signedOut');
          // The plan's refusals: no room (507), the guest cap (403), a file the server will not take.
          if (e instanceof ApiError && e.status === 507) { setNoRoom({ needed: e.data?.needed ?? 0, room: e.data?.room ?? 0 }); return go('check'); }
          if (e instanceof ApiError && [400, 403, 413].includes(e.status)) { setStartError(e.message); if (guest && e.status === 403) setClaim(true); return go('check'); }
          setStartError(message(e)); return setStatus('error');
        }
      }
    };
    // One tab per import: a second one would only fight the first for each file.
    if (navigator.locks) await navigator.locks.request(`sharedcut-import-${id}`, { ifAvailable: true }, async lock => { if (!lock) setStatus('locked'); else await going(); });
    else await going();
  };
  // A drop fixed a file that could not be read: send again with every file; the server keeps what already arrived.
  const restart = () => { const now = statusRef.current; if (now === 'running' && control.current && !control.current.signal.aborted) control.current.abort('restart'); else if (now === 'stuck' || now === 'paused') { items.current = planItems(); holdAwake(); void run(); } };
  const pause = () => control.current?.abort('pause');
  const resume = () => { holdAwake(); items.current = planItems(); void run(); };
  const sending = step === 'upload' && (status === 'running' || status === 'paused' || status === 'stuck') && !!progress && progress.bytes < progress.total;
  useEffect(() => {
    if (!sending) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    addEventListener('beforeunload', warn); return () => removeEventListener('beforeunload', warn);
  }, [sending]);
  useEffect(() => {
    if (step !== 'upload' || status !== 'running') return;
    const visible = () => { if (document.visibilityState === 'visible') holdAwake(); };
    document.addEventListener('visibilitychange', visible); return () => document.removeEventListener('visibilitychange', visible);
  }, [step, status]);
  useEffect(() => { if (step !== 'upload' || !guest) return; const timer = setTimeout(() => setNudge(true), 60_000); return () => clearTimeout(timer); }, [step, guest]);
  const percent = progress?.total ? Math.floor(progress.bytes * 100 / progress.total) : 0;
  useEffect(() => { document.title = step === 'upload' && progress ? `${percent}% · ${TITLE}` : TITLE; }, [step, percent, !!progress]);
  // The time left appears after 10 s, then changes at most every 5 s, and only by more than 10% or across a unit.
  const eta = (() => {
    const now = Date.now(), e = etaShown.current;
    if (!progress?.eta || !Number.isFinite(progress.eta) || now - began < 10_000) return undefined;
    if (e.value === undefined || (now - e.at >= 5000 && (Math.abs(progress.eta - e.value) > e.value * .1 || unit(progress.eta) !== unit(e.value)))) { e.value = progress.eta; e.at = now; }
    return e.value;
  })();
  useEffect(() => { if (step !== 'upload' || !progress) return; const d = Math.floor(percent / 10); if (d > decile.current) { decile.current = d; say(`${percent} percent${eta ? `, ${friendlyDuration(eta)} left` : ''}`); } }, [percent]);
  const unreadableNow = (progress?.failed ?? failed).filter(f => f.reason === 'unreadable').map(f => sourceOf(dryOf(f.id))?.name ?? 'a clip');
  const statusText: ReactNode = status === 'locked' ? 'This import is already running in another tab.'
    : status === 'signedOut' ? guest ? "Your guest session ended, so this browser can't finish the upload. Your class can still see what arrived." : 'You were signed out. Sign in again to continue.'
    : status === 'paused' ? 'Paused' : status === 'error' ? startError
    : progress?.waiting === 'offline' ? 'Wi‑Fi dropped. Waiting to reconnect… Your progress is saved.'
    : progress?.waiting === 'server' ? "SharedCut isn't answering right now. We'll keep trying, and nothing is lost."
    : progress?.waiting === 'full' ? "SharedCut ran out of room. Nothing is lost. Tell your teacher; it continues by itself when there's space."
    : unreadableNow.length ? <>We can't read <strong>{unreadableNow.join(', ')}</strong> anymore. Plug its drive back in and drag its folder here.</> : '';
  const statusKey = `${status}:${progress?.waiting ?? ''}:${unreadableNow.length}`;
  useEffect(() => { if (step === 'upload' && typeof statusText === 'string' && statusText) say(statusText); else if (step === 'upload' && unreadableNow.length) say(`We can't read ${unreadableNow.join(', ')} anymore.`); }, [statusKey]);

  // ---- Getting it ready, and done --------------------------------------------------------------------------------
  useEffect(() => {
    if (step !== 'ready' && step !== 'done') return;
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api<Polled>(`/fcp/import/${encodeURIComponent(imported.current)}`); if (stopped) return; setPolled(r);
        const sent = r.media.filter(m => m.uploaded);
        if (stepRef.current === 'ready' && (r.fcpImport ? r.fcpImport.phase === 'ready' : sent.every(m => m.status === 'ready' || m.status === 'failed'))) return go('done');
      } catch { /* keep asking */ }
      if (!stopped && stepRef.current === 'ready') timer = setTimeout(tick, document.hidden ? 10_000 : 3000);
    };
    void tick(); return () => { stopped = true; clearTimeout(timer); };
  }, [step]);

  const continueImport = async (projectId: string) => {
    reset();
    try {
      const r = await api<{ projectId: string; name: string; fcpImport: FcpImport | null; media: Source[] }>(`/fcp/import/${encodeURIComponent(projectId)}`);
      imported.current = r.projectId;
      const next: Job = { mode: 'continue', projectId: r.projectId, name: r.name, sources: r.media, fonts: [], warnings: [], sent: r.fcpImport ? { percent: percentOf(r.fcpImport), bytes: r.fcpImport.received } : undefined };
      setJob(next); footage(next);
    } catch (e) { note(message(e)); }
  };

  // ---- Screens ---------------------------------------------------------------------------------------------------
  const focus = moved.current;
  const savedAccount = (next: User) => { setSavedAs(next.email); setMe(current => current && { ...current, user: next }); };
  const doneFrom = (source: Source) => { const id = real(source.id); return progress?.received[id] !== undefined && items.current.find(i => i.assetId === id)?.file.size === progress.received[id]; };
  const leftOut = remaining.filter(s => !planned.includes(s) || failed.some(f => f.id === real(s.id)));
  const reasonOf = (s: Source) => { const f = failed.find(x => x.id === real(s.id)); return f ? f.reason === 'unreadable' ? "couldn't be read" : f.reason : stateOf(s.id) === 'tooBig' ? 'too big' : 'not found'; };

  const tipsRow = <ul className="importer-tips"><li><Plug size={16}/>Keep your Mac plugged in</li><li><AppWindow size={16}/>Leave this tab open</li><li><Laptop size={16}/>Don't close the lid</li></ul>;
  const you = () => <>
    <p className="importer-eyebrow">FINAL CUT → SHAREDCUT</p>
    <Title focus={focus}>Bring your Final Cut project to SharedCut</Title>
    <p className="importer-lede">We'll move your edit and all its footage over Wi‑Fi. Nothing to install.</p>
    <ol className="importer-how" aria-label="How it works"><li><b>1</b>Export</li><li><b>2</b>Find footage</li><li><b>3</b>Upload</li></ol>
    {me?.offline && <Alert>We couldn't reach SharedCut. Check your Wi‑Fi, then reload this page.</Alert>}
    {user && imports.map(i => <div key={i.projectId} className="importer-card">
      <p>{i.fcpImport.phase === 'stopped' ? <><strong>{i.name}</strong> stopped at {percentOf(i.fcpImport)}%. Continue upload sends only what's missing.</> : <><strong>{i.name}</strong> is {percentOf(i.fcpImport)}% uploaded.</>}</p>
      <div className="progress-track" aria-hidden="true"><i style={{ width: `${percentOf(i.fcpImport)}%` }}/></div>
      <Button variant="primary" className="importer-big" onClick={() => void continueImport(i.projectId)}>Continue upload<ArrowRight size={17}/></Button>
    </div>)}
    {user ? <div className="importer-who-block">
      <p>{guest ? <span>Welcome back, <strong>{first}</strong>.</span> : <><Avatar user={user} size={30}/><span>Importing as <strong>{user.name}</strong></span></>}
        <button className="importer-link" aria-expanded={guest ? forget : undefined} onClick={async () => { if (guest) setForget(true); else if (confirm('This signs you out of SharedCut on this Mac.')) { await signOut(); location.reload(); } }}>{guest ? `Not ${first}? Start fresh` : 'Not you?'}</button></p>
      {/* A guest has no password: forgetting her on this Mac is for good, so it asks first and offers to save the account. */}
      {forget && guest && <div className="importer-card" role="alertdialog" aria-labelledby="forget-text">
        <p id="forget-text">This forgets <strong>{first}</strong> on this Mac. {first}'s projects stay with your class, but you won't be able to continue {first}'s upload here.</p>
        <div className="importer-actions"><Button variant="primary" autoFocus onClick={() => { setForget(false); setClaim(true); }}>Save my account first</Button>
          <Button onClick={async () => { await signOut(); setMe(current => current && { ...current, user: null }); setImports([]); setClaim(false); reset(); }}>Forget {first}</Button>
          <button className="importer-link" onClick={() => setForget(false)}>Cancel</button></div>
      </div>}
      {claimant && (!newGuest || claim) && (claim || savedAs ? <Claim user={user} saved={savedAs} onSaved={savedAccount}/> : <button className="importer-card quiet" onClick={() => setClaim(true)}>Save your account so you can open your projects from any computer.<ArrowRight size={15}/></button>)}
      <Button variant={imports.length ? 'secondary' : 'primary'} className="importer-big" onClick={() => { reset(); begin(); }}>{imports.length ? 'Start a different project' : "Let's start"}{!imports.length && <ArrowRight size={17}/>}</Button>
    </div> : me && !me.offline && <form className="importer-form" onSubmit={e => { e.preventDefault(); void startGuest(); }}>
      <div><label className="form-field"><span>Your name</span><input ref={nameField} className="input" autoComplete="name" maxLength={80} placeholder="First and last name" value={name} onChange={e => setName(e.target.value)} aria-describedby="name-hint"/></label><small id="name-hint">Your class sees this name next to the project.</small></div>
      {me.code && <div><label className="form-field"><span>Class code</span><input ref={codeField} className={`input mono${youError?.code ? ' invalid' : ''}${shaking ? ' importer-shake' : ''}`} onAnimationEnd={() => setShaking(false)} autoCapitalize="off" autoComplete="off" spellCheck={false} value={code} onChange={e => { setCode(e.target.value); setYouError(undefined); }} aria-invalid={youError?.code || undefined} aria-describedby={`code-hint${youError?.code ? ' code-error' : ''}`}/></label><small id="code-hint">Your teacher has it. It's the code you'd use to sign up for SharedCut.</small></div>}
      {youError && <Alert id={youError.code ? 'code-error' : undefined}>{youError.text}</Alert>}
      <Button type="submit" variant="primary" className="importer-big" disabled={!name.trim() || busy}>{busy ? 'Starting…' : "Let's start"}<ArrowRight size={17}/></Button>
      <a className="importer-link" href={SIGN_IN}>Have a SharedCut account? Sign in</a>
    </form>}
    <p className="importer-foot">Use the Mac that has your Final Cut library.</p>
    {!ON_MAC && <p className="importer-foot">Final Cut runs on a Mac. If your project is on a Mac, open this page there.</p>}
  </>;

  const exportStep = () => <>
    <p className="importer-eyebrow">STEP 1 OF 3</p>
    <Title focus={focus}>Export your project from Final Cut</Title>
    <ol key={replay} className={`importer-steps${dry && !dry.limit ? ' done' : ''}`}><li>In Final Cut, click your project once in the Browser, the list of clips and projects at the top left.</li><li>Choose <strong>File › Export XML…</strong></li><li>Save it to your <strong>Desktop</strong>, then drag it onto this window.</li></ol>
    {reading ? <div className="importer-reading" role="status"><ReadingStrip/>Reading your project…</div>
      : dry && !dry.limit ? <div className="importer-got"><GotIt/><p>Got it: <strong>{dry.name}</strong> · {plural(dry.media.length, 'clip')} · {clock(dry.duration)}</p></div>
      : <button className={`importer-drop${over === 'export' ? ' over' : ''}`} onClick={() => xmlInput.current?.click()} onDragOver={() => setOver('export')} onDragLeave={() => setOver('')}><FileText size={30}/><span>Drag the exported file here</span><span className="importer-link">or choose it…</span></button>}
    {exportError && <Alert>{exportError.text}{exportError.fresh && xml && <Button variant="primary" onClick={() => void readXml(xml.file, xml.name, true)}>Import a separate copy</Button>}</Alert>}
    {exportError?.claim && user && <Claim user={user} saved={savedAs} onSaved={next => { savedAccount(next); if (xml) void readXml(xml.file, xml.name, xml.fresh); }}/>}
    {dry && !dry.limit && <div className="importer-actions"><Button variant="primary" className="importer-big" autoFocus onClick={afterExport}>Continue<ArrowRight size={17}/></Button><button className="importer-link" onClick={() => { setDry(undefined); setXml(undefined); }}>Use a different file</button></div>}
    <details className="importer-help"><summary>It won't drop?</summary><p>Right-click the file on your Desktop, choose <strong>Show Package Contents</strong>, and drag <strong>Info.fcpxml</strong> onto this window instead.</p></details>
  </>;

  // Dropped the wrong export? Back to the drop card.
  const otherFile = <button className="importer-link" onClick={() => { setDry(undefined); setXml(undefined); go('export'); }}>Use a different file</button>;
  const decide = () => dry?.state === 'deleted' ? <>
    <p className="importer-eyebrow">STEP 1 OF 3 · YOUR EDIT</p>
    <Title focus={focus}><strong>{dry.name}</strong> was deleted from SharedCut</Title>
    <p className="importer-lede">It can still be restored from Recently deleted in SharedCut, or you can import a new copy.</p>
    <div className="importer-actions"><Button variant="primary" className="importer-big" onClick={() => choose('fresh')}>Import a new copy</Button>{otherFile}</div>
  </> : <>
    <p className="importer-eyebrow">STEP 1 OF 3 · YOUR EDIT</p>
    <Title focus={focus}>You've imported <strong>{dry?.name}</strong> before</Title>
    <p className="importer-lede">Your edit changed since then. Update the SharedCut project with your new edit? Footage you already sent is kept.</p>
    <div className="importer-actions"><Button variant="primary" className="importer-big" onClick={() => choose('rebuild')}>Update it</Button><Button className="importer-big" onClick={() => choose('fresh')}>Make a separate copy</Button>{otherFile}</div>
    <p className="importer-foot">The old version of the edit is saved as a snapshot.</p>
  </>;

  const fonts = () => { const missing = (job?.fonts ?? []).filter(f => !added.has(f)); return <>
    <p className="importer-eyebrow">ONE MORE THING</p>
    <Title focus={focus}>{missing.length ? "Your titles use fonts SharedCut doesn't have yet" : 'Your fonts are in SharedCut'}</Title>
    <ul className="importer-fonts">{job?.fonts.map(f => <li key={f} className={added.has(f) ? 'added' : ''}>
      <Type size={17}/><span><strong>{f}</strong><span className="importer-nowrap"> · {added.has(f) ? 'added' : 'needed'}</span>{fontErrors[f] && <small className="importer-row-error">{fontErrors[f]}</small>}</span>
      {added.has(f) ? <motion.span className="importer-pop" initial={reduced ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 500, damping: 14 }}><Check size={15}/></motion.span> : <button className="importer-link" onClick={() => { fontFor.current = f; fontInput.current?.click(); }}>Choose font file…</button>}
    </li>)}</ul>
    {missing.length > 0 && <>
      <p className="importer-lede">Open <strong>Font Book</strong>, find the font, right-click it and choose <strong>Show in Finder</strong>. Then drag the font files here.</p>
      <button className={`importer-drop${over === 'export' ? ' over' : ''}`} onClick={() => { fontFor.current = undefined; fontInput.current?.click(); }} onDragOver={() => setOver('export')} onDragLeave={() => setOver('')}><Type size={30}/><span>Drag the font files here</span><span className="importer-link">or choose them…</span></button>
    </>}
    <div className="importer-actions">
      {'queryLocalFonts' in window && missing.length > 0 && <Button variant="primary" className="importer-big" onClick={() => void fromThisMac()}>Add them from this Mac</Button>}
      <Button variant={missing.length ? 'secondary' : 'primary'} className="importer-big" onClick={() => job && footage(job)}>{missing.length ? 'Skip: use a similar font' : 'Continue'}<ArrowRight size={17}/></Button>
    </div>
  </>; };

  const footageStep = () => {
    const ok = remaining.filter(s => stateOf(s.id) === 'ok').length, missing = remaining.length - ok, busyNow = !!walking || !!checking, asking = remaining.some(s => stateOf(s.id) === 'ambiguous');
    // Status is never color alone: each note carries the warning icon. Each sits under the row of the place its clip is from.
    const warn = (key: string, children: ReactNode, action?: ReactNode) => <li key={key}><AlertTriangle size={16}/><span>{children}{action && <span className="importer-note-action">{action}</span>}</span></li>;
    const problemOf = (s: Source): ReactNode => { const st = stateOf(s.id), found = foot.found[s.id], check = foot.checks[s.id];
      if (st === 'ambiguous') {
        const list = foot.ambig[s.id], length = (c: Found) => foot.lengths.get(`${s.id}:${c.path}`), same = (c: Found) => { const l = length(c); return !!l && l !== 'checking' && l.state === 'ok' && l.seconds !== undefined; };
        // Exactly one as long as the clip in the edit: it is chosen already, and the student only confirms it.
        const matching = list.filter(same), likely = matching.length === 1 ? matching[0] : undefined;
        return <li key={s.id} className="choose"><fieldset className="importer-choose"><legend>{list.length === 2 ? 'Two' : list.length} files are called <strong>{s.name}</strong>. Which one is from this project?</legend>
          {list.map(c => { const l = length(c), seconds = l && l !== 'checking' ? l.seconds : undefined;
            return <label key={c.path}><input type="radio" name={`pick-${s.id}`} checked={c === likely} onChange={() => pick(s.id, c)}/><span><b>{c.path.split('/').slice(0, -1).join(' › ') || 'Dropped file'}</b>
              <small>{seconds !== undefined && <>{Math.round(seconds)} s{same(c) && ' · same length as in your edit'} · </>}{bytes(c.file.size)} · {new Date(c.file.lastModified).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</small></span>
              {same(c) && <em className="importer-tag">Matches</em>}</label>; })}
          {likely && <Button variant="primary" onClick={() => pick(s.id, likely)}>Use this one</Button>}</fieldset></li>;
      }
      if (st === 'different' && check && check !== 'checking') return warn(s.id, <>We found a <strong>{s.name}</strong> in {found.path.split('/')[0]}, but it's a different clip ({Math.round(check.seconds ?? 0)} s long; the project's is {Math.round(s.duration ?? 0)} s). Drag the folder it came from.</>, <Button onClick={() => { foot.use.add(s.id); render(); }}>Use it anyway</Button>);
      if (st === 'unreadable') return warn(s.id, <>We can't open <strong>{s.name}</strong>. If it's on a drive, plug it in and drag the folder again.</>);
      if (st === 'tooBig') return warn(s.id, <><strong>{found.file.name}</strong> is {bytes(found.file.size)}. SharedCut takes files up to {bytes(maxBytes)}, so it'll be left out.</>);
      return null;
    };
    const problemsIn = (ids: (id: string) => boolean) => { const list = remaining.filter(s => ids(s.id)).map(problemOf).filter(Boolean); return list.length > 0 && <ul className="importer-problems">{list}</ul>; };
    return <>
      <p className="importer-eyebrow">STEP 2 OF 3</p>
      <Title focus={focus}>Now let's find your footage</Title>
      {job?.mode === 'continue' && job.sent ? <p className="importer-banner">Welcome back. <strong>{job.name}</strong> is {job.sent.percent}% uploaded. Drag in these places again.{job.sent.bytes > 0 && ` The ${bytes(job.sent.bytes)} already sent won't be sent again.`}</p>
        : already > 0 && <p className="importer-banner">Welcome back! <strong>{already} of {job!.sources.length} clips</strong> are already in SharedCut. Let's send the rest.</p>}
      <p className="importer-lede">Drag these onto this window. We only send the {plural(remaining.length, 'clip')} your project uses, nothing else on your Mac.</p>
      {/* Every unfinished row is a drop target (the whole window takes the drop; the row shows where it goes). The first one
          still missing files is open, its breadcrumb and Copy location showing, and its Choose folder… is the step's action. */}
      <ul className="importer-places">{placeList.map((p, row) => { const n = p.ids.filter(id => stateOf(id) === 'ok').length, done = n === p.ids.length, Icon = p.kind === 'library' ? Clapperboard : p.kind === 'drive' ? HardDrive : Folder, first = p === firstOpen;
        return <li key={p.path} id={`importer-place-${row}`} className={done ? 'done' : over === `place-${row}` ? 'open over' : 'open'} onDragOver={() => { if (!done) setOver(`place-${row}`); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(''); }}>
          <div className="importer-place-row"><Icon size={20}/><div><b>{bold(p.label)}</b><small>{p.hint && !done && `${p.hint} · `}<Count value={n}/> of {p.ids.length} found</small></div>{n ? <Ring done={n} total={p.ids.length}/> : <span className="importer-drop-hint" aria-hidden="true">Drop it here</span>}</div>
          {problemsIn(id => p.ids.includes(id))}
          {!done && <details open={first}><summary>Show me where</summary><div className="importer-where">
            <p className="importer-crumbs">{p.crumbs.join(' › ')}</p>
            <p>In Finder, press <strong>Shift ⌘ G</strong>, paste, then press Return. Drag what opens onto this window.</p>
            <div className="importer-actions"><Button variant={first && !asking ? 'primary' : 'secondary'} onClick={() => folderInput.current?.click()}><Folder size={14}/>Choose folder…</Button><Button onClick={() => copy(p.path)}><Copy size={14}/>{copied === p.path ? 'Copied' : 'Copy location'}</Button></div>
          </div></details>}
        </li>; })}</ul>
      {problemsIn(id => !placeList.some(p => p.ids.includes(id)))}
      {walking && <p className="importer-working" role="status"><i className="importer-spin"/>Looking through {walking.name}… {plural(walking.count, 'file')}</p>}
      {checking && <p className="importer-working" role="status"><i className="importer-spin"/>Checking clips… {checking.done} of {checking.total}</p>}
      {notes.map(n => <Alert key={n}>{n === 'zip' ? 'That came in as a zip file. Drag the folder itself from Finder instead.' : n === 'many' ? "That's a lot of files. Drag the folder your clips are in instead." : <>Your browser gave us <strong>{n.slice(8)}</strong> as a single file. Right-click it in Finder, choose <strong>Show Package Contents</strong>, and drag the folders inside onto this window.</>}</Alert>)}
      <div className="importer-footer">
        <p><strong><Count value={ok}/> of {remaining.length}</strong> clips found</p>
        {!missing ? <div className="importer-actions"><Button variant="primary" className="importer-big" disabled={busyNow} onClick={toCheck}>Continue<ArrowRight size={17}/></Button></div>
          : firstOpen ? <p className="importer-or">Or drag <strong>{firstOpen.item}</strong> onto this window.</p>
          : <div className="importer-actions"><Button variant="primary" className="importer-big" onClick={() => folderInput.current?.click()}><Folder size={16}/>Choose folder…</Button></div>}
        {missing > 0 && <details className="importer-help"><summary>Which clips?</summary><ul className="importer-missing">{remaining.filter(s => stateOf(s.id) !== 'ok').map(s => <li key={s.id}><b>{s.name}</b><small>{s.sourcePath}</small></li>)}</ul></details>}
        {/* Leaving clips out is a quiet choice, offered once something was found, or after two drops that found nothing. */}
        {missing > 0 && (ok > 0 || misses > 1) && <div className="importer-skip"><button className="importer-link" disabled={busyNow || asking} onClick={toCheck}>Continue without {plural(missing, 'clip')}</button>
          <small>{asking ? 'Answer "Which one is from this project?" first.' : "They'll show as missing in SharedCut. To add them later, come back here, drag in the same export, then their folders."}</small></div>}
      </div>
      <details className="importer-help"><summary>Can't find a clip?</summary><p>In Final Cut, select the clip and press <strong>Shift ⌘ R</strong> to show it in Finder.</p><p>Libraries are in your Movies folder unless you saved them somewhere else.</p></details>
    </>;
  };

  const check = () => {
    const tooBig = remaining.filter(s => stateOf(s.id) === 'tooBig').length, notFound = remaining.length - planned.length - tooBig, long = seconds > 3 * 3600;
    // The time is the big line, counting up as the gauge settles; Konrad's sentence is what a screen reader hears.
    const when = friendlyDuration(seconds), parts = when.match(/^(\D*)(\d+)(.*)$/), cap = (text: string) => already > 0 ? text : text.replace(/^./, c => c.toUpperCase());
    const time = parts ? <>{cap(parts[1])}<Count value={Number(parts[2])} start={0} duration={.9}/>{parts[3]}</> : cap(when);
    return <>
      <p className="importer-eyebrow">STEP 3 OF 3</p>
      <Title focus={focus}>{probing || !speed ? 'Checking your Wi‑Fi…' : 'Ready to upload'}</Title>
      <div className="importer-hero" aria-hidden="true">
        <p className={`importer-time${speed ? '' : ' waiting'}`}>{!speed ? 'Timing it…' : already > 0 ? <>{bytes(toSend)} left · {time}</> : time}</p>
        <p className="importer-sub">{already > 0 ? `${already} of ${job!.sources.length} already in SharedCut` : `${bytes(total)} · ${plural(planned.length, 'clip')}`}{speed?.measured && <> · your Wi‑Fi ≈ {(speed.parallel / 1e6).toFixed(1)} MB/s</>}</p>
      </div>
      {speed && <p className="importer-sr importer-sentence">{sentence(speed)}</p>}
      {speed && !speed.measured && <p className="importer-lede">We couldn't check your Wi‑Fi, so that's at a typical school speed.</p>}
      {speed?.measured && speed.parallel < 1e6 && <p className="importer-note">Your Wi‑Fi is slow right now. It'll still work, or move closer to the router and press <strong>Check again</strong>.</p>}
      {speed && long && <p className="importer-note">That's a long one. Start it when your Mac can stay open and plugged in for a while. If it stops, come back here and it picks up where it left off.</p>}
      {(notFound > 0 || tooBig > 0) && <p className="importer-note">Left out: {[notFound && `${plural(notFound, 'clip')} not found`, tooBig && `${tooBig} too big`].filter(Boolean).join(', ')}.{notFound > 0 && <button className="importer-link" onClick={() => go('footage')}>Go back and find {notFound === 1 ? 'it' : 'them'}</button>}</p>}
      {short && <Alert>SharedCut doesn't have room for this right now. It needs about {bytes(short.needed)} and has {bytes(Math.max(0, short.room))} free. Your files are safe on your Mac. Tell your teacher, then press <strong>Check again</strong>.</Alert>}
      {startError && <Alert>{startError}</Alert>}
      {claim && claimant && user && <Claim user={user} saved={savedAs} projectId={imported.current || undefined} onSaved={savedAccount}/>}
      {guest ? <p className="importer-lands">It'll show up in SharedCut as <strong>{job?.name}</strong>, shared with your class.</p> : <>
        {(job?.mode === 'new' || job?.mode === 'fresh') && !imported.current && <label className="importer-check"><input type="checkbox" checked={share} onChange={e => setShare(e.target.checked)}/>Let my class see it on their Projects screen</label>}
        <p className="importer-lands">It'll show up in your Projects as <strong>{job?.name}</strong>.</p></>}
      {tipsRow}
      <div className="importer-actions">
        <Button variant="primary" className="importer-big" disabled={probing || !speed || !!short || starting} onClick={() => void start()}>{starting ? 'Starting…' : 'Start upload'}<ArrowRight size={17}/></Button>
        <Button className="importer-big" onClick={() => go('footage')}>Back</Button>
        {!probing && speed && <button className="importer-link" onClick={() => void probe()}><RotateCcw size={14}/>Check again</button>}
      </div>
    </>;
  };

  const upload = () => <>
    <p className="importer-eyebrow">STEP 3 OF 3 · UPLOADING</p>
    {/* Waiting on the Wi-Fi or on SharedCut, the heading says so, in the stage's words, and the percent goes grey. */}
    <Title focus={focus}>{status === 'running' && progress?.waiting ? WAITING[progress.waiting] : <>{status === 'paused' ? 'Paused: ' : 'Uploading '}<strong>{job?.name}</strong></>}</Title>
    <p className={`importer-percent${status !== 'running' || progress?.waiting ? ' muted' : ''}`} aria-hidden="true">{percent}%</p>
    <progress className="importer-progress" max={100} value={percent} aria-label="Upload progress" aria-valuetext={`${percent} percent${eta ? `, ${friendlyDuration(eta)} left` : ''}`}/>
    {/* Speed and time only while bytes move: before the first acknowledged chunk, paused or offline, a speed reads as stalled. */}
    <p className="importer-stats">{!progress ? 'Starting…' : <>{bytes(progress.bytes)} of {bytes(progress.total)}{status === 'running' && !progress.waiting && <> · {progress.rate > 0 ? `${bytes(progress.rate)}/s · ${eta ? `${friendlyDuration(eta)} left` : 'Starting…'}` : 'Starting…'}</>}</>}</p>
    <p className="importer-foot">{progress ? `${progress.sent} of ${plural(progress.files, 'clip')} sent` : ''}</p>
    {statusText && <div className={`importer-status ${progress?.waiting || status === 'locked' || unreadableNow.length ? 'warn' : ''}`}>{status === 'paused' ? <Pause size={16}/> : <AlertTriangle size={16}/>}<span>{statusText}</span>
      {status === 'paused' && <Button variant="primary" onClick={resume}><Play size={14}/>Resume</Button>}
      {status === 'error' && <Button variant="primary" onClick={resume}>Try again</Button>}
      {status === 'signedOut' && !guest && <a className="button button-primary" href={SIGN_IN}>Sign in</a>}
      {status === 'stuck' && <Button onClick={() => go('ready')}>Finish without {unreadableNow.length === 1 ? 'it' : 'them'}</Button>}</div>}
    {awake && !progress?.waiting && <p className="importer-awake"><Coffee size={14}/>Keeping your Mac awake</p>}
    {tipsRow}
    <div className="importer-actions">
      {status === 'running' && <Button className="importer-big" onClick={pause}><Pause size={15}/>Pause</Button>}
      <Button className="importer-big" aria-expanded={showClips} onClick={() => setShowClips(!showClips)}>{showClips ? 'Hide clips' : `Show clips (${planned.length})`}</Button>
    </div>
    {showClips && <ul className="importer-clips">{remaining.map(s => { const id = real(s.id), on = progress?.sending.includes(id), got = progress?.received[id], size = foot.found[s.id]?.file.size;
      const out = leftOut.includes(s) && (failed.some(f => f.id === id) || !planned.includes(s)) || progress?.failed.some(f => f.id === id);
      return <li key={s.id}><span>{s.name}</span><small>{out ? `left out · ${reasonOf(s)}` : doneFrom(s) ? <><Check size={13}/>sent</> : on && size ? `sending ${Math.floor((got ?? 0) * 100 / size)}%` : 'queued'}</small></li>; })}</ul>}
    {nudge && claimant && user && (claim || savedAs ? <Claim user={user} saved={savedAs} projectId={imported.current} onSaved={savedAccount}/> : <button className="importer-card quiet" onClick={() => setClaim(true)}>Want to open this from another computer later? Save your account now. It takes 20 seconds.<ArrowRight size={15}/></button>)}
  </>;

  const ready = () => { const i = polled?.fcpImport; return <>
    <p className="importer-eyebrow">ALMOST THERE</p>
    <Title focus={focus}>Uploaded! SharedCut is getting it ready</Title>
    {i && <><p className="importer-stats"><strong>{i.ready} of {i.files}</strong> clips ready</p><div className="progress-track importer-bar" aria-hidden="true"><i style={{ width: `${i.files ? i.ready * 100 / i.files : 0}%` }}/></div></>}
    <p className="importer-lede">{guest ? "You can close this page now. SharedCut keeps working, and your class will find it in Projects when it's done." : "You can close this page now. SharedCut keeps working, and it'll be in Projects when it's done."}</p>
    {!guest && <div className="importer-actions"><a className="button button-secondary importer-big" href={`/project/${encodeURIComponent(imported.current)}`}>Open in SharedCut</a></div>}
  </>; };

  const done = () => { const prepFailed = polled?.media.filter(m => m.uploaded && m.status === 'failed') ?? [], warnings = job?.warnings ?? []; return <>
    <p className="importer-eyebrow">DONE</p>
    <Title focus={focus}><span className="importer-h1-check" aria-hidden="true"><Check size={18} strokeWidth={3}/></span><strong>{job?.name ?? 'Your project'}</strong> is in SharedCut</Title>
    {claimant ? <>
      <p className="importer-lede">{savedAs ? 'Everyone in your class can find it in Projects, and you can open it from any computer.' : 'Everyone in your class can find it in Projects.'}</p>
      {/* The win leads; saving the account is the optional next thing (§2.12 put the form first). */}
      {user && !savedAs && <h2 className="importer-sub-heading">Optional: open it from any computer</h2>}
      {user && <Claim user={user} saved={savedAs} projectId={imported.current} onSaved={savedAccount}/>}
      <div className="importer-actions"><Button className="importer-big" onClick={() => { reset(); go('you'); void loadSession(); }}>I'm done</Button></div>
    </> : <>
      <p className="importer-lede">It's in your Projects.</p>
      <div className="importer-actions"><a className="button button-primary importer-big" href={`/project/${encodeURIComponent(imported.current)}`}>Open in SharedCut<ArrowRight size={17}/></a><Button className="importer-big" onClick={() => { reset(); go('export'); }}>Import another project</Button></div>
    </>}
    {leftOut.length > 0 && <details className="importer-help"><summary>{plural(leftOut.length, 'clip')} {leftOut.length === 1 ? 'was' : 'were'} left out</summary><ul className="importer-missing">{leftOut.map(s => <li key={s.id}><b>{s.name}</b><small>{reasonOf(s)}</small></li>)}</ul><p>To add them later, come back here, drag in the same export, then their folders.</p></details>}
    {warnings.length > 0 && <details className="importer-help"><summary>{plural(warnings.length, 'thing')} look{warnings.length === 1 ? 's' : ''} a little different from Final Cut</summary><ul className="importer-missing">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
    {prepFailed.length > 0 && <details className="importer-help"><summary>{plural(prepFailed.length, 'clip')} couldn't be prepared</summary><ul className="importer-missing">{prepFailed.map(m => <li key={m.id}><b>{m.name}</b>{m.error && <small>{m.error}</small>}</li>)}</ul><p>{guest ? 'Your teacher can retry it in SharedCut.' : 'Open SharedCut to retry it.'}</p></details>}
  </>; };

  const link = `${location.origin}/importer`;
  const blockedStep = () => blocked === 'phone' ? <>
    <p className="importer-eyebrow">FINAL CUT → SHAREDCUT</p>
    <Title focus={focus}>Open this on your Mac</Title>
    <p className="importer-lede">Use the Mac that has your Final Cut library and go to <strong>sharedcut.com/importer</strong> there.</p>
    <p className="importer-url mono">{location.host}/importer</p>
    {/* The share sheet offers AirDrop and Messages on an iPhone; without one, or if it fails, the link is copied. */}
    <div className="importer-actions">
      {'share' in navigator && <Button variant="primary" className="importer-big" onClick={() => void navigator.share({ url: link }).catch((e: unknown) => { if ((e as Error)?.name !== 'AbortError') copy(link); })}><Share size={17}/>Send this link to my Mac</Button>}
      <Button variant={'share' in navigator ? 'secondary' : 'primary'} className="importer-big" onClick={() => copy(link)}><Copy size={16}/>{copied === link ? 'Copied' : 'Copy link'}</Button>
    </div>
  </> : <>
    <p className="importer-eyebrow">FINAL CUT → SHAREDCUT</p>
    <Title focus={focus}>Your browser needs an update</Title>
    <p className="importer-lede">This page needs Safari 17.4 or newer, or Chrome.</p>
    <ol className="importer-steps still"><li>Open the <strong>Apple menu › System Settings</strong>.</li><li>Choose <strong>General › Software Update</strong> and install the update.</li><li>Open this page again.</li></ol>
    <div className="importer-actions"><a className="button button-secondary importer-big" href="https://www.google.com/chrome/" target="_blank" rel="noopener noreferrer">Get Chrome</a></div>
  </>;

  const screens: Record<Step, () => ReactNode> = { blocked: blockedStep, you, export: exportStep, decide, fonts, footage: footageStep, check, upload, ready, done };
  // The first place still missing a clip: the Finder scene and the open row. None once every place is done.
  const firstOpen = placeList.find(p => p.ids.some(id => stateOf(id) !== 'ok'));
  const fontsLeft = (job?.fonts ?? []).filter(f => !added.has(f)), titled = job?.fonts.find(f => titles[f]) ?? job?.fonts[0] ?? 'Futura PT';
  // Paused or waiting, no lane is sending: the tracks show the unfinished files instead, as far as they got.
  const unsent = items.current.filter(i => (progress?.received[i.assetId] ?? 0) < i.file.size && !progress?.failed.some(f => f.id === i.assetId)).sort((x, y) => (progress?.received[y.assetId] ?? 0) - (progress?.received[x.assetId] ?? 0));
  const laneIds = progress?.sending.some(Boolean) ? progress.sending : unsent.map(i => i.assetId);
  const laneList: Lane[] = Array.from({ length: Math.max(1, Math.min(4, progress?.lanes ?? 1)) }, (_, i) => { const id = laneIds[i], item = id ? items.current.find(x => x.assetId === id) : undefined; return item && progress ? { id: item.assetId, name: item.file.name, share: (progress.received[item.assetId] ?? 0) / item.file.size } : undefined; });
  const sentList = items.current.filter(i => progress?.received[i.assetId] === i.file.size).map(i => ({ id: i.assetId, name: i.file.name, size: i.file.size }));
  const prepared = (polled?.media ?? []).filter(m => m.uploaded || items.current.some(i => i.assetId === m.id)).map(m => ({ id: m.id, name: m.name, ready: m.status === 'ready', failed: m.status === 'failed', thumbnail: m.thumbnail }));
  // A finished step shows its result, not the how-to: the export's clips on SharedCut's tracks, the title in its font, every clip found.
  const [scene, replayable]: [ReactNode, boolean] = step === 'blocked' ? [blocked === 'phone' ? <DeviceSwap/> : <BrowserUpdate/>, true]
    : step === 'you' ? [!user && name.trim() ? <NameTag name={name.trim()} color={color}/> : <Handoff/>, !!user || !name.trim()]
    : step === 'export' ? [dry && !dry.limit ? <Received key={dry.projectId} clips={dry.media.length}/> : <ExportScene/>, true] : step === 'decide' ? [<Handoff/>, true]
    : step === 'fonts' ? [fontsLeft.length ? <FontScene family={fontsLeft[0]}/> : <FontDone key="done" family={titled} text={titles[titled] ?? job?.name ?? 'Your title'}/>, true]
    : step === 'footage' ? [remaining.length && planned.length === remaining.length ? <FoundScene key="found" names={planned.map(s => foot.found[s.id].file.name)} total={remaining.length}/> : firstOpen ? <FinderScene key={firstOpen.path} sidebar={firstOpen.sidebar} item={firstOpen.item} kind={firstOpen.kind} drive={firstOpen.crumbs[0] !== 'Macintosh HD'}/> : <Handoff/>, true]
    : step === 'check' ? [<Gauge bytesPerSecond={speed?.parallel ?? sample} settled={!!speed && !probing} failed={!!speed && !speed.measured}/>, false]
    : step === 'upload' ? [<Lanes lanes={laneList} done={sentList} total={items.current.reduce((a, i) => a + i.file.size, 0)} state={status === 'running' && progress?.waiting ? progress.waiting : status !== 'running' ? 'dim' : ''}/>, false]
    : step === 'ready' ? [<Preparing clips={prepared}/>, false] : [<Arrived name={job?.name ?? 'Your project'}/>, true];
  const at = RAIL_AT[step];

  return <MotionConfig reducedMotion="user"><main className="importer" aria-labelledby="importer-title">
    <header className="importer-top">
      <span className="importer-brand"><Brand/><span className="importer-beta">BETA</span></span>
      {step !== 'blocked' && <ol className="importer-rail" aria-label="Import steps">{RAIL.map((r, i) => <li key={r} aria-current={i === at ? 'step' : undefined} className={i < at ? 'past' : i === at && step === 'ready' ? 'busy' : ''}>
        {i === at && <motion.span layoutId="importer-rail" className="importer-rail-pill" transition={{ type: 'spring', stiffness: 380, damping: 34 }}/>}
        <span className="importer-rail-dot">{i < at ? <Check size={10} strokeWidth={3}/> : i > 0 && i < 4 && step !== 'ready' && i}</span><span className="importer-rail-name">{r}</span></li>)}</ol>}
      {/* A phone-width window: one line and three segments instead of the rail. */}
      {step !== 'blocked' && <div className="importer-mini"><p>{at === 0 ? 'Getting started' : at === 4 ? 'Done' : `Step ${at} of 3 · ${RAIL[at]}`}</p><span aria-hidden="true">{[1, 2, 3].map(n => <i key={n} className={n <= at ? 'on' : ''}/>)}</span></div>}
      {user ? <span className="importer-who"><Avatar user={user} size={26}/><span>{user.name}</span></span> : <span className="importer-who"/>}
    </header>
    <div className="importer-body">
      {/* The scene is decoration (the copy says everything); Replay is a real control, for the keyboard too. */}
      <section className={`importer-stage${step === 'you' || step === 'blocked' ? ' photo' : ''}`}>
        {/* No initial={false} here: it would also start every scene on its last frame. */}
        <AnimatePresence mode="wait"><motion.div key={`${step}-${replay}`} className="importer-scene" aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .22 }}>{scene}</motion.div></AnimatePresence>
        {replayable && <button className="importer-replay" aria-label="Replay the animation" title="Replay" onClick={() => setReplay(n => n + 1)}><RotateCcw size={17}/></button>}
      </section>
      <section className="importer-copy">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0, transition: { duration: .26, ease: [.22, 1, .36, 1] } }} exit={{ opacity: 0, x: -16, transition: { duration: .18 } }}>{screens[step]()}</motion.div>
        </AnimatePresence>
      </section>
    </div>
    <input ref={xmlInput} type="file" hidden accept=".fcpxml,.fcpxmld,.xml" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void readXml(file, label(file.name)); }}/>
    <input ref={folderInput} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={e => { const files = [...e.target.files ?? []]; e.target.value = ''; if (files.length) void addFootage({ entries: [], files }); }}/>
    <input ref={fontInput} type="file" hidden multiple accept=".ttf,.otf,.ttc,.woff,.woff2" onChange={e => { const files = [...e.target.files ?? []], family = fontFor.current; e.target.value = ''; fontFor.current = undefined; if (files.length) void addFonts(files, family); }}/>
    {dragging && <div className="importer-overlay" aria-hidden="true"><span>Drop it anywhere</span></div>}
    {flights.map(f => <motion.span key={f.key} className="importer-flight" aria-hidden="true" initial={{ x: f.from[0], y: f.from[1], opacity: 1, scale: 1 }} animate={{ x: f.to[0], y: f.to[1], opacity: 0, scale: .6 }} transition={{ duration: .4, delay: f.i * .03, ease: [.22, 1, .36, 1] }} onAnimationComplete={() => setFlights(current => current.filter(x => x.key !== f.key))}>{f.name}</motion.span>)}
    {toast && <div className="importer-toast" aria-hidden="true">{toast}</div>}
    <div className="importer-sr" role="status" aria-live="polite">{said}</div>
  </main></MotionConfig>;
}

/** Anything unexpected: the person's files are safe on the server, and a reload continues. */
class Boundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="importer importer-crash" aria-labelledby="importer-title"><section className="importer-copy">
      <h1 id="importer-title">Something went wrong on our side</h1>
      <p className="importer-lede">What you've sent is saved, so reload this page to continue.</p>
      <div className="importer-actions"><Button variant="primary" className="importer-big" onClick={() => location.reload()}>Reload this page</Button></div>
      <details className="importer-help"><summary>Technical details</summary><pre>{this.state.error.stack ?? this.state.error.message}</pre></details>
    </section></main>;
  }
}

export default function ImporterPage() { return <Boundary><Importer/></Boundary>; }
