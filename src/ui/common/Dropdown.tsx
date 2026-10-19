import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLayer } from './layers';
import { createPortal } from 'react-dom';
import { Icon } from './Icons';
import { Tooltip } from './Tooltip';
import { t } from '../../i18n';

interface Props {
  label: ReactNode;
  active?: boolean;
  onClear?: () => void;
  title?: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}

/**
 * Toolbar-style dropdown button with a click-outside popover. The popover is portalled to <body> with fixed
 * positioning: toolbars clip overflow (the filter bar is overflow: hidden), which used to cut popovers off.
 */
export function Dropdown({ label, active, onClear, title, children, align = 'left' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useLayer(close, { enabled: open });

  /** Position under the anchor (clamped by the popover's real width); false when the anchor is gone / hidden. */
  const place = useCallback((): boolean => {
    const a = ref.current;
    if (!a || !a.isConnected || a.closest('[inert]') || getComputedStyle(a).visibility === 'hidden') return false;
    const r = a.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const w = popRef.current?.offsetWidth || 216;
    const top = r.bottom + 6;
    const maxHeight = Math.max(80, Math.min(360, window.innerHeight - top - 12));
    const next: CSSProperties = align === 'right'
      ? { top, right: Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - w - 8)), maxHeight }
      : { top, left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), maxHeight };
    setPos((p) => (p && p.top === next.top && p.left === next.left && p.right === next.right && p.maxHeight === next.maxHeight ? p : next));
    return true;
  }, [align]);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    if (!place()) { setOpen(false); return; }
    const update = () => { if (!place()) setOpen(false); };
    // Scroll (any scroller, capture) / resize reposition. A frame loop catches what fires no event: the anchor
    // unmounting, its tab being switched away (hidden / inert), layout shifts.
    let raf = requestAnimationFrame(function tick() { update(); raf = requestAnimationFrame(tick); });
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    window.addEventListener('blur', close);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('blur', close);
    };
  }, [open, place, close]);
  // Re-clamp once the popover has rendered and its width is known.
  const shown = open && pos !== null;
  useLayoutEffect(() => { if (shown) place(); }, [shown, place]);

  useEffect(() => {
    if (!open) return;
    const inside = (n: Node) => !!(ref.current?.contains(n) || popRef.current?.contains(n));
    const down = (e: MouseEvent) => { if (!inside(e.target as Node)) setOpen(false); };
    window.addEventListener('mousedown', down);
    return () => { window.removeEventListener('mousedown', down); };
  }, [open]);
  return (
    <div className="dd" ref={ref}>
      <div className={'dd-btn' + (active ? ' active' : '') + (open ? ' open' : '')}>
        <Tooltip label={title ?? t('dd.filter')} side="bottom">
          <button className="dd-main" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span className="dd-label">{label}</span>
            {!(active && onClear) && <Icon name="chevronDown" size={12} />}
          </button>
        </Tooltip>
        {active && onClear && (
          <Tooltip label={t('dd.clear')} side="bottom">
            <button className="dd-clear" onClick={() => { onClear(); setOpen(false); }}>
              <Icon name="close" size={10} />
            </button>
          </Tooltip>
        )}
      </div>
      {open && pos && createPortal(
        <div ref={popRef} className="dd-pop dd-pop-fixed" style={pos}>{children(() => setOpen(false))}</div>,
        document.body,
      )}
    </div>
  );
}
