import { useRef, type FormEventHandler, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { useModal } from '../common/layers';

/**
 * Shared modal shell: backdrop click / Escape close (both ignored while `busy`), aria-modal, focus trap,
 * focus restored to the opener on close.
 */
export function Modal({ title, onClose, wide, children, onSubmit, busy = false, className, role = 'dialog' }: {
  title: string; onClose: () => void; wide?: boolean; children: ReactNode; onSubmit?: FormEventHandler<HTMLFormElement>;
  /** An operation is running: Escape and backdrop clicks do nothing. */
  busy?: boolean;
  /** Replaces the default "ops-modal" class. */
  className?: string;
  role?: 'dialog' | 'alertdialog';
}) {
  const ref = useRef<HTMLElement>(null);
  useModal(ref, onClose, busy);
  const cls = 'modal ' + (className ?? 'ops-modal') + (wide ? ' wide' : '');
  const inner = (<><h3>{title}</h3>{children}</>);
  const common = {
    className: cls, role, 'aria-modal': true, 'aria-label': title, 'aria-busy': busy || undefined, tabIndex: -1,
    onMouseDown: (e: MouseEvent) => e.stopPropagation(),
  } as const;
  return (
    <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
      {onSubmit
        ? <form ref={ref as RefObject<HTMLFormElement>} {...common} onSubmit={(e) => { e.preventDefault(); onSubmit(e); }}>{inner}</form>
        : <div ref={ref as RefObject<HTMLDivElement>} {...common}>{inner}</div>}
    </div>
  );
}
