import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  dir: 'h' | 'v';              // h: side by side, v: stacked
  fixed: 'start' | 'end';      // which pane has the pixel size
  defaultSize: number;
  min?: number;
  storageKey: string;
  children: [ReactNode, ReactNode];
}

function readSize(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem('split:' + key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch { return fallback; }
}

/** Keep the fixed pane within [min, total - min] (stored sizes can exceed a smaller window). */
export function clampSize(size: number, total: number, min: number): number {
  if (!(total > 0)) return size;
  return Math.max(min, Math.min(Math.max(min, total - min), size));
}

export function SplitPane({ dir, fixed, defaultSize, min = 140, storageKey, children }: Props) {
  const [size, setSize] = useState(() => readSize(storageKey, defaultSize));
  const [total, setTotal] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(size);
  latest.current = size;

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setTotal(dir === 'h' ? r.width : r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [dir]);

  const onDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const t = dir === 'h' ? r.width : r.height;
      const pos = dir === 'h' ? ev.clientX - r.left : ev.clientY - r.top;
      const raw = fixed === 'start' ? pos : t - pos;
      setSize(clampSize(raw, t, min));
    };
    const end = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      target.removeEventListener('lostpointercapture', end);
      try { localStorage.setItem('split:' + storageKey, String(Math.round(latest.current))); } catch { /* ignore */ }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
    target.addEventListener('lostpointercapture', end);
  }, [dir, fixed, min, storageKey]);

  const shown = clampSize(size, total, min);
  const fixedStyle = { flex: `0 0 ${shown}px` };
  const [a, b] = children;
  return (
    <div ref={box} className={'split ' + dir}>
      <div className="split-pane" style={fixed === 'start' ? fixedStyle : { flex: '1 1 0' }}>{a}</div>
      <div className="split-handle" onPointerDown={onDown} role="separator" aria-orientation={dir === 'h' ? 'vertical' : 'horizontal'} />
      <div className="split-pane" style={fixed === 'end' ? fixedStyle : { flex: '1 1 0' }}>{b}</div>
    </div>
  );
}
