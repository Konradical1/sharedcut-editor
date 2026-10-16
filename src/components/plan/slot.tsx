// The Plan header's right-hand action area. Script, Shots and Board each portal their own buttons into it,
// so the workspace keeps one header row instead of a toolbar per tab.
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEditorStore } from '../../state/store';

export const PlanActionsSlot = createContext<HTMLElement | null>(null);
export function PlanActions({ children }: { children: ReactNode }) { const slot = useContext(PlanActionsSlot); return slot ? createPortal(children, slot) : null; }

/** Plan shows no timeline or playhead, so its "Add to timeline" goes after the last clip (never over one out of sight) and says so. */
export function addToTimelineEnd(ids: string[], what: string) {
  const st = useEditorStore.getState(), before = st.clips.length;
  st.addMediaToTimeline(ids, Math.max(0, ...st.clips.filter(c => c.timelineId === st.timelineId).map(c => c.start + c.duration)));
  if (useEditorStore.getState().clips.length > before) st.notify(`Added ${what} to the end of the timeline`, 'success');
}
