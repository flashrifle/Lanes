import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const top = r.bottom + 6;
      setPos(align === 'right'
        ? { top, right: Math.max(8, window.innerWidth - r.right), maxHeight: Math.min(360, window.innerHeight - top - 12) }
        : { top, left: Math.max(8, Math.min(r.left, window.innerWidth - 216)), maxHeight: Math.min(360, window.innerHeight - top - 12) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const inside = (n: Node) => !!(ref.current?.contains(n) || popRef.current?.contains(n));
    const down = (e: MouseEvent) => { if (!inside(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
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
