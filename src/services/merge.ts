import { stateEqual as equal } from './stateDelta.ts';
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const keyed = (value: unknown): value is { id: string }[] => Array.isArray(value) && value.every(item => object(item) && typeof item.id === 'string');

// Three-way merge keeps independent collaborators' edits and reports competing fields.
export function mergeState<T>(base: T, local: T, remote: T): { value: T; conflicts: string[] } {
  const conflicts: string[] = [];
  function merge(a: any, b: any, c: any, path: string): any {
    if (equal(b, c)) return b;
    if (equal(a, b)) return c;
    if (equal(a, c)) return b;
    if (keyed(a) && keyed(b) && keyed(c)) {
      const ids = [...new Set([...c, ...b, ...a].map(item => item.id))];
      const maps = [a, b, c].map(items => new Map(items.map(item => [item.id, item])));
      return ids.map(id => merge(maps[0].get(id), maps[1].get(id), maps[2].get(id), `${path}/${id}`)).filter(item => item !== undefined);
    }
    if (object(a) && object(b) && object(c)) {
      return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(c)])].filter(key => !['__proto__', 'constructor', 'prototype'].includes(key)).map(key => [key, merge(a[key], b[key], c[key], `${path}/${key}`)]).filter(([, value]) => value !== undefined));
    }
    // Modification times are informational; the newest edit owns the timestamp.
    if (path.endsWith('/modifiedAt')) return Math.max(Number(b) || 0, Number(c) || 0);
    conflicts.push(path);
    return b;
  }
  return { value: merge(base, local, remote, ''), conflicts };
}
