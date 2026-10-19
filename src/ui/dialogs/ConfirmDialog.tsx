import { useRepoStore } from '../state/repoContext';
import type { DialogState } from '../state/repoStore';
import { t } from '../../i18n';
import { Modal } from './Modal';

type Confirm = Extract<DialogState, { kind: 'confirm' }>;

export function ConfirmDialog({ dialog }: { dialog: Confirm }) {
  const store = useRepoStore();
  // Enter is handled natively by whichever button has focus (never a window-level confirm).
  // Destructive dialogs focus Cancel so a stray Enter can never confirm; `noAutoFocus` focuses Cancel too
  // (dialogs that pop up late, after an async op, while the user may still be typing).
  const focusCancel = !!dialog.danger || !!dialog.noAutoFocus;
  return (
    <Modal title={dialog.title} onClose={store.closeDialog} role="alertdialog" className="confirm-modal">
      <p className="confirm-msg">{dialog.message}</p>
      {dialog.details && dialog.details.length > 0 && (
        <ul className="confirm-list">
          {dialog.details.map((d, i) => <li key={i} className="ellipsis" title={d}>{d}</li>)}
        </ul>
      )}
      {dialog.warning && <p className="confirm-warn">{dialog.warning}</p>}
      <div className="modal-actions">
        <button className="btn" autoFocus={focusCancel} onClick={store.closeDialog}>{t('common.cancel')}</button>
        {dialog.alt && <button className="btn" onClick={dialog.alt.onClick}>{dialog.alt.label}</button>}
        <button className={'btn ' + (dialog.danger ? 'danger' : 'primary')} autoFocus={!focusCancel} onClick={dialog.onConfirm}>{dialog.confirmLabel}</button>
      </div>
    </Modal>
  );
}
