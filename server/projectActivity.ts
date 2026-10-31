import type { DatabaseSync } from 'node:sqlite';
import type { ProjectActivity } from '../src/services/library.ts';

/** Server-owned recent activity; independent of workspace revisions and the 20 Hz presence stream. */
export function projectActivity(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS project_activity(projectId TEXT NOT NULL,userId TEXT NOT NULL,kind TEXT NOT NULL,timestamp INTEGER NOT NULL,PRIMARY KEY(projectId,userId))');
  const get = db.prepare('SELECT userId,kind,timestamp FROM project_activity WHERE projectId=? AND userId=?');
  const put = db.prepare('INSERT INTO project_activity(projectId,userId,kind,timestamp) VALUES(?,?,?,?) ON CONFLICT(projectId,userId) DO UPDATE SET userId=excluded.userId,kind=excluded.kind,timestamp=excluded.timestamp WHERE excluded.timestamp>=project_activity.timestamp');
  let cleanedAt = 0;
  return {
    record(projectId: string, userId: string, kind: ProjectActivity['kind'], now = Date.now(), visitStartedAt = now) {
      const previous = get.get(projectId, userId) as unknown as ProjectActivity | undefined;
      // Keep the last actual edit during that person's visit; a later visit counts as viewing again.
      if (kind === 'viewed' && previous?.userId === userId && (previous.kind === 'edited' && previous.timestamp >= visitStartedAt || previous.kind === 'viewed' && now - previous.timestamp < 30_000)) return;
      put.run(projectId, userId, kind, now);
      if (now - cleanedAt > 3600_000) { db.prepare('DELETE FROM project_activity WHERE timestamp<=?').run(now - 86_400_000); cleanedAt = now; }
    },
    latest(visible: Set<string>, now = Date.now()): Record<string, ProjectActivity> {
      const rows = db.prepare('SELECT projectId,userId,kind,timestamp FROM project_activity WHERE timestamp>? AND timestamp<=? ORDER BY timestamp ASC,kind DESC').all(now - 86_400_000, now) as unknown as (ProjectActivity & { projectId: string })[];
      return Object.fromEntries(rows.filter(row => visible.has(row.projectId)).map(({ projectId, ...activity }) => [projectId, activity]));
    },
  };
}
