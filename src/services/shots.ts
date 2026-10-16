// Shot list rules shared by the Plan workspace, the media bin badges, the MCP and the tests: take matching by clip name,
// scene grouping and the CSV/HTML exports. Pure and DOM-free.
import type { MediaAsset, Script, ScriptBlock, Shot } from '../state/models.ts';
import { ordered, sceneNumbers } from './plan.ts';

export const SHOT_SIZES = ['EWS', 'WS', 'MWS', 'MS', 'MCU', 'CU', 'ECU', 'Insert', 'OTS', 'POV', 'Two-shot'] as const;
export const SHOT_MOVES = ['Static', 'Pan', 'Tilt', 'Push in', 'Pull out', 'Dolly', 'Tracking', 'Handheld', 'Gimbal', 'Crane', 'Zoom', 'Whip pan'] as const;

/** A shot number in one comparable form: '03a' → '3A', ' 12 b ' → '12B'. */
export const shotKey = (code: string) => code.replace(/\s+/g, '').toUpperCase().replace(/^0+(?=\d)/, '');

// Crew naming: a leading code ('3A_take2', '12', '4b.mov') or a 'shot'/'sh' marker ('Shot 3A', 'Trailer_SH12B_T3').
// Camera and phone names (IMG_0003, C0012, A001C003, 20261023_1530) start with letters or long numbers, so they never match.
const MARKED = /(?:^|[^a-z])(?:shot|sh)[ _-]?(\d{1,3}[a-z]{0,2})(?![a-z\d])/i, LEADING = /^(\d{1,3}[a-z]{0,2})(?:$|[ _.-])/i;
/** The shot code a clip name carries, if any. */
export function takeShotKey(mediaName: string): string | undefined {
  const name = mediaName.trim().replace(/\.[a-z\d]{1,5}$/i, ''), code = (MARKED.exec(name) ?? LEADING.exec(name))?.[1];
  return code ? shotKey(code) : undefined;
}
type Media = Pick<MediaAsset, 'id' | 'name' | 'projectId' | 'kind'>;
const pictures = (media: Media) => media.kind === 'video' || media.kind === 'image';

/** Which shot each take belongs to (media id → shot id): a hand link beats a name match, and the first shot in order wins a tie. */
export function takesIndex(shots: readonly Shot[], media: readonly Media[]) {
  const index = new Map<string, string>(), byId = new Map(media.map(m => [m.id, m])), byKey = new Map<string, string>(), sorted = ordered(shots);
  for (const shot of sorted) for (const id of shot.mediaIds ?? []) if (!index.has(id) && byId.get(id)?.projectId === shot.projectId) index.set(id, shot.id);
  for (const shot of sorted) { const key = `${shot.projectId}\n${shotKey(shot.number)}`; if (shotKey(shot.number) && !byKey.has(key)) byKey.set(key, shot.id); }
  for (const m of media) { const code = pictures(m) && !index.has(m.id) ? takeShotKey(m.name) : undefined, shot = code && byKey.get(`${m.projectId}\n${code}`); if (shot) index.set(m.id, shot); }
  return index;
}

/** Every shot's takes (shot id → media ids): its own hand links still in the project first, then clips named for it, by name.
 * A name match goes only to the shot takesIndex gives it, so a take hand-linked to 2A no longer shows (unremovable) under 1A.
 * One pass over shots and media: a shot edit never rescans the bin per shot. */
export function shotTakes(shots: readonly Shot[], media: readonly Media[]) {
  const owner = takesIndex(shots, media), byId = new Map(media.map(m => [m.id, m])), named = new Map<string, Media[]>();
  for (const m of media) { const shot = owner.get(m.id); if (shot) (named.get(shot) ?? named.set(shot, []).get(shot)!).push(m); }
  return new Map(shots.map(shot => [shot.id, [...new Set([...(shot.mediaIds ?? []).filter(id => byId.get(id)?.projectId === shot.projectId), ...(named.get(shot.id) ?? []).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(m => m.id)])]]));
}

export interface ShotGroup { sceneId?: string; scene?: number; label: string; shots: Shot[] }
/** Shots under their scenes in reading order (empty scenes included, for '+ shot'), then 'No scene' for the rest. */
export function groupShots(shots: readonly Shot[], scripts: readonly Pick<Script, 'id' | 'name' | 'order'>[], blocks: readonly ScriptBlock[]): ShotGroup[] {
  const groups: ShotGroup[] = [], byScene = new Map<string, ShotGroup>(), none: Shot[] = [], byScript = new Map<string, ScriptBlock[]>();
  for (const block of blocks) byScript.set(block.scriptId, [...byScript.get(block.scriptId) ?? [], block]);
  for (const script of ordered(scripts)) {
    const own = byScript.get(script.id) ?? [], numbers = sceneNumbers(own);
    for (const block of ordered(own)) if (block.kind === 'scene') {
      const group: ShotGroup = { sceneId: block.id, scene: numbers.get(block.id), label: `${scripts.length > 1 ? `${script.name} · ` : ''}${numbers.get(block.id)}. ${block.text.trim().toUpperCase()}`.trim(), shots: [] };
      groups.push(group); byScene.set(block.id, group);
    }
  }
  for (const shot of ordered(shots)) (shot.sceneId && byScene.get(shot.sceneId)?.shots || none).push(shot);
  if (none.length) groups.push({ label: 'No scene', shots: none });
  return groups;
}

export interface ShotRow { number: string; scene: string; size: string; movement: string; text: string; cast: string; location: string; notes: string; done: boolean; takes: number }
const HEADER = ['Shot', 'Scene', 'Size', 'Movement', 'Description', 'Cast', 'Location', 'Notes', 'Done', 'Takes'];
const cells = (row: ShotRow) => [row.number, row.scene, row.size, row.movement, row.text, row.cast, row.location, row.notes, row.done ? 'Yes' : '', String(row.takes)];
// A cell starting = + - @ runs as a formula in Excel and Sheets; the leading quote keeps it text.
const csvCell = (value: string) => { const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
/** RFC 4180 CSV with CRLF lines. */
export const shotsCsv = (rows: ShotRow[]) => [HEADER, ...rows.map(cells)].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const CELL = 'border:1px solid #999;padding:4px 6px;text-align:left;vertical-align:top;font-family:Arial,sans-serif;font-size:10pt;color:#000';
/** The shot list as a table with inline styles (pastes into Google Docs and Sheets); `page` makes a printable landscape document. */
export function shotsHtml(rows: ShotRow[], title: string, options: { page?: boolean } = {}) {
  const table = `<table style="border-collapse:collapse;width:100%"><thead><tr>${HEADER.map(h => `<th style="${CELL};background:#eee;font-weight:bold">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr style="break-inside:avoid;page-break-inside:avoid">${cells(row).map(cell => `<td style="${CELL}">${escape(cell).replace(/\r?\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return options.page ? `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title><style>@page { size: letter landscape; margin: 0.5in } body { margin: 0; background: #fff } thead { display: table-header-group }</style></head><body><h1 style="font-family:Arial,sans-serif;font-size:16pt;margin:0 0 12pt">${escape(title)}</h1>${table}</body></html>` : table;
}
