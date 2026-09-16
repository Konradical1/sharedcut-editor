import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { waveformBars } from '../services/waveform';
const empty: number[] = [];
export const Waveform = memo(function Waveform({ samples = empty, from = 0, to = 1, reverse = false }: { samples?: number[]; from?: number; to?: number; reverse?: boolean }) {
  const ref = useRef<SVGSVGElement>(null), [width, setWidth] = useState(180);
  useEffect(() => {
    const svg = ref.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, Math.round(entry.contentRect.width))));
    observer.observe(svg); return () => observer.disconnect();
  }, []);
  const bars = Math.max(1, Math.min(8192, Math.floor(width / 3)));
  const values = useMemo(() => waveformBars(samples, bars, from, to, reverse), [samples, bars, from, to, reverse]);
  return <svg ref={ref} viewBox={`0 0 ${bars * 3} 40`} preserveAspectRatio="none" className="waveform" aria-hidden="true" data-bars={bars}>
    <path d={`M0 39.5H${bars * 3}`} stroke="currentColor" opacity=".2"/>
    <path d={values.map((h, i) => h > 0 ? `M${i * 3 + 1} 40v-${(h * 38).toFixed(2)}` : '').join('')} stroke="currentColor" strokeWidth="1.8"/>
  </svg>;
});
