import './plan.css';
import { lazy, useState } from 'react';
import { ScrollText, ClipboardList, LayoutDashboard } from 'lucide-react';
import { useEditorStore } from '../state/store';
import type { PlanTab } from '../state/models';
import { PanelTabPresence } from '../components/PanelTabPresence';
import { LazySuspense } from '../components/StaleBuildBanner';
import { PlanActionsSlot } from '../components/plan/slot';
// Each tab is its own chunk: opening the shot list never loads the board, and the editor loads none of them.
const ScriptEditor = lazy(() => import('../components/plan/ScriptEditor'));
const ShotList = lazy(() => import('../components/plan/ShotList'));
const MoodBoard = lazy(() => import('../components/plan/MoodBoard'));

const tabs: { id: PlanTab; name: string; icon: typeof ScrollText }[] = [{ id: 'script', name: 'Script', icon: ScrollText }, { id: 'shots', name: 'Shots', icon: ClipboardList }, { id: 'board', name: 'Board', icon: LayoutDashboard }];
const s = useEditorStore.getState;

/** Pre-production: script, shot list and mood board. One header row; each tab portals its own actions into its right side. */
export default function PlanWorkspace() {
  const tab = useEditorStore(st => st.planTab);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  // One cursor surface for the whole workspace, so the '-tabs' row gives remote cursors their per-tab context.
  return <div className="plan-workspace special-workspace" data-cursor-surface="panel:plan">
    <header className="plan-header">
      <div className="plan-tabs" role="tablist" aria-label="Plan">{tabs.map(t => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-label={t.name} title={t.name} className={tab === t.id ? 'active' : ''} onClick={() => s().openPlan(t.id)}><t.icon size={14}/><span>{t.name}</span><PanelTabPresence panel="plan" tab={t.id}/></button>)}</div>
      <div className="plan-actions" ref={setSlot}/>
    </header>
    <PlanActionsSlot.Provider value={slot}>
      <div className="plan-body"><LazySuspense key={tab} fallback={<div className="plan-loading" aria-busy="true"/>}>{tab === 'script' ? <ScriptEditor/> : tab === 'shots' ? <ShotList/> : <MoodBoard/>}</LazySuspense></div>
    </PlanActionsSlot.Provider>
  </div>;
}
