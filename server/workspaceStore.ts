import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { statSync } from 'node:fs';

// The workspace lives in memory and in `workspace_items`, one row per entity ordered by `seq`, so a
// save writes only what changed. Writing the whole 37 MB JSON row on every edit blocked the server
// for most of a second and queued every media request behind it.
//
// `workspace.state` — the single JSON row older builds and the scripts read — is still kept whole:
// written on a clean shutdown, at startup when stale, and at most once a minute by a worker thread
// while edits come in. Anything else that writes that row (an older build after a rollback,
// project-bundle.mjs) trips a trigger, and the next start imports the row instead of the items.
export const COLLECTIONS = ['projects', 'media', 'timelines', 'clips', 'tracks', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'] as const;
type State = Record<string, unknown>;
type Row = { rowid: number; seq: number };
type Table = { array: readonly unknown[]; rows: Map<unknown, Row> };
const EMPTY: readonly unknown[] = Object.freeze([]);

const SCHEMA = `CREATE TABLE IF NOT EXISTS workspace_items(collection TEXT NOT NULL,id TEXT,seq REAL NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workspace_items_order ON workspace_items(collection,seq);
CREATE TABLE IF NOT EXISTS workspace_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT OR IGNORE INTO workspace_meta(key,value) VALUES('legacyWritten','0');
CREATE TRIGGER IF NOT EXISTS workspace_row_inserted AFTER INSERT ON workspace BEGIN UPDATE workspace_meta SET value='1' WHERE key='legacyWritten'; END;
CREATE TRIGGER IF NOT EXISTS workspace_row_updated AFTER UPDATE ON workspace BEGIN UPDATE workspace_meta SET value='1' WHERE key='legacyWritten'; END;`;
// The triggers only UPDATE: inside a trigger SQLite applies the firing statement's conflict policy,
// so an INSERT OR REPLACE there fails under the upsert older builds write the row with.

// Everything the store has written is frozen: entities are compared by reference, so one changed in
// place would silently never be saved. Freezing turns that mistake into an error where it happens.
export const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) freeze(item); }
  return value;
};
const meta = (db: DatabaseSync) => Object.fromEntries((db.prepare('SELECT key,value FROM workspace_meta').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
const setMeta = (db: DatabaseSync, key: string, value: string) => db.prepare('INSERT INTO workspace_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
const rollback = (db: DatabaseSync) => { if (db.isTransaction) db.exec('ROLLBACK'); };
const isCollection = (key: string) => (COLLECTIONS as readonly string[]).includes(key);
const fieldsJson = (state: State) => JSON.stringify(Object.fromEntries(Object.entries(state).filter(([key]) => !isCollection(key))));

/** The whole workspace as the legacy JSON row, spliced from the stored rows without parsing them. */
export function legacyJson(db: DatabaseSync) {
  db.exec('BEGIN');
  try {
    const values = meta(db), fields = JSON.parse(values.fields ?? '{}') as State, lists = new Map<string, string[]>(COLLECTIONS.map(key => [key, []]));
    for (const row of db.prepare('SELECT collection,data FROM workspace_items ORDER BY collection,seq,rowid').all() as { collection: string; data: string }[]) {
      let list = lists.get(row.collection); if (!list) lists.set(row.collection, list = []); list.push(row.data);
    }
    const parts = [...lists].map(([key, items]) => `${JSON.stringify(key)}:[${items.join(',')}]`);
    for (const [key, value] of Object.entries(fields)) if (value !== undefined && !lists.has(key)) parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
    return { revision: Number(values.revision ?? 0), json: `{${parts.join(',')}}` };
  } finally { if (db.isTransaction) db.exec('COMMIT'); }
}

/** Rewrites `workspace.state` from the rows. Never replaces a newer copy with an older one. */
export function writeLegacy(db: DatabaseSync) {
  const { revision, json } = legacyJson(db);
  JSON.parse(json); // a broken splice must never reach the copy a rollback depends on
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Number(meta(db).legacyRevision ?? -1) <= revision) {
      db.prepare('INSERT INTO workspace(id,revision,state) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state').run(revision, json);
      setMeta(db, 'legacyWritten', '0'); setMeta(db, 'legacyRevision', String(revision));
    }
    db.exec('COMMIT');
  } catch (error) { rollback(db); throw error; }
  return revision;
}

// Positions of one longest strictly increasing run through `values`: the entries that keep their seq.
function increasing(values: number[]) {
  const tails: number[] = [], previous: number[] = [];
  values.forEach((value, i) => {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >> 1; if (values[tails[mid]] < value) low = mid + 1; else high = mid; }
    previous[i] = low ? tails[low - 1] : -1; tails[low] = i;
  });
  const kept = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) kept.add(i);
  return kept;
}
/**
 * A seq for every entry of `array`, a stretch lying between the seqs `low` and `high`, keeping as many
 * stored ones as possible; the rest go between their neighbours. Undefined when they no longer fit:
 * doubles run out of room after ~50 inserts into one gap, and then the list is renumbered once.
 */
export function sequence(array: readonly unknown[], old: Map<unknown, Row>, low?: number, high?: number) {
  const seqs = array.map(item => old.get(item)?.seq ?? NaN), known = seqs.flatMap((seq, i) => Number.isNaN(seq) ? [] : [i]);
  if (known.some((i, j) => j && !(seqs[known[j - 1]] < seqs[i]))) { const kept = increasing(known.map(i => seqs[i])); known.forEach((i, j) => { if (!kept.has(j)) seqs[i] = NaN; }); }
  for (let i = 0; i < seqs.length;) {
    if (!Number.isNaN(seqs[i])) { i++; continue; }
    let end = i; while (end < seqs.length && Number.isNaN(seqs[end])) end++;
    const before = i ? seqs[i - 1] : low, after = end < seqs.length ? seqs[end] : high, count = end - i;
    for (let k = 0; k < count; k++) seqs[i + k] = before === undefined ? (after === undefined ? k : after - count + k) : after === undefined ? before + 1 + k : before + (after - before) * (k + 1) / (count + 1);
    i = end;
  }
  let previous = low ?? -Infinity;
  for (const seq of seqs) { if (!Number.isFinite(seq) || !(previous < seq)) return undefined; previous = seq; }
  return high === undefined || previous < high ? seqs : undefined;
}

export function workspaceStore(db: DatabaseSync, path: string, options: { legacyEveryMs?: number } = {}) {
  db.exec(SCHEMA);
  // Checkpoints run on the worker; otherwise the one after a big legacy write lands on the next small save.
  db.exec('PRAGMA wal_autocheckpoint=0');
  const legacyEveryMs = Math.max(20, options.legacyEveryMs ?? 60_000);
  const insert = db.prepare('INSERT INTO workspace_items(collection,id,seq,data) VALUES(?,?,?,?)');
  const remove = db.prepare('DELETE FROM workspace_items WHERE rowid=?');
  const move = db.prepare('UPDATE workspace_items SET seq=? WHERE rowid=?');
  const json = new WeakMap<object, string>();
  let tables = new Map<string, Table>(), fields = '', persisted = 0;
  // undefined: no transaction; null: inside transaction() with nothing saved yet; else the save waiting on COMMIT.
  let transaction: { apply: () => void } | null | undefined;
  let worker: Worker | undefined, busy = false, closed = false, legacyAt = Date.now(), savedAt = 0, legacyRevision = Number(meta(db).legacyRevision ?? -1);
  const keys = () => new Set<string>([...COLLECTIONS, ...tables.keys()]);

  // Writes one list's difference. Only the stretch between the unchanged head and tail can differ, and an
  // edit usually touches one entry there. The row map changes only when `apply` runs after COMMIT.
  const writeCollection = (key: string, array: readonly unknown[], table?: Table) => {
    if (!Array.isArray(array)) throw new Error(`The workspace ${key} is not a list.`);
    const old = table?.array ?? EMPTY, rows = table?.rows ?? new Map<unknown, Row>();
    let head = 0, tail = 0;
    while (head < array.length && head < old.length && array[head] === old[head]) head++;
    while (tail < array.length - head && tail < old.length - head && array[array.length - 1 - tail] === old[old.length - 1 - tail]) tail++;
    const window = array.slice(head, array.length - tail), gone = new Set(old.slice(head, old.length - tail)), present = new Set(window);
    // A stored entry in the stretch that did not come from it is still in the head or tail as well.
    if (present.size !== window.length || window.some(item => rows.has(item) && !gone.has(item))) throw new Error(`The workspace ${key} list holds one entry twice.`);
    const changes: [unknown, Row | undefined][] = [];
    for (const item of gone) if (!present.has(item)) { remove.run(rows.get(item)!.rowid); changes.push([item, undefined]); }
    const place = (item: unknown, seq: number) => {
      const row = rows.get(item);
      if (row) { if (row.seq !== seq) { move.run(seq, row.rowid); changes.push([item, { rowid: row.rowid, seq }]); } return; }
      if (!item || typeof item !== 'object') throw new Error(`The workspace ${key} list holds a value that is not an entry.`);
      const text = JSON.stringify(item), id = (item as { id?: unknown }).id;
      changes.push([item, { rowid: Number(insert.run(key, typeof id === 'string' ? id : null, seq, text).lastInsertRowid), seq }]);
      json.set(item, text); freeze(item);
    };
    const seqs = sequence(window, rows, head ? rows.get(array[head - 1])!.seq : undefined, tail ? rows.get(array[array.length - tail])!.seq : undefined);
    if (seqs) window.forEach((item, i) => place(item, seqs[i])); else array.forEach(place);
    return { table: { array: Object.freeze(array), rows }, apply: () => { for (const [item, row] of changes) if (row) rows.set(item, row); else rows.delete(item); } };
  };
  // Writes the difference between `state` and what was last stored; the caches move only once committed.
  const write = (state: State, revision: number) => {
    const next = new Map(tables), text = fieldsJson(state), applied: (() => void)[] = [];
    for (const key of keys()) {
      const array = (state[key] ?? EMPTY) as readonly unknown[];
      if (next.get(key)?.array === array) continue;
      const written = writeCollection(key, array, next.get(key)); next.set(key, written.table); applied.push(written.apply);
    }
    if (text !== fields) setMeta(db, 'fields', text);
    setMeta(db, 'revision', String(revision));
    return () => { for (const apply of applied) apply(); tables = next; fields = text; persisted = revision; savedAt = Date.now(); };
  };
  const writeLegacyNow = () => { legacyRevision = writeLegacy(db); legacyAt = Date.now(); };

  const run = (task: 'legacy' | 'checkpoint') => {
    busy = true;
    if (!worker) {
      const spawned = worker = new Worker(new URL(import.meta.url), { workerData: { workspaceWorker: path } }); spawned.unref();
      spawned.on('message', (reply: { revision?: number; error?: string }) => {
        busy = false;
        if (reply.error) console.error('Workspace backup failed:', reply.error);
        else if (reply.revision !== undefined) { legacyRevision = reply.revision; legacyAt = Date.now(); }
      });
      spawned.on('error', error => console.error('Workspace backup worker failed:', error));
      spawned.on('exit', () => { if (worker === spawned) { worker = undefined; busy = false; } });
    }
    worker.postMessage(task);
  };
  // Waits for a quiet second so the write lock the copy takes does not stall a save, unless saves never stop.
  const tick = () => {
    if (closed || busy) return;
    const now = Date.now(), due = persisted !== legacyRevision && now - legacyAt >= legacyEveryMs && (now - savedAt >= 1000 || now - legacyAt >= 2 * legacyEveryMs);
    let wal = 0; try { wal = statSync(`${path}-wal`).size; } catch { /* no write-ahead log yet */ }
    if (due) run('legacy'); else if (wal > 8 * 1024 * 1024) run('checkpoint');
  };
  const timer = setInterval(tick, Math.min(5_000, legacyEveryMs)); timer.unref();

  return {
    /** The rows are the current copy: migrated, and nothing else has written the legacy row since. */
    current: () => { const values = meta(db); return values.revision !== undefined && values.legacyWritten !== '1'; },
    revision: () => Number(meta(db).revision ?? 0),
    load() {
      const values = meta(db), lists = new Map<string, unknown[]>(COLLECTIONS.map(key => [key, []])), rows = new Map<string, Map<unknown, Row>>();
      for (const row of db.prepare('SELECT rowid,collection,seq,data FROM workspace_items ORDER BY collection,seq,rowid').all() as { rowid: number; collection: string; seq: number; data: string }[]) {
        const item = JSON.parse(row.data) as object; json.set(item, row.data);
        let list = lists.get(row.collection); if (!list) lists.set(row.collection, list = []); list.push(item);
        let table = rows.get(row.collection); if (!table) rows.set(row.collection, table = new Map()); table.set(item, { rowid: Number(row.rowid), seq: row.seq });
      }
      tables = new Map([...lists].map(([key, list]) => [key, { array: freeze(list), rows: rows.get(key) ?? new Map() }]));
      const state: State = { ...JSON.parse(values.fields ?? '{}'), ...Object.fromEntries(lists) };
      fields = fieldsJson(state); persisted = Number(values.revision);
      return { state, revision: persisted };
    },
    /** Replaces every row with `state`: the first migration, or a legacy row written by something else. */
    replace(state: object, revision: number) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM workspace_items'); tables = new Map(); fields = '';
        const apply = write(state as State, revision); setMeta(db, 'legacyWritten', '0'); setMeta(db, 'legacyRevision', '-1'); db.exec('COMMIT'); apply();
      } catch (error) { rollback(db); throw error; }
      legacyRevision = -1;
    },
    /** Commits the difference between `state` and the stored copy; inside transaction() it commits with it. */
    save(state: object, revision: number) {
      if (transaction) throw new Error('The workspace was saved twice in one transaction.');
      if (transaction === null) { transaction = { apply: write(state as State, revision) }; return; }
      if (db.isTransaction) throw new Error('Save the workspace through transaction(), not an open SQL transaction.');
      db.exec('BEGIN IMMEDIATE');
      let apply: () => void;
      try { apply = write(state as State, revision); db.exec('COMMIT'); } catch (error) { rollback(db); throw error; }
      apply();
    },
    /** Runs `work` in one SQLite transaction; a save inside it counts only if the whole thing commits. */
    transaction(work: () => void) {
      if (transaction !== undefined || db.isTransaction) throw new Error('Workspace transactions do not nest.');
      db.exec('BEGIN IMMEDIATE'); transaction = null;
      try { work(); db.exec('COMMIT'); } catch (error) { transaction = undefined; rollback(db); throw error; }
      const done = transaction as { apply: () => void } | null; transaction = undefined; done?.apply();
    },
    /** Whether `state` differs from the stored copy: a replaced list or a changed top-level field. */
    dirty: (state: object) => fieldsJson(state as State) !== fields || [...keys()].some(key => tables.get(key)?.array !== ((state as State)[key] ?? EMPTY)),
    /** Whether `item` is, by reference, an entity of `key` as last committed: accepted once and frozen since. */
    holds: (key: string, item: unknown) => tables.get(key)?.rows.has(item) ?? false,
    /** The `key` list as last committed. */
    stored: (key: string) => tables.get(key)?.array ?? EMPTY,
    /** The JSON an entity was stored as, so a full download is spliced instead of serialised again. */
    json: (item: unknown) => item && typeof item === 'object' ? json.get(item) : undefined,
    legacyCurrent: () => legacyRevision === persisted && meta(db).legacyWritten !== '1',
    writeLegacy: writeLegacyNow,
    async close() {
      closed = true; clearInterval(timer);
      // Let a copy in flight finish rather than killing it inside its write.
      const running = worker;
      if (running) await new Promise(resolve => { running.once('exit', resolve); running.postMessage('close'); setTimeout(() => void running.terminate(), 30_000).unref(); });
      legacyRevision = Number(meta(db).legacyRevision ?? -1);
      if (legacyRevision !== persisted || meta(db).legacyWritten === '1') writeLegacyNow();
    },
  };
}
export type WorkspaceStore = ReturnType<typeof workspaceStore>;

if (!isMainThread && workerData?.workspaceWorker) {
  const db = new DatabaseSync(workerData.workspaceWorker as string, { timeout: 10_000 });
  // This copy is only the rollback fallback; losing its last write to a power cut costs nothing.
  db.exec('PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0');
  parentPort!.on('message', (task: 'legacy' | 'checkpoint' | 'close') => {
    if (task === 'close') { db.close(); parentPort!.close(); return; }
    try {
      const revision = task === 'legacy' ? writeLegacy(db) : undefined;
      db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      parentPort!.postMessage({ revision });
    } catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
