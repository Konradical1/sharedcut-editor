import { useState } from 'react';
import { useStore } from 'zustand';
import { api, connection } from '../services/api';
import { dismissUpload, pauseUpload, resumeUpload, uploadQueue } from '../services/upload';
import type { MediaAsset } from '../state/models';

const bytes = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)} GB` : `${(value / 1e6).toFixed(1)} MB`;
const duration = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : `${Math.round(seconds)}s`;
export default function UploadQueue({ projectId, media, onSelectFiles }: { projectId: string; media: MediaAsset[]; onSelectFiles: () => void }) {
  const jobs = useStore(uploadQueue, state => state.jobs).filter(job => job.projectId === projectId);
  const [actionError, setActionError] = useState('');
  const retryPreparation = (id: string) => { setActionError(''); void api(`/media/${id}/retry`, {method:'POST'}).then(() => connection.refresh()).catch(error => setActionError(error.message)); };
  const pending = media.filter(asset => asset.projectId === projectId && (asset.status === 'uploading' || asset.preparationStage) && !jobs.some(job => job.assetId === asset.id || !job.assetId && job.name === asset.name));
  return <section className="upload-queue" aria-label="Upload queue">
    {actionError && <p role="alert">{actionError}</p>}
    {(jobs.length > 0 || pending.length > 0) && <details open={jobs.some(job => job.status !== 'uploaded') || pending.some(asset => asset.status === 'uploading')} className="upload-jobs"><summary>Uploads · {jobs.length + pending.length}{jobs.every(job => job.status === 'uploaded') && media.some(asset => asset.projectId === projectId && asset.preparationStage) ? ' · Preparing previews' : ''}</summary><div>
      {jobs.map(job => {
        const asset = media.find(asset => asset.id === job.assetId);
        const uploaded = job.status === 'uploaded';
        const percent = Math.min(100, Math.floor(job.progress.bytes / job.progress.total * 100));
        const label = uploaded ? asset?.preparationStage ?? (asset?.status === 'ready' ? 'Ready to edit' : asset?.status === 'failed' ? 'Preparation failed' : 'Waiting for processing') : job.status === 'uploading' ? job.progress.message : job.status === 'failed' ? 'Upload interrupted' : job.status === 'paused' ? 'Paused · progress saved' : 'Queued';
        return <article key={job.key} className="upload-job" aria-label={`Upload ${job.name}`}>
          <strong title={job.name}>{job.name}</strong><span className="upload-stage">{label}</span>
          {!uploaded && <><progress aria-label={`${job.name} upload progress`} max={job.progress.total} value={job.progress.bytes}/><span>{bytes(job.progress.bytes)} / {bytes(job.progress.total)} · {percent}%</span></>}
          {job.status === 'uploading' && job.progress.speed > 0 && <span>{bytes(job.progress.speed)}/s · ~{duration(job.progress.remaining ?? 0)} left · {duration(job.progress.elapsed)} elapsed</span>}
          {uploaded && <span>{bytes(job.progress.total - (job.progress.resumedBytes ?? 0))} transferred in {duration(job.progress.elapsed)}{job.progress.resumedBytes ? ` · resumed ${bytes(job.progress.total)} file` : ''}{asset?.status === 'ready' && asset.preparationStage ? ' · Ready to edit' : ''}</span>}
          {(job.error || asset?.error) && <span className="upload-error" role="alert">{job.error || asset?.error}</span>}
          <div className="upload-actions">{['queued','uploading'].includes(job.status) ? <button onClick={() => pauseUpload(job.key)}>Pause</button> : !uploaded ? <button onClick={() => resumeUpload(job.key)}>Resume</button> : null}
            {uploaded && asset?.error && <button onClick={() => retryPreparation(asset.id)}>Retry preparation</button>}
            {['paused','failed','uploaded'].includes(job.status) && <button onClick={() => dismissUpload(job.key)}>Dismiss</button>}</div>
        </article>;
      })}
      {pending.map(asset => <article className="upload-job" key={asset.id}><strong>{asset.name}</strong>{asset.status === 'ready' && <span>Ready to edit · finishing previews in the background</span>}{asset.error && <><span className="upload-error">{asset.error}</span><button onClick={() => retryPreparation(asset.id)}>Retry preparation</button></>}<span>{asset.preparationStage ?? `Upload incomplete · ${Math.round(asset.progress)}% saved`}</span>{asset.status === 'uploading' && <><span>Select the original file to resume. Another open tab may still be uploading.</span><button onClick={onSelectFiles}>Select file to resume</button></>}</article>)}
    </div></details>}
  </section>;
}
