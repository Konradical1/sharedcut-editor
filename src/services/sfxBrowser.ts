import { api, connection } from './api';
import { useEditorStore } from '../state/store';
import { availableSoundTrack, type SoundEffect } from './sfx';
import type { MediaAsset } from '../state/models';
export let draggingSound: SoundEffect | null = null;
export function dragSound(sound: SoundEffect | null) {
  draggingSound = sound;
  useEditorStore.setState({ draggingMediaId: sound?.id ?? null });
}
export async function insertSound(soundId: string, start?: number, trackId?: string) {
  const state = useEditorStore.getState(), projectId = state.projectId, timelineId = state.timelineId, position = start ?? state.playhead;
  try {
    await connection.flush();
    const { asset, revision } = await api<{ asset: MediaAsset; revision: number }>(`/sfx/${soundId}/import`, { method: 'POST', body: JSON.stringify({ projectId }) });
    connection.receiveMedia(asset, revision);
    const current = useEditorStore.getState();
    if (current.projectId !== projectId || current.timelineId !== timelineId) { current.notify('Sound imported into the original project', 'info'); return; }
    if (!trackId) {
      const fps = current.projects.find(p => p.id === projectId)?.fps || 24;
      const at = Math.round(Math.max(0, position) * fps) / fps;
      trackId = availableSoundTrack(current.tracks, current.clips, timelineId, at, asset.duration)?.id;
      if (!trackId) {
        current.createTrack('audio');
        const next = useEditorStore.getState();
        trackId = availableSoundTrack(next.tracks, next.clips, timelineId, at, asset.duration)?.id;
      }
      if (!trackId) { current.notify('Add an unlocked audio track first', 'info'); return; }
    }
    useEditorStore.getState().addMediaToTimeline(asset.id, position, trackId);
  } catch (error) { useEditorStore.getState().notify('Could not add sound', 'error', error instanceof Error ? error.message : undefined); }
}
