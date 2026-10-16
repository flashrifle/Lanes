import { useEffect } from 'react';
import { closeDialog, type DialogState } from '../state/store';

type Confirm = Extract<DialogState, { kind: 'confirm' }>;

export function ConfirmDialog({ dialog }: { dialog: Confirm }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog();
      else if (e.key === 'Enter') dialog.onConfirm();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [dialog]);
  return (
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <div className="modal" role="alertdialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{dialog.title}</h3>
        <p>{dialog.message}</p>
        <div className="modal-actions">
          <button className="btn" onClick={closeDialog}>취소</button>
          {dialog.alt && <button className="btn" onClick={dialog.alt.onClick}>{dialog.alt.label}</button>}
          <button className={'btn ' + (dialog.danger ? 'danger' : 'primary')} autoFocus onClick={dialog.onConfirm}>{dialog.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
