import { useEffect, type FormEventHandler, type ReactNode } from 'react';

/** Shared modal shell for ui-ops dialogs: backdrop click / Escape close. */
export function Modal({ title, onClose, wide, children, onSubmit }: {
  title: string; onClose: () => void; wide?: boolean; children: ReactNode; onSubmit?: FormEventHandler<HTMLFormElement>;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const cls = 'modal ops-modal' + (wide ? ' wide' : '');
  const inner = (<><h3>{title}</h3>{children}</>);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      {onSubmit
        ? <form className={cls} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(e); }}>{inner}</form>
        : <div className={cls} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>{inner}</div>}
    </div>
  );
}
