import { cloneElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { computeTooltipPosition, tooltipDelay, type Rect, type TipSide } from './tooltipPosition';

interface TipData { label: string; shortcut?: string; rect: Rect; side: TipSide; owner: object }

// ───────────── single global tooltip state ─────────────
let current: TipData | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastHiddenAt = -Infinity;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function hideTip(): void {
  clearTimeout(timer);
  if (current) { current = null; lastHiddenAt = performance.now(); emit(); }
}

function showTip(el: HTMLElement, owner: object, label: string, shortcut: string | undefined, side: TipSide, immediate: boolean): void {
  clearTimeout(timer);
  const open = () => {
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    current = { label, shortcut, side, owner, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
    emit();
  };
  if (current) { open(); return; } // moving between tooltipped items while one is visible
  const delay = immediate ? 0 : tooltipDelay(performance.now(), lastHiddenAt);
  if (delay === 0) open();
  else timer = setTimeout(open, delay);
}

/** Render once near the app root. */
export function TooltipHost() {
  const tip = useSyncExternalStore(subscribe, () => current);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const hide = () => hideTip();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') hideTip(); };
    window.addEventListener('mousedown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('wheel', hide, true);
    window.addEventListener('blur', hide);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('wheel', hide, true);
      window.removeEventListener('blur', hide);
      window.removeEventListener('keydown', key, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip) { setPos(null); return; }
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = computeTooltipPosition(tip.rect, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }, tip.side);
    setPos({ x: p.x, y: p.y });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} className="tooltip" role="tooltip" style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' }}>
      <span>{tip.label}</span>
      {tip.shortcut && <span className="tooltip-key">{tip.shortcut}</span>}
    </div>
  );
}

interface Props {
  label: string;
  shortcut?: string;
  side?: TipSide;
  /** Child must be a single DOM element (button, span, ...). */
  children: ReactElement<Record<string, unknown>>;
}

/** Wraps a single element: adds hover/focus tooltip behaviour and aria-label. */
export function Tooltip({ label, shortcut, side = 'bottom', children }: Props) {
  const owner = useRef({}).current;
  useEffect(() => () => { if (current?.owner === owner) hideTip(); }, [owner]);
  const p = children.props as {
    onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseDown?: (e: React.MouseEvent<HTMLElement>) => void;
    onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
    onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
    'aria-label'?: string;
  };
  return cloneElement(children, {
    'aria-label': p['aria-label'] ?? label,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { p.onMouseEnter?.(e); showTip(e.currentTarget, owner, label, shortcut, side, false); },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { p.onMouseLeave?.(e); hideTip(); },
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => { p.onMouseDown?.(e); hideTip(); },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      p.onFocus?.(e);
      let visible = false;
      try { visible = e.currentTarget.matches(':focus-visible'); } catch { visible = false; }
      if (visible) showTip(e.currentTarget, owner, label, shortcut, side, true);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => { p.onBlur?.(e); hideTip(); },
  });
}
