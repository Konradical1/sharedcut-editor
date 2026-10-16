import './script.css';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowLeftRight, Check, ChevronDown, Copy, Drama, ExternalLink, FileDown, FileOutput, FilePlus2, FileText, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Printer, ScrollText, Trash2, Upload } from 'lucide-react';
import { useEditorStore } from '../../state/store';
import type { CollaborativeLock, ScriptBlock, ScriptBlockKind as Kind, ScriptFormat, Shot } from '../../state/models';
import { ordered, PLAN_LIMITS, sceneNumbers } from '../../services/plan';
import { cycleKind, detectKind, nextKind, pageCount, parseFountain, toDocx, toFountain, toHtml, type ScriptDoc } from '../../services/screenplay';
import { lockConflict } from '../../services';
import { connection } from '../../services/api';
import { Badge, Button, ContextMenu, EmptyState, Field, IconButton, Modal } from '../ui';
import { PlanActions } from './slot';
import { copyRich, downloadFile, printHtml, safeFileName } from './download';

const s = useEditorStore.getState;
const KINDS: Kind[] = ['scene', 'action', 'character', 'parenthetical', 'dialogue', 'transition', 'shot', 'lyric', 'note'];
const LABEL: Record<Kind, string> = { scene: 'Scene heading', action: 'Action', character: 'Character', parenthetical: 'Parenthetical', dialogue: 'Dialogue', transition: 'Transition', shot: 'Shot', lyric: 'Lyric', note: 'Note' };
const SHORT: Record<Kind, string> = { scene: 'Scene', action: 'Action', character: 'Char', parenthetical: 'Paren', dialogue: 'Dial', transition: 'Trans', shot: 'Shot', lyric: 'Lyric', note: 'Note' };
const HINT: Record<Kind, string> = { scene: 'INT. LOCATION – DAY', action: 'Action', character: 'CHARACTER', parenthetical: '(beat)', dialogue: 'Dialogue', transition: 'CUT TO:', shot: 'CLOSE ON', lyric: 'Lyric', note: 'Note for the team (not printed)' };
// A stage play calls its action stage directions.
const label = (kind: Kind, format: ScriptFormat) => format === 'stage' && kind === 'action' ? 'Stage direction' : LABEL[kind];
const hint = (kind: Kind, format: ScriptFormat) => format === 'stage' && kind === 'action' ? 'Stage direction' : HINT[kind];
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** A character cue without (V.O.), (CONT'D) or the dual-dialogue caret, as autocomplete offers it. */
const cue = (text: string) => text.replace(/\s*\^$/, '').replace(/(?:\s*\([^()]*\))+\s*$/, '').trim().toUpperCase();
const load = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode: the choice just isn't remembered */ } };

// Selectors run on every store change (presence ticks several times a second) for up to thousands of lines, so each
// index is built once per source array and every line looks itself up in O(1).
const byArray = <A extends object, R>(build: (a: A) => R) => { let last: A | undefined, value = undefined as R; return (a: A) => { if (a !== last) { last = a; value = build(a); } return value; }; };
const blockIndex = byArray((blocks: ScriptBlock[]) => new Map(blocks.map(b => [b.id, b])));
const textLocks = byArray((locks: CollaborativeLock[]) => { const m = new Map<string, CollaborativeLock[]>(); for (const l of locks) if (lockConflict(l.field, 'text')) m.set(l.targetId, [...m.get(l.targetId) ?? [], l]); return m; });
const shotCounts = byArray((shots: Shot[]) => { const m = new Map<string, number>(); for (const shot of shots) if (shot.sceneId) m.set(shot.sceneId, (m.get(shot.sceneId) ?? 0) + 1); return m; });
function useLines(scriptId: string | undefined) {
  const cache = useRef<{ from?: ScriptBlock[]; id?: string; lines: ScriptBlock[] }>({ lines: [] });
  return useEditorStore(st => { const c = cache.current; if (c.from !== st.scriptBlocks || c.id !== scriptId) { c.from = st.scriptBlocks; c.id = scriptId; c.lines = scriptId ? ordered(st.scriptBlocks.filter(b => b.scriptId === scriptId && b.projectId === st.projectId)) : []; } return c.lines; });
}
/** addScriptBlocks takes 5000 lines a call; a feature-length import goes in slices, each after the last. */
function insertBlocks(scriptId: string, blocks: { kind: Kind; text: string }[], afterId?: string | null) {
  const ids: string[] = [];
  for (let i = 0; i < blocks.length; i += 5000) { const added = s().addScriptBlocks(scriptId, blocks.slice(i, i + 5000), i ? ids.at(-1) : afterId); if (!added.length) break; ids.push(...added); }
  return ids;
}

// field-sizing grows a textarea with its text in CSS; elsewhere heights are measured, all reads before all writes.
const SIZING = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
const fit = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; };
// `fresh`: only lines new or re-kinded since they were last measured (kind sets indent and width); a text edit sizes its own line.
const fitAll = (root: HTMLElement, fresh = false) => { const all = [...root.querySelectorAll<HTMLTextAreaElement>('.script-block textarea')].filter(el => !fresh || el.dataset.fit !== el.dataset.kind); all.forEach(el => { el.style.height = 'auto'; }); const heights = all.map(el => el.scrollHeight); all.forEach((el, i) => { el.style.height = `${heights[i]}px`; el.dataset.fit = el.dataset.kind; }); };

type At = number | 'end';
/** What every line needs from the page, in one stable object so the memoised lines never re-render for it. */
interface Ed { lines: ScriptBlock[]; names: string[]; pending: { id: string; at: At } | null; prev(id: string): ScriptBlock | undefined; next(id: string): ScriptBlock | undefined; sceneAbove(id: string): string | undefined; focus(id: string, at: At, later?: boolean): void; apply(): void; kindMenu(id: string, x: number, y: number, caret: number): void }
type Menu = { kind: 'scripts' | 'export'; x: number; y: number } | { kind: 'element'; id: string; caret: number; x: number; y: number };

const Block = memo(function Block({ id, scene, shots, editable, format, alone, ed }: { id: string; scene?: number; shots: number; editable: boolean; format: ScriptFormat; alone: boolean; ed: Ed }) {
  const block = useEditorStore(st => blockIndex(st.scriptBlocks).get(id));
  const owner = useEditorStore(st => textLocks(st.locks).get(id)?.find(l => l.userId !== st.currentUserId && l.expiresAt > Date.now())?.userId);
  const ownerUser = useEditorStore(st => owner ? st.users.find(u => u.id === owner) : undefined);
  const [draft, setDraft] = useState<string | null>(null), [focused, setFocused] = useState(false), [pick, setPick] = useState(-1), [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null), sized = useRef(false);
  const live = useRef({ draft: null as string | null, gesture: '', timer: 0, lease: 0, focused: false, typed: false, owner: undefined as string | undefined });
  live.current.owner = owner;
  const shown = draft ?? block?.text ?? '', writable = editable && !owner;
  // Typing stays local and goes out after 400 ms idle, on blur, on unmount and before anything structural: one history row per pause.
  const commit = () => {
    const l = live.current; window.clearTimeout(l.timer);
    const text = l.draft; if (text === null) return; l.draft = null; setDraft(null);
    const current = blockIndex(s().scriptBlocks).get(id);
    if (current && !l.owner && current.text !== text) s().updateScriptBlock(id, { text }, l.gesture || undefined);
  };
  const setKind = (kind: Kind) => { if (kind !== blockIndex(s().scriptBlocks).get(id)?.kind) s().updateScriptBlock(id, { kind }); };
  // A line removed while focused (joined into the one above, deleted) fires no blur: unfocus it here, or a lock the
  // pending flush is about to take would renew forever on a line the server no longer has ("Lock target not found").
  useEffect(() => () => { const l = live.current; window.clearInterval(l.lease); commit(); if (l.focused) { l.focused = false; s().releaseLock(id, 'text'); } }, [id]);
  useLayoutEffect(() => { if (sized.current && !SIZING && ref.current) fit(ref.current); sized.current = true; }, [shown]);
  const take = () => {
    const l = live.current; l.gesture = `script-${id}-${Date.now()}`;
    // Flush first: the server can only lock a line it has already saved (one split off a moment ago).
    void connection.flush().then(() => {
      if (!l.focused || l.owner) return;
      if (!s().acquireLock(id, 'text')) { ref.current?.blur(); return; }
      window.clearInterval(l.lease); l.lease = window.setInterval(() => { if (!l.owner && !s().renewLock(id, 'text')) s().acquireLock(id, 'text'); }, 3000);
    });
  };
  // A caret waiting in someone else's line takes it the moment it frees up: typing there never goes out unlocked.
  useEffect(() => { if (writable && live.current.focused) take(); }, [writable]);
  if (!block) return null;
  const kind = block.kind;
  // Only after typing in this focus (arrowing onto a cue opens nothing), and never this line's own committed text.
  const query = focused && writable && kind === 'character' && !dismissed && live.current.typed ? cue(shown) : '';
  const matches = query ? ed.names.filter(n => n.startsWith(query) && n !== query && ed.lines.some(b => b.id !== id && b.kind === 'character' && cue(b.text) === n)).slice(0, 5) : [];
  const accept = (name: string) => { live.current.draft = name; setDraft(name); commit(); setDismissed(true); };

  const focus = () => {
    const l = live.current; l.focused = true; l.typed = false; setFocused(true);
    if (writable) take();
  };
  const blur = () => {
    const l = live.current, typed = l.typed; l.focused = false; setFocused(false); window.clearInterval(l.lease);
    if (!editable) return;
    commit();
    // Smart typing: "INT." makes a scene heading, "CUT TO:" a transition, "(" under a name a parenthetical.
    const b = blockIndex(s().scriptBlocks).get(id);
    if (typed && b && !l.owner) setKind(detectKind(b.text, b.kind, ed.prev(id)?.kind));
    s().releaseLock(id, 'text');
  };
  const change = (e: ChangeEvent<HTMLTextAreaElement>) => {
    if (!writable) return;
    const l = live.current; l.draft = e.currentTarget.value; l.typed = true; setDraft(l.draft); setDismissed(false); setPick(-1);
    window.clearTimeout(l.timer); l.timer = window.setTimeout(commit, 400);
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!writable || e.nativeEvent.isComposing) return;
    const el = e.currentTarget, k = e.key, lower = k.toLowerCase(), cmd = e.metaKey || e.ctrlKey, start = el.selectionStart, end = el.selectionEnd, caret = start === end;
    if (matches.length) {
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); setPick(k === 'ArrowDown' ? (pick + 1) % matches.length : (pick <= 0 ? matches.length : pick) - 1); return; }
      // Enter takes a suggestion only once one is picked, so a new or shorter name (SAM beside SAMANTHA) stays as typed; Tab takes the first.
      if (((k === 'Enter' && pick >= 0) || k === 'Tab') && !e.shiftKey) { e.preventDefault(); accept(matches[Math.min(Math.max(pick, 0), matches.length - 1)]); return; }
      if (k === 'Escape') { e.preventDefault(); setDismissed(true); return; }
    }
    if (cmd && lower === 's') { e.preventDefault(); commit(); void connection.flush(); return; }
    // Undo: the browser's own while this line has fresh typing, else the project's history (a split, a join, a kind change).
    if (cmd && !live.current.typed && (lower === 'z' || (e.ctrlKey && !e.metaKey && lower === 'y'))) { e.preventDefault(); commit(); const back = ed.prev(id); if (e.shiftKey || lower === 'y') s().redo(); else s().undo(); if (back && !blockIndex(s().scriptBlocks).has(id)) ed.focus(back.id, 'end', true); return; }
    if (cmd || e.altKey) return;
    if (k === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!el.value.trim() && kind !== 'action') { commit(); setKind('action'); return; }
      const text = el.value.slice(0, start) + el.value.slice(end);
      if (text !== el.value) live.current.draft = text; // typed over a selection
      commit();
      // At the start, the line moves down whole: it keeps its id (its shots), kind and caret, and an empty line opens above.
      if (start === 0 && text) { insertBlocks(block.scriptId, [{ kind: 'action', text: '' }], ed.prev(id)?.id ?? null); ed.focus(id, 0, true); return; }
      const next = detectKind(text, kind, ed.prev(id)?.kind, true); setKind(next);
      const added = s().splitScriptBlock(id, start, start < text.length ? next : nextKind(next)); if (added) ed.focus(added, 0, true);
      return;
    }
    if (k === 'Tab') { e.preventDefault(); commit(); setKind(cycleKind(kind, e.shiftKey ? -1 : 1)); return; }
    if (k === 'Backspace' && caret && start === 0) {
      const prev = ed.prev(id); if (!prev) return; // the first line has nothing to join, and the last one never goes
      e.preventDefault();
      if (!el.value) { const l = live.current; window.clearTimeout(l.timer); l.draft = null; s().deleteScriptBlocks([id]); ed.focus(prev.id, 'end', true); return; }
      commit(); const join = blockIndex(s().scriptBlocks).get(prev.id)?.text.length ?? 0;
      if (s().mergeScriptBlock(id)) ed.focus(prev.id, join, true);
      return;
    }
    // A line that fits one row is its own first and last row: one press moves to the neighbour, not to the line's start or end.
    const one = (k === 'ArrowUp' || k === 'ArrowDown') && !el.value.includes('\n') && el.scrollHeight < parseFloat(getComputedStyle(el).lineHeight) * 1.5;
    if (k === 'ArrowUp' && caret && (start === 0 || one) && !e.shiftKey) { const prev = ed.prev(id); if (prev) { e.preventDefault(); ed.focus(prev.id, 'end'); } return; }
    if (k === 'ArrowDown' && caret && (end === el.value.length || one) && !e.shiftKey) { const next = ed.next(id); if (next) { e.preventDefault(); ed.focus(next.id, 0); } }
  };
  // Several pasted lines read as Fountain: each becomes its own line of the right kind.
  const paste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!writable) return;
    // One line copied with its break (triple-click, a line copy) is still one line: typed in, not split into a new element.
    const all = e.clipboardData.getData('text/plain'), raw = all.replace(/\r?\n$/, '');
    if (!/[\r\n]/.test(raw)) { if (raw !== all) { e.preventDefault(); document.execCommand('insertText', false, raw); } return; }
    const parsed = parseFountain(raw).blocks; if (!parsed.length) return;
    e.preventDefault();
    const el = e.currentTarget, before = el.value.slice(0, el.selectionStart), after = el.value.slice(el.selectionEnd);
    if (before + after !== el.value) live.current.draft = before + after;
    commit();
    let added: string[];
    if (!before.trim() && !after.trim()) { s().updateScriptBlock(id, { kind: parsed[0].kind, text: parsed[0].text }); added = [id, ...insertBlocks(block.scriptId, parsed.slice(1), id)]; }
    else if (!before.trim()) added = insertBlocks(block.scriptId, parsed, ed.prev(id)?.id ?? null);
    else { if (after) s().splitScriptBlock(id, before.length); added = insertBlocks(block.scriptId, parsed, id); }
    const last = added.at(-1); if (last) ed.focus(last, 'end', true);
  };
  const addShot = () => {
    const sceneId = kind === 'scene' ? id : ed.sceneAbove(id);
    const shot = s().addShot({ ...(sceneId ? { sceneId } : {}), ...(kind === 'scene' ? {} : { text: shown.trim().slice(0, 200) }) });
    const number = shot && s().shots.find(x => x.id === shot)?.number; if (number) s().notify(`Added shot ${number}`, 'success');
  };

  const gutter = kind === 'note' ? 'Note' : scene !== undefined && format === 'screenplay' ? String(scene) : '';
  const chip = kind === 'scene' && shots > 0, adder = writable && (kind === 'scene' || (kind === 'action' && !!shown.trim()));
  return <div className={`script-block kind-${kind}${focused ? ' focused' : ''}${owner ? ' owned' : ''}`} data-cursor-anchor={id} style={ownerUser ? { '--owner-color': ownerUser.color } as CSSProperties : undefined}>
    {gutter && <span className="script-gutter" aria-hidden="true">{gutter}</span>}
    {focused && writable && <button type="button" className="script-kind" data-keep-focus aria-haspopup="menu" title="Change element (Tab)" onMouseDown={e => e.preventDefault()} onClick={e => { const r = e.currentTarget.getBoundingClientRect(); ed.kindMenu(id, r.left, r.bottom + 4, ref.current?.selectionStart ?? 0); }}>{SHORT[kind]}</button>}
    <textarea ref={ref} rows={1} data-kind={kind} spellCheck aria-label={`${label(kind, format)} line`} placeholder={writable && (focused || alone) ? hint(kind, format) : undefined} value={shown} readOnly={!writable} maxLength={PLAN_LIMITS.blockText} onChange={change} onFocus={focus} onBlur={blur} onKeyDown={key} onPaste={paste}/>
    {matches.length > 0 && <div className="script-suggest" role="listbox" aria-label="Characters">{matches.map((name, i) => <button type="button" role="option" aria-selected={i === pick} key={name} data-keep-focus onMouseDown={e => e.preventDefault()} onClick={() => accept(name)}>{name}</button>)}</div>}
    {(ownerUser || chip || adder) && <div className="script-side">
      {ownerUser && <span className="script-owner" title={`${ownerUser.name} is editing this line`}><i/>{ownerUser.name}</span>}
      {chip && <button type="button" className="script-shots" title="Open in the shot list" onClick={() => s().openPlan('shots', id)}>{shots}<span> {shots === 1 ? 'shot' : 'shots'}</span></button>}
      {adder && <button type="button" className="script-add-shot" data-keep-focus title={kind === 'scene' ? 'Add a shot to this scene' : 'Add a shot from this line'} onMouseDown={e => e.preventDefault()} onClick={addShot}><Plus size={10}/><span>shot</span></button>}
    </div>}
  </div>;
});

/** The Script tab: a calm page in a screenplay face, with Final Draft's keys (Enter next element, Tab change it). */
export default function ScriptEditor() {
  const projectId = useEditorStore(st => st.projectId);
  const scripts = useEditorStore(useShallow(st => ordered(st.scripts.filter(x => x.projectId === st.projectId))));
  // The store refuses Commenters and Viewers too; asking first keeps them from a toast on every key.
  const editable = useEditorStore(st => { const role = st.projects.find(p => p.id === st.projectId)?.members.find(m => m.userId === st.currentUserId)?.role; return role === 'Owner' || role === 'Editor'; });
  const author = useEditorStore(st => st.users.find(u => u.id === st.currentUserId)?.name);
  const planFocus = useEditorStore(st => st.planFocus);
  const counts = useEditorStore(st => shotCounts(st.shots));
  const remembered = `sharedcut.plan.script.${projectId}`;
  const [chosen, setChosen] = useState(() => load(remembered));
  const [outline, setOutline] = useState(() => load('sharedcut.plan.outline') !== 'closed');
  const [menu, setMenu] = useState<Menu | null>(null), [rename, setRename] = useState<string | null>(null), [deleting, setDeleting] = useState(false);
  const root = useRef<HTMLDivElement>(null), file = useRef<HTMLInputElement>(null), reveal = useRef<string | null>(null);
  const script = scripts.find(x => x.id === chosen) ?? scripts.at(0);
  const lines = useLines(script?.id);
  const numbers = useMemo(() => sceneNumbers(lines), [lines]);
  const names = useMemo(() => [...new Set(lines.filter(b => b.kind === 'character').map(b => cue(b.text)).filter(Boolean))].sort(), [lines]);
  const pages = useMemo(() => pageCount({ name: '', format: script?.format ?? 'screenplay', blocks: lines }), [lines, script?.format]);
  const [ed] = useState<Ed>(() => {
    const at = (id: string) => ed.lines.findIndex(b => b.id === id);
    const ed: Ed = {
      lines: [], names: [], pending: null,
      prev: id => ed.lines[at(id) - 1], next: id => { const i = at(id); return i < 0 ? undefined : ed.lines[i + 1]; },
      sceneAbove: id => { for (let i = at(id); i >= 0; i--) if (ed.lines[i].kind === 'scene') return ed.lines[i].id; },
      // `later`: after the next render, when a line split or joined has its new text (React setting a value moves the caret).
      focus: (id, where, later) => { ed.pending = { id, at: where }; if (!later) ed.apply(); },
      apply: () => {
        const p = ed.pending, el = p && root.current?.querySelector<HTMLTextAreaElement>(`[data-cursor-anchor="${CSS.escape(p.id)}"] textarea`); ed.pending = null;
        if (!p || !el) return;
        el.focus({ preventScroll: true }); const caret = p.at === 'end' ? el.value.length : Math.min(p.at, el.value.length); el.setSelectionRange(caret, caret);
        el.closest('.script-block')?.scrollIntoView({ block: 'nearest' });
      },
      kindMenu: (id, x, y, caret) => setMenu({ kind: 'element', id, caret, x, y }),
    };
    return ed;
  });
  ed.lines = lines; ed.names = names;
  const choose = (id: string) => { setChosen(id); save(remembered, id); };
  const show = (id: string) => {
    const target = root.current?.querySelector<HTMLElement>(`[data-cursor-anchor="${CSS.escape(id)}"]`); if (!target) return;
    target.scrollIntoView({ block: 'center' }); target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); window.setTimeout(() => target.classList.remove('flash'), 1400);
    if (editable) ed.focus(id, 'end');
  };
  // A line, scene or script opened from elsewhere (a shot's scene, the MCP): its script, scrolled to and flashed.
  useEffect(() => {
    if (!planFocus) return;
    const st = s(), block = blockIndex(st.scriptBlocks).get(planFocus);
    const scriptId = block?.projectId === st.projectId ? block.scriptId : st.scripts.some(x => x.id === planFocus && x.projectId === st.projectId) ? planFocus : undefined;
    if (!scriptId) return; // a shot or a card: another tab's to handle
    choose(scriptId); if (block) reveal.current = block.id;
    useEditorStore.setState({ planFocus: null });
  }, [planFocus]);
  useLayoutEffect(() => {
    if (reveal.current) { const id = reveal.current; reveal.current = null; show(id); }
    if (ed.pending) ed.apply();
  });
  useLayoutEffect(() => { if (!SIZING && root.current) fitAll(root.current); }, [script?.id, script?.format]);
  useLayoutEffect(() => { if (!SIZING && root.current) fitAll(root.current, true); }, [lines]);
  useEffect(() => { if (SIZING) return; const refit = () => { if (root.current) fitAll(root.current); }; window.addEventListener('resize', refit); return () => window.removeEventListener('resize', refit); }, []);

  const create = (format: ScriptFormat) => { const id = s().addScript(undefined, format); if (!id) return; choose(id); const first = s().scriptBlocks.find(b => b.scriptId === id); if (first) ed.focus(first.id, 0, true); };
  const addScene = () => { if (!script) return; const [id] = insertBlocks(script.id, [{ kind: 'scene', text: '' }]); if (id) ed.focus(id, 0, true); };
  const doc = (): ScriptDoc => { const st = s(), current = st.scripts.find(x => x.id === script?.id) ?? script!; return { name: current.name, format: current.format, credit: current.credit, author: current.author ?? author, blocks: ordered(st.scriptBlocks.filter(b => b.scriptId === current.id && b.projectId === st.projectId)).map(({ kind, text }) => ({ kind, text })) }; };
  const fileName = () => safeFileName(script?.name ?? 'Script');
  // docs.new has no import API (and CSP blocks Drive calls): copy rich text and open a blank doc in the same click.
  const openDocs = () => { const d = doc(), copied = copyRich(toHtml(d), toFountain(d)); window.open('https://docs.new', '_blank', 'noopener'); void copied.then(ok => ok ? s().notify('Copied. Paste it into the new Google Doc.', 'success') : s().notify('Could not copy the script', 'error', 'Use Download Word (.docx) and open it from Google Drive.')); };
  const copy = () => { const d = doc(); void copyRich(toHtml(d), toFountain(d)).then(ok => ok ? s().notify('Copied the script', 'success') : s().notify('Could not copy the script', 'error', 'Use Download Word (.docx) instead.')); };
  const importFile = async (f: File) => {
    let parsed: ReturnType<typeof parseFountain>;
    try { parsed = parseFountain(await f.text()); } catch { s().notify('Could not read that file', 'error'); return; }
    if (!parsed.blocks.length) { s().notify('Nothing to import in that file', 'info'); return; }
    let id: string | undefined = script?.id;
    if (!id) { id = s().addScript(parsed.title || f.name.replace(/\.[^.]+$/, ''), 'screenplay'); if (!id) return; choose(id); }
    const had = s().scripts.find(x => x.id === id);
    if (parsed.credit && !had?.credit || parsed.author && !had?.author) s().updateScript(id, { ...(parsed.credit && !had?.credit ? { credit: parsed.credit } : {}), ...(parsed.author && !had?.author ? { author: parsed.author } : {}) });
    // A new script's one empty line takes the first imported one rather than staying above it.
    const current = ordered(s().scriptBlocks.filter(b => b.scriptId === id)), lone = current.length === 1 && !current[0].text.trim() ? current[0] : undefined;
    let rest = parsed.blocks;
    if (lone) { s().updateScriptBlock(lone.id, { kind: rest[0].kind, text: rest[0].text }); rest = rest.slice(1); }
    insertBlocks(id, rest);
    s().notify(`Imported ${parsed.blocks.length} ${parsed.blocks.length === 1 ? 'line' : 'lines'}`, 'success');
  };
  const act = (run: () => void) => () => { setMenu(null); run(); };
  const openMenu = (kind: 'scripts' | 'export') => (e: { currentTarget: HTMLElement }) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ kind, x: r.right - 228, y: r.bottom + 4 }); };
  const fileInput = <input ref={file} type="file" hidden accept=".fountain,.txt,.md,text/plain" onChange={e => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) void importFile(f); }}/>;

  if (!script) return <div className="script-editor script-empty">{fileInput}
    <EmptyState icon={<ScrollText size={28}/>} title="No script yet" description={editable ? 'Write it here. Scene headings become groups in the shot list.' : 'The script shows up here once an editor starts it.'} action={editable ? <div className="script-empty-actions">
      <Button variant="primary" onClick={() => create('screenplay')}><FilePlus2 size={14}/>New screenplay</Button>
      <Button onClick={() => create('stage')}><Drama size={14}/>New stage play</Button>
      <Button variant="ghost" onClick={() => file.current?.click()}><Upload size={14}/>Import Fountain or text…</Button>
    </div> : undefined}/>
  </div>;

  const scenes = lines.filter(b => b.kind === 'scene'), elementKind = menu?.kind === 'element' ? lines.find(b => b.id === menu.id)?.kind : undefined;
  return <div className="script-editor" ref={root}>{fileInput}
    <PlanActions>
      <button type="button" className="script-switcher" aria-haspopup="menu" title="Scripts" onClick={openMenu('scripts')}>{script.format === 'stage' ? <Drama size={14}/> : <FileText size={14}/>}<span>{script.name}</span><ChevronDown size={12}/></button>
      <Button variant="ghost" className="script-export" aria-label="Export" title="Export" aria-haspopup="menu" onClick={openMenu('export')}><FileOutput size={15}/><span>Export</span></Button>
    </PlanActions>
    <aside className={`script-outline${outline ? '' : ' collapsed'}`} aria-label="Scenes">
      <div className="script-outline-head">{outline && <span className="eyebrow">SCENES</span>}<span className="spacer"/><IconButton label={outline ? 'Hide scenes' : 'Show scenes'} onClick={() => { setOutline(!outline); save('sharedcut.plan.outline', outline ? 'closed' : 'open'); }}>{outline ? <PanelLeftClose size={14}/> : <PanelLeftOpen size={14}/>}</IconButton></div>
      {outline && <>
        <div className="script-outline-list">{scenes.map(b => <button type="button" key={b.id} onClick={() => show(b.id)}><span className="mono">{numbers.get(b.id)}</span><span className="script-outline-text">{b.text.trim() || 'New scene'}</span>{!!counts.get(b.id) && <Badge>{counts.get(b.id)}</Badge>}</button>)}{!scenes.length && <p className="muted">Scene headings show up here.</p>}</div>
        {editable && <button type="button" className="script-outline-add" onClick={addScene}><Plus size={12}/>Scene</button>}
      </>}
    </aside>
    <div className="script-scroll">
      <div className="script-column">
        <div className={`script-page format-${script.format}`}>
          {lines.map(b => <Block key={b.id} id={b.id} scene={numbers.get(b.id)} shots={counts.get(b.id) ?? 0} editable={editable} format={script.format} alone={lines.length === 1} ed={ed}/>)}
          {!lines.length && (editable ? <button type="button" className="script-start" onClick={addScene}>Start writing</button> : <p className="script-start">This script is empty.</p>)}
        </div>
        <footer className="script-footer"><span>{script.format === 'stage' ? 'Stage play' : 'Screenplay'} · {scenes.length} {scenes.length === 1 ? 'scene' : 'scenes'} · ~{pages} {pages === 1 ? 'page' : 'pages'}</span>{editable && <span className="script-keys">Enter next · Tab element · Shift+Enter line break</span>}</footer>
      </div>
    </div>
    {menu?.kind === 'scripts' && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      <span className="menu-heading">Scripts</span>
      {scripts.map(x => <button type="button" role="menuitem" key={x.id} onClick={act(() => choose(x.id))}>{x.id === script.id ? <Check size={13}/> : <i className="script-menu-blank"/>}<span className="script-menu-name">{x.name}</span></button>)}
      {editable && <><div className="divider"/>
        <button type="button" role="menuitem" onClick={act(() => create('screenplay'))}><FilePlus2 size={13}/>New screenplay</button>
        <button type="button" role="menuitem" onClick={act(() => create('stage'))}><Drama size={13}/>New stage play</button>
        <button type="button" role="menuitem" onClick={act(() => setRename(script.name))}><Pencil size={13}/>Rename…</button>
        <button type="button" role="menuitem" onClick={act(() => s().updateScript(script.id, { format: script.format === 'stage' ? 'screenplay' : 'stage' }))}><ArrowLeftRight size={13}/>{script.format === 'stage' ? 'Make it a screenplay' : 'Make it a stage play'}</button>
        <button type="button" role="menuitem" onClick={act(() => setDeleting(true))}><Trash2 size={13}/>Delete script…</button>
      </>}
    </ContextMenu>}
    {menu?.kind === 'export' && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      <button type="button" role="menuitem" onClick={act(openDocs)}><ExternalLink size={13}/>Open in Google Docs</button>
      <button type="button" role="menuitem" onClick={act(copy)}><Copy size={13}/>Copy formatted text</button>
      <button type="button" role="menuitem" onClick={act(() => downloadFile(`${fileName()}.docx`, toDocx(doc()), DOCX))}><FileDown size={13}/>Download Word (.docx)</button>
      <button type="button" role="menuitem" onClick={act(() => downloadFile(`${fileName()}.fountain`, toFountain(doc()), 'text/plain;charset=utf-8'))}><FileText size={13}/>Download Fountain (.fountain)</button>
      <button type="button" role="menuitem" onClick={act(() => printHtml(toHtml(doc(), { page: true })))}><Printer size={13}/>Print or save as PDF</button>
      {editable && <><div className="divider"/><button type="button" role="menuitem" onClick={act(() => file.current?.click())}><Upload size={13}/>Import Fountain or text…</button></>}
    </ContextMenu>}
    {menu?.kind === 'element' && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
      <span className="menu-heading">Element</span>
      {KINDS.map(k => <button type="button" role="menuitem" key={k} onClick={() => { setMenu(null); s().updateScriptBlock(menu.id, { kind: k }); ed.focus(menu.id, menu.caret, true); }}>{k === elementKind ? <Check size={13}/> : <i className="script-menu-blank"/>}{label(k, script.format)}</button>)}
    </ContextMenu>}
    {rename !== null && <Modal title="Rename script" onClose={() => setRename(null)}>
      <form onSubmit={e => { e.preventDefault(); s().updateScript(script.id, { name: rename }); setRename(null); }}>
        <div className="modal-body"><Field label="Name"><input value={rename} maxLength={PLAN_LIMITS.field} onChange={e => setRename(e.target.value)}/></Field></div>
        <div className="modal-actions"><Button variant="ghost" onClick={() => setRename(null)}>Cancel</Button><Button variant="primary" type="submit" disabled={!rename.trim()}>Rename</Button></div>
      </form>
    </Modal>}
    {deleting && <Modal title="Delete script?" onClose={() => setDeleting(false)}>
      <div className="modal-body"><p>“{script.name}” and all its lines go. Its shots stay in the shot list.</p></div>
      <div className="modal-actions"><Button variant="ghost" onClick={() => setDeleting(false)}>Cancel</Button><Button variant="danger" onClick={() => { s().deleteScript(script.id); setDeleting(false); }}><Trash2 size={13}/>Delete script</Button></div>
    </Modal>}
  </div>;
}
