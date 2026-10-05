import { Component, Suspense, useState, useSyncExternalStore, type ReactNode } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Button, IconButton } from './ui';
import { isChunkLoadError, markStaleBuild, staleBuild } from '../services/staleBuild';

type BoundaryProps = { quiet?: boolean; children: ReactNode };
type BoundaryState = { failed: boolean; error?: unknown };
/** Turns a panel whose file the last deploy replaced into a short message instead of a blank screen. Never reloads by itself. */
class ChunkBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(error: unknown): BoundaryState { return { failed: true, error }; }
  componentDidCatch(error: unknown) { if (isChunkLoadError(error)) markStaleBuild(); }
  render() {
    if (!this.state.failed) return this.props.children;
    // Anything but a missing file is a real bug: pass it up to the next boundary, and finally to React, as before.
    if (!isChunkLoadError(this.state.error)) throw this.state.error;
    if (this.props.quiet) return null;
    return <div className="workspace-loading"><RefreshCw size={16}/><span>This part needs the new version of SharedCut.</span><Button onClick={() => window.location.reload()}>Reload</Button></div>;
  }
}
/** Suspense for lazy panels; a `quiet` one (a dialog) shows nothing of its own and leaves the message to the banner. */
export function LazySuspense({ fallback, quiet, children }: { fallback: ReactNode; quiet?: boolean; children: ReactNode }) {
  return <ChunkBoundary quiet={quiet}><Suspense fallback={fallback}>{children}</Suspense></ChunkBoundary>;
}

/** Shown once any panel's file fails to load: small, in the corner, never in the way, and the page is never reloaded for the person. */
export function StaleBuildBanner() {
  const stale = useSyncExternalStore(staleBuild.subscribe, staleBuild.get, () => false);
  const [dismissed, setDismissed] = useState(false);
  if (!stale || dismissed) return null;
  return <div className="toast-stack" style={{ right: 'auto', left: 22 }} role="status" aria-live="polite">
    <div className="toast toast-info"><span className="toast-symbol"><RefreshCw size={16}/></span><div><b>A new version of SharedCut is ready.</b><p>Reload when convenient.</p></div><Button onClick={() => window.location.reload()}>Reload</Button><IconButton label="Dismiss" onClick={() => setDismissed(true)}><X size={13}/></IconButton></div>
  </div>;
}
