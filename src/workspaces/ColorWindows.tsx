import type { Clip, GradeNode } from '../state/models';

/** Window tools (gradient, circle, rectangle) for the selected node (stub; built by the qualifier/windows work). */
export function WindowsPanel(_: { node: GradeNode; clip: Clip; update: (p: Record<string, number>) => void }) {
  return <div className="color-tool-placeholder">Windows</div>;
}
