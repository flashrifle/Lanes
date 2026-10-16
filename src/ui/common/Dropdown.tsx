import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icons';

interface Props {
  label: ReactNode;
  active?: boolean;
  onClear?: () => void;
  title?: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}

/** Toolbar-style dropdown button with a click-outside popover. */
export function Dropdown({ label, active, onClear, title, children, align = 'left' }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="dd" ref={ref}>
      <div className={'dd-btn' + (active ? ' active' : '') + (open ? ' open' : '')} title={title}>
        <button className="dd-main" onClick={() => setOpen((o) => !o)}>
          <span className="dd-label">{label}</span>
          {!(active && onClear) && <Icon name="chevronDown" size={12} />}
        </button>
        {active && onClear && (
          <button className="dd-clear" title="지우기" onClick={() => { onClear(); setOpen(false); }}>
            <Icon name="close" size={10} />
          </button>
        )}
      </div>
      {open && <div className={'dd-pop ' + align}>{children(() => setOpen(false))}</div>}
    </div>
  );
}
