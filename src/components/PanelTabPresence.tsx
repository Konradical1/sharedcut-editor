import { useEffect } from 'react';
import { useEditorStore } from '../state/store';

export function usePanelTabPresence(panel: 'media' | 'inspector', tab: string | undefined) {
  useEffect(() => {
    const key = panel === 'media' ? 'mediaPresenceTab' : 'inspectorPresenceTab';
    useEditorStore.setState({ [key]: tab });
    return () => { useEditorStore.setState({ [key]: undefined }); };
  }, [panel, tab]);
}

export function PanelTabPresence({ panel, tab, clipId }: { panel: 'media' | 'inspector'; tab: string; clipId?: string }) {
  const presence = useEditorStore(s => s.presence);
  const users = useEditorStore(s => s.users);
  const projectId = useEditorStore(s => s.projectId);
  const timelineId = useEditorStore(s => s.timelineId);
  const workspace = useEditorStore(s => s.workspace);
  const currentUserId = useEditorStore(s => s.currentUserId);
  return <span className="workspace-people">{presence.filter(p => p.online && p.userId !== currentUserId && p.projectId === projectId && p.timelineId === timelineId && p.activity === workspace && (panel === 'media' ? p.mediaTab === tab : !!clipId && p.selectedClipId === clipId && p.inspectorTab === tab)).map(p => {
    const user = users.find(u => u.id === p.userId);
    const label = `${user?.name ?? 'Collaborator'} is in ${tab}`;
    return <i key={p.userId} style={{ background: user?.color }} title={label} aria-label={label}/>;
  })}</span>;
}
