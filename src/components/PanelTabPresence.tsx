import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useEditorStore } from '../state/store';

// Plan tabs need no hook: the open tab is the store's planTab, which sync publishes while the Plan workspace is open.
export function usePanelTabPresence(panel: 'media' | 'inspector', tab: string | undefined) {
  useEffect(() => {
    const key = panel === 'media' ? 'mediaPresenceTab' : 'inspectorPresenceTab';
    useEditorStore.setState({ [key]: tab });
    return () => { useEditorStore.setState({ [key]: undefined }); };
  }, [panel, tab]);
}

export function PanelTabPresence({ panel, tab, clipId }: { panel: 'media' | 'inspector' | 'plan'; tab: string; clipId?: string }) {
  // Select ids, not the presence array: every presence packet is a new array, and there is one of these per tab.
  // Plan is per project, not per timeline, so its dots skip the timeline match.
  const ids = useEditorStore(useShallow(s => s.presence.filter(p => p.online && p.userId !== s.currentUserId && p.projectId === s.projectId && (panel === 'plan' ? p.activity === 'plan' && p.planTab === tab : p.timelineId === s.timelineId && p.activity === s.workspace && (panel === 'media' ? p.mediaTab === tab : !!clipId && p.selectedClipId === clipId && p.inspectorTab === tab))).map(p => p.userId)));
  const users = useEditorStore(s => s.users);
  return <span className="workspace-people">{ids.map(id => {
    const user = users.find(u => u.id === id);
    const label = `${user?.name ?? 'Collaborator'} is in ${tab}`;
    return <i key={id} style={{ background: user?.color }} title={label} aria-label={label}/>;
  })}</span>;
}
