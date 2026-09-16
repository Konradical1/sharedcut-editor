import type { PersistedState } from './index.ts';

type Item = { id: string };
type CollectionDelta = { upsert: Item[]; remove: string[]; order?: string[] };
export type StateDelta = Partial<Record<keyof PersistedState, unknown>>;
export function stateEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => stateEqual(item, b[i]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length && keys.every(key => stateEqual(left[key], right[key]));
}
const equal = stateEqual;

export function shareState(base: PersistedState, next: PersistedState): PersistedState {
  const shared = { ...next };
  for (const key of Object.keys(base) as (keyof PersistedState)[]) {
    const before = base[key], after = next[key];
    if (before === after) continue;
    if (!Array.isArray(before) || !Array.isArray(after)) { if (equal(before, after)) Object.assign(shared, { [key]: before }); continue; }
    const old = new Map<string, Item>(before.map(item => [item.id, item]));
    const items = after.map(item => equal(old.get(item.id), item) ? old.get(item.id)! : item);
    Object.assign(shared, { [key]: items.length === before.length && items.every((item, i) => item === before[i]) ? before : items });
  }
  return shared;
}

// New entries normally go first (history/media). Only send an order list for a real reorder.
export function stateDelta(base: PersistedState, next: PersistedState): StateDelta {
  const delta: StateDelta = {};
  for (const key of Object.keys(base) as (keyof PersistedState)[]) {
    const before = base[key], after = next[key];
    if (before === after) continue;
    if (!Array.isArray(before) || !Array.isArray(after)) { if (!equal(before, after)) delta[key] = after; continue; }
    const old = new Map<string, Item>(before.map(item => [item.id, item]));
    const ids = new Set(after.map(item => item.id));
    const upsert = after.filter(item => !equal(old.get(item.id), item));
    const remove = before.filter(item => !ids.has(item.id)).map(item => item.id);
    const natural = [...after.filter(item => !old.has(item.id)), ...before.filter(item => ids.has(item.id))].map(item => item.id);
    const order = after.map(item => item.id);
    if (upsert.length || remove.length || !equal(natural, order)) delta[key] = { upsert, remove, ...(!equal(natural, order) ? { order } : {}) };
  }
  return delta;
}

// Validate the transport shape here; the server still checks entity schemas, roles and locks.
export function applyStateDelta(base: PersistedState, delta: StateDelta): PersistedState {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('Invalid state delta.');
  const next = { ...base };
  for (const [key, value] of Object.entries(delta)) {
    if (!Object.hasOwn(base, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid state field.');
    const before = base[key as keyof PersistedState];
    if (!Array.isArray(before)) { Object.assign(next, { [key]: value }); continue; }
    const change = value as CollectionDelta;
    if (!change || !Array.isArray(change.upsert) || !Array.isArray(change.remove) || change.upsert.length > 100_000 || change.remove.length > 100_000 ||
        change.upsert.some(item => !item || typeof item !== 'object' || typeof item.id !== 'string') || change.remove.some(id => typeof id !== 'string') ||
        new Set(change.upsert.map(item => item.id)).size !== change.upsert.length || new Set(change.remove).size !== change.remove.length) throw new Error('Invalid collection delta.');
    const removed = new Set(change.remove), updates = new Map(change.upsert.map(item => [item.id, item]));
    if (change.upsert.some(item => removed.has(item.id))) throw new Error('Ambiguous collection delta.');
    const oldIds = new Set(before.map(item => item.id));
    let items: Item[] = [...change.upsert.filter(item => !oldIds.has(item.id)), ...before.filter(item => !removed.has(item.id)).map(item => updates.get(item.id) ?? item)];
    if (change.order !== undefined) {
      if (!Array.isArray(change.order) || change.order.length !== items.length || new Set(change.order).size !== items.length) throw new Error('Invalid collection order.');
      const byId = new Map(items.map(item => [item.id, item]));
      items = change.order.map(id => { const item = byId.get(id); if (!item) throw new Error('Invalid collection order.'); return item; });
    }
    if (items.length > 100_000) throw new Error('Collection is too large.');
    Object.assign(next, { [key]: items });
  }
  return next;
}
