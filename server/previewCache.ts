import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { trimFlowCache } from './opticalFlow.ts';
import type { RenderRequest } from './media.ts';

type Snapshot = Omit<RenderRequest, 'outputPath' | 'signal' | 'onProgress'>;
export type TimelinePreview = { key: string; status: 'preparing' | 'ready' | 'failed'; progress: number; from: number; duration: number; fps: number; url?: string; error?: string };
/** Reuses the export renderer in short, versioned windows. Never changes source media or the edit. */
export function createPreviewCache(directory: string, schedule: (id: string, work: (signal: AbortSignal) => Promise<void>) => void, render: (request: RenderRequest) => Promise<void>) {
  const jobs = new Map<string, { projectId: string; value: TimelinePreview }>();
  return {
    request(snapshot: Snapshot): TimelinePreview {
      const from = Number(snapshot.settings.rangeIn), duration = Number(snapshot.settings.rangeOut) - from, fps = Number(snapshot.settings.fps);
      if (!Number.isFinite(from) || from < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 4.1 || !Number.isFinite(fps) || fps < 1 || fps > 120) throw new Error('Invalid preview range.');
      const files = snapshot.assets.map(({asset,path}) => { if(!existsSync(path))return [asset.id,null];const file=statSync(path);return [asset.id,file.size,file.mtimeMs]; });
      const key = createHash('sha256').update(JSON.stringify(['timeline-preview-v1', snapshot, files])).digest('hex');
      const file = join(directory, `${key}.mp4`), projectId = snapshot.project.id;
      const url = `/api/timeline-previews/${key}/video.mp4?projectId=${encodeURIComponent(projectId)}`;
      const previous = jobs.get(key);
      if (previous && (previous.value.status !== 'ready' || existsSync(file))) return previous.value;
      if ([...jobs.values()].filter(job => job.value.status === 'preparing').length >= 2) throw new Error('Preview queue busy');
      const value: TimelinePreview = { key, from, duration, fps, progress: 0, status: existsSync(file) ? 'ready' : 'preparing' };
      if (value.status === 'ready') { value.url=url;value.progress=100; }
      jobs.set(key, { projectId, value });
      // ponytail: 64 recent job records and a 512 MiB disk cache; grow only if long timelines churn.
      for (const [id,job] of jobs) if(jobs.size>64&&job.value.status!=='preparing'&&id!==key)jobs.delete(id);
      if(value.status==='ready')return value;
      schedule(`preview-${key}`, async signal => {
        const temporary = join(directory, `${key}.pending.mp4`);
        try {
          await mkdir(directory, { recursive: true });
          await render({ ...snapshot, outputPath: temporary, signal, onProgress: progress => { value.progress=Math.round(progress); } });
          if(signal.aborted)throw new Error('Preview cancelled');
          await rename(temporary,file); value.status='ready';value.url=url;value.progress=100;
          await trimFlowCache(directory,new Set([key]),512*1024**2);
        } catch(error) { value.status='failed';value.error=error instanceof Error?error.message:String(error); }
        finally { await rm(temporary,{force:true}); }
      });
      return value;
    },
    file(key: string, projectId: string) {
      return jobs.get(key)?.projectId===projectId&&jobs.get(key)?.value.status==='ready'?join(directory,`${key}.mp4`):undefined;
    },
  };
}
