import { useEffect, useState } from 'react';
import { call, toAppError } from '../../api';
import { t } from '../../i18n';
import type { Reflog } from '../../types';
import { Modal } from '../dialogs/Modal';
import { formatFullDate } from '../format/date';
import { useRepo, useRepoStore } from '../state/repoContext';
import { shortHash } from './logic';

export function ReflogDialog({ refName }: { refName: string | null }) {
  const store = useRepoStore();
  const ops = store.ops;
  const snapshot = useRepo((s) => s.snapshot);
  const [sel, setSel] = useState<string | null>(refName);
  const [log, setLog] = useState<Reflog | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLog(null); setErr(null);
    call('get_reflog', { repoPath: store.path, ref: sel, limit: null })
      .then((r) => { if (!cancelled) setLog(r); })
      .catch((e) => { if (!cancelled) setErr(toAppError(e).message); });
    return () => { cancelled = true; };
  }, [store, sel]);

  const branches = (snapshot?.refs.refs ?? []).filter((r) => r.type === 'localBranch');
  const closeThen = (fn: () => void) => () => { ops.close(); fn(); };

  return (
    <Modal title={t('reflog.title')} onClose={ops.close} wide>
      <div className="ops-row">
        <label className="ops-field">
          <span>{t('reflog.ref')}</span>
          <select className="text-input" value={sel ?? ''} onChange={(e) => setSel(e.target.value || null)}>
            <option value="">HEAD</option>
            {branches.map((b) => <option key={b.fullName} value={b.fullName}>{b.name}</option>)}
          </select>
        </label>
      </div>
      <div className="ops-list tall" role="list">
        {log?.entries.map((e) => (
          <div key={e.selector} className="ops-list-row reflog" role="listitem">
            <code className="ops-sel">{e.selector}</code>
            <span className="ops-action">{e.action}</span>
            <span className="grow ellipsis" title={e.message}>{e.message}</span>
            <span className="muted">{formatFullDate(e.time)}</span>
            <code>{shortHash(e.hash)}</code>
            <span className="ops-row-actions">
              <button type="button" className="btn small" title={t('reflog.checkoutTip')} onClick={closeThen(() => store.checkoutCommit(e.hash))}>{t('common.checkout')}</button>
              <button type="button" className="btn small" onClick={closeThen(() => store.openDialog({ kind: 'createBranch', startPoint: e.hash, startLabel: `${e.selector} (${shortHash(e.hash)})` }))}>{t('reflog.newBranch')}</button>
              <button type="button" className="btn small" onClick={() => void ops.copyHash(e.hash)}>{t('reflog.copy')}</button>
              <button type="button" className="btn small" onClick={closeThen(() => { store.jumpToHash(e.hash); })}>{t('reflog.show')}</button>
            </span>
          </div>
        ))}
        {!log && !err && <div className="pop-empty">{t('common.loading')}</div>}
        {err && <div className="field-error">{err}</div>}
        {log && log.entries.length === 0 && <div className="pop-empty">{t('reflog.empty')}</div>}
      </div>
      {log?.truncated && <p className="muted">{t('reflog.truncated')}</p>}
      <div className="modal-actions"><button className="btn" autoFocus onClick={ops.close}>{t('reflog.close')}</button></div>
    </Modal>
  );
}
