import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLayer } from './layers';

export type MenuItem = { label: string; onClick: () => void; disabled?: boolean } | { separator: true };

export interface MenuState { x: number; y: number; items: MenuItem[] }

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      x: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    });
  }, [menu]);

  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', down, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);
  // Escape goes to the topmost layer only (a menu over a dialog closes the menu, not the dialog).
  useLayer(onClose);

  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button key={i} role="menuitem" className="ctx-item" disabled={it.disabled} onClick={() => { onClose(); it.onClick(); }}>
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

/** Hook helper: returns [menu, open(e, items), close]. */
export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  return {
    menu,
    open: (e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    close: () => setMenu(null),
  };
}
