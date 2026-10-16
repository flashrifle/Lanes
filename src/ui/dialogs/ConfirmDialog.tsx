import { useEffect } from 'react';
import { useRepoStore } from '../state/repoContext';
import type { DialogState } from '../state/repoStore';
import { t } from '../../i18n';

type Confirm = Extract<DialogState, { kind: 'confirm' }>;

export function ConfirmDialog({ dialog }: { dialog: Confirm }) {
  const store = useRepoStore();
  // Escape only. Enter is handled natively by whichever button has focus (never a window-level confirm).
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') store.closeDialog(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [store]);
  return (
    <div className="modal-backdrop" onMouseDown={store.closeDialog}>
      <div className="modal" role="alertdialog" aria-label={dialog.title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{dialog.title}</h3>
        <p>{dialog.message}</p>
        <div className="modal-actions">
          {/* Destructive dialogs focus Cancel so a stray Enter can never confirm. */}
          <button className="btn" autoFocus={!!dialog.danger} onClick={store.closeDialog}>{t('common.cancel')}</button>
          {dialog.alt && <button className="btn" onClick={dialog.alt.onClick}>{dialog.alt.label}</button>}
          <button className={'btn ' + (dialog.danger ? 'danger' : 'primary')} autoFocus={!dialog.danger} onClick={dialog.onConfirm}>{dialog.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
