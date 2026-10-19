// Per-tab dialogs owned by ui-commit (stash save). Discard / drop / abort confirms reuse RepoStore's confirm dialog.
// Mounted in TabOverlays (active tab only).
import { useState } from 'react';
import { Modal } from '../dialogs/Modal';
import { t } from '../../i18n';
import { useStoreState } from '../state/createStore';
import { useRepoStore } from '../state/repoContext';
import type { CommitStore } from './commitStore';
import './commit.css';

export function CommitOverlays() {
  const cs = useRepoStore().commit;
  const dialog = useStoreState(cs, (s) => s.dialog);
  if (dialog.kind === 'stashSave') return <StashSaveDialog store={cs} paths={dialog.paths} />;
  return null;
}

function StashSaveDialog({ store, paths }: { store: CommitStore; paths: string[] | null }) {
  const [mine] = useState(() => store.getState().dialog);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [keepIndex, setKeepIndex] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await store.saveStash({ message: message.trim() || null, includeUntracked: paths ? false : includeUntracked, keepIndex, paths });
    setBusy(false);
    if (ok) store.closeDialogIf(mine);
  };

  return (
    <Modal title={t('stash.dialog.title')} onClose={store.closeDialog} busy={busy} className="lc-stash-dialog" onSubmit={() => void submit()}>
      {paths && <p className="muted">{t('stash.dialog.paths', { n: paths.length })}</p>}
      <label className="lc-field">
        <span>{t('stash.dialog.message')}</span>
        <input autoFocus value={message} placeholder={t('stash.dialog.placeholder')} onChange={(e) => setMessage(e.target.value)} spellCheck={false} />
      </label>
      {!paths && (
        <label className="lc-opt">
          <input type="checkbox" checked={includeUntracked} onChange={(e) => setIncludeUntracked(e.target.checked)} />
          {t('stash.dialog.untracked')}
        </label>
      )}
      <label className="lc-opt">
        <input type="checkbox" checked={keepIndex} onChange={(e) => setKeepIndex(e.target.checked)} />
        {t('stash.dialog.keepIndex')}
      </label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={store.closeDialog} disabled={busy}>{t('common.cancel')}</button>
        <button type="submit" className="btn primary" disabled={busy}>{t('stash.dialog.confirm')}</button>
      </div>
    </Modal>
  );
}
