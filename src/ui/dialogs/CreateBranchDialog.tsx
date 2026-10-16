import { useEffect, useState } from 'react';
import { call } from '../../api';
import { useRepo, useRepoStore } from '../state/repoContext';
import { t } from '../../i18n';

export function CreateBranchDialog({ startPoint, startLabel }: { startPoint: string; startLabel: string }) {
  const store = useRepoStore();
  const repo = useRepo((s) => s.repo);
  const { closeDialog } = store;
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [valid, setValid] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repo || name.trim() === '') { setValid(false); setProblem(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      call('validate_branch_name', { repoPath: repo.path, name: name.trim() })
        .then((r) => {
          if (cancelled) return;
          setValid(r.valid && !r.exists);
          setProblem(r.exists ? t('cb.exists') : r.valid ? null : r.message ?? t('cb.invalid'));
        })
        .catch((e) => { if (!cancelled) { setValid(false); setProblem((e as Error).message); } });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [repo, name]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDialog(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const err = await store.createBranch(name.trim(), startPoint, checkout);
    setBusy(false);
    if (err) setProblem(err.stderr?.trim() || err.message);
    else closeDialog();
  };

  return (
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h3>{t('cb.title')}</h3>
        <p className="muted">{t('cb.start', { name: startLabel })}</p>
        <input
          className={'text-input' + (problem ? ' error' : '')}
          autoFocus
          placeholder={t('cb.placeholder')}
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="field-error">{problem ?? ' '}</div>
        <label className="check-row"><input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} />{t('common.checkout')}</label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={closeDialog}>{t('common.cancel')}</button>
          <button type="submit" className="btn primary" disabled={!valid || busy}>{t('cb.create')}</button>
        </div>
      </form>
    </div>
  );
}
