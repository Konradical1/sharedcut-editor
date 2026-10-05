// Starts the playback report while the editor is open: gives createHealthReporter its real inputs (the window, the
// footage worker, the store, the footage cache) and installs it where the presence heartbeat reads. The decisions
// live in playbackHealth.ts, which is tested without a browser; this file only connects them.
import { useEditorStore } from '../state/store.ts';
import { footageSummary } from './footageCache.ts';
import { readDevice } from './playbackReport.ts';
import { buildIdFromScripts, cachedPercent, constantSpeed, createHealthReporter, healthSharingEnabled, installHealthReporter, isFrozenClip, isVideoEngine, pictureSource, qualityLabel, reportTargetFps } from './playbackHealth.ts';
import type { PictureFacts } from './playbackHealth.ts';

/** Reading the graphics card name makes a throwaway WebGL context, so it is done soon after mount and not inside a playback tick. */
const DEVICE_WARM_MS = 1_000;

function targetFps(picture: PictureFacts): number {
  const state = useEditorStore.getState();
  const clip = isVideoEngine(picture.engine) ? state.clips.find(item => item.id === picture.clipId) : undefined;
  const asset = clip && state.media.find(item => item.id === clip.mediaId);
  return reportTargetFps(state.settings, state.projects.find(project => project.id === state.projectId)?.fps, asset?.fps, clip && constantSpeed(clip));
}

function isHeld(clipId: string): boolean {
  const clip = useEditorStore.getState().clips.find(item => item.id === clipId);
  return !!clip && isFrozenClip(clip);
}

function context(picture: PictureFacts) {
  const { settings } = useEditorStore.getState(), quality = qualityLabel(settings.viewerQuality);
  return { quality, source: pictureSource(picture, quality), cachedPct: cachedPercent(footageSummary().entries, settings.footageCache !== false) };
}

/** Begins reporting and returns how to stop. Call once when the editor mounts. A failure to start means no reports, never a broken editor. */
export function startPlaybackReporting(): () => void {
  try {
    const reporter = createHealthReporter({
      now: () => performance.now(),
      target: window, worker: navigator.serviceWorker, doc: document,
      build: buildIdFromScripts(Array.from(document.scripts, script => script.src)),
      sharing: () => healthSharingEnabled(useEditorStore.getState().settings),
      device: () => readDevice(), context, targetFps, isHeld,
      onContextChange: listener => useEditorStore.subscribe((state, previous) => { if (state.projectId !== previous.projectId || state.timelineId !== previous.timelineId) listener(); }),
    });
    const uninstall = installHealthReporter(reporter);
    const warm = window.setTimeout(() => { readDevice(); }, DEVICE_WARM_MS);
    return () => { window.clearTimeout(warm); uninstall(); reporter.stop(); };
  } catch {
    return () => {};
  }
}
