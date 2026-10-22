import type { Clip, GradeNode } from '../state/models';

/** HSL qualifier tools for the selected node (stub; built by the qualifier/windows work). */
export function QualifierPanel(_: { node: GradeNode; clip: Clip; update: (p: Record<string, number>) => void }) {
  return <div className="color-tool-placeholder">Qualifier</div>;
}
