import { useCallback, useRef, useState, type ReactNode } from 'react';

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

export function SplitPane({ dir, fixed, defaultSize, min = 140, storageKey, children }: Props) {
  const [size, setSize] = useState(() => readSize(storageKey, defaultSize));
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef(size);
  latest.current = size;

  const onDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const el = box.current;
    if (!el) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const total = dir === 'h' ? r.width : r.height;
      const pos = dir === 'h' ? ev.clientX - r.left : ev.clientY - r.top;
      const raw = fixed === 'start' ? pos : total - pos;
      setSize(Math.max(min, Math.min(total - min, raw)));
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      try { localStorage.setItem('split:' + storageKey, String(Math.round(latest.current))); } catch { /* ignore */ }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }, [dir, fixed, min, storageKey]);

  const fixedStyle = { flex: `0 0 ${size}px` };
  const [a, b] = children;
  return (
    <div ref={box} className={'split ' + dir}>
      <div className="split-pane" style={fixed === 'start' ? fixedStyle : { flex: '1 1 0' }}>{a}</div>
      <div className="split-handle" onPointerDown={onDown} role="separator" aria-orientation={dir === 'h' ? 'vertical' : 'horizontal'} />
      <div className="split-pane" style={fixed === 'end' ? fixedStyle : { flex: '1 1 0' }}>{b}</div>
    </div>
  );
}
