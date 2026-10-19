import { useCallback, useEffect, useState } from 'react';
import { call, toAppError } from '../../api';
import { t } from '../../i18n';
import type { AppError, PushPreview } from '../../types';
import { Modal } from '../dialogs/Modal';
import { formatFullDate } from '../format/date';
import { useRepoStore } from '../state/repoContext';
import { buildPushRequest, canForce, canPush, explainErrorKey, initPushForm, pushFailureOf, shortHash, type PushForm } from './logic';

export function PushDialog({ localBranch }: { localBranch: string | null }) {
  const store = useRepoStore();
  const ops = store.ops;
  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [form, setForm] = useState<PushForm | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);

  const load = useCallback(async (keepForm: boolean) => {
    try {
      const p = await call('get_push_preview', { repoPath: store.path, localBranch });
      setPreview(p);
      setForm((f) => (keepForm && f ? f : initPushForm(p)));
      setLoadErr(null);
    } catch (e) { setLoadErr(toAppError(e).message); }
  }, [store, localBranch]);
  useEffect(() => { void load(false); }, [load]);

  if (loadErr || !preview || !form) {
    return (
      <Modal title={t('push.title')} onClose={ops.close}>
        <p className={loadErr ? 'field-error' : 'muted'}>{loadErr ?? t('common.loading')}</p>
        <div className="modal-actions"><button className="btn" onClick={ops.close}>{t('common.cancel')}</button></div>
      </Modal>
    );
  }

  const set = (patch: Partial<PushForm>) => { setForm({ ...form, ...patch }); setError(null); setConfirmForce(false); };
  const ready = canPush(preview, form) && !busy;
  const forcePossible = canForce(preview, form) && !busy;

  const run = async (force: boolean) => {
    setBusy(true);
    setError(null);
    const request = buildPushRequest(preview, form, force);
    const o = await store.runOp(t('push.running', { name: preview.localBranch }), (repoPath) => call('push', { repoPath, request }));
    setBusy(false);
    if (o.ok) { ops.close(); return; }
    setConfirmForce(false);
    setError(o.error);
    if (o.error.code === 'staleLease') void load(true); // fresh remoteHash for the next attempt
  };

  const pullInstead = () => { ops.close(); void store.pull('ffOnly'); };
  const failure = error ? pushFailureOf(error) : null;
  const explain = error && failure === 'other'
    ? (explainErrorKey(error.code) ? t(explainErrorKey(error.code)!) : error.stderr?.trim().split('\n').slice(-3).join('\n') || error.message)
    : null;
  const forceNote = confirmForce
    ? t('push.forceWarn', { remote: `${form.remote}/${form.remoteBranch.trim()}`, hash: shortHash(preview.remoteHash) })
    : null;

  return (
    <Modal title={t('push.titleBranch', { name: preview.localBranch })} onClose={ops.close} wide onSubmit={() => void run(false)}>
      {preview.remotes.length === 0 ? (
        <p className="field-error">{t('push.noRemote')}</p>
      ) : (
        <>
          <div className="ops-row">
            <label className="ops-field">
              <span>{t('push.remote')}</span>
              <select className="text-input" value={form.remote} onChange={(e) => set({ remote: e.target.value })}>
                {preview.remotes.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="ops-field grow">
              <span>{t('push.remoteBranch')}</span>
              <input className="text-input" spellCheck={false} value={form.remoteBranch} onChange={(e) => set({ remoteBranch: e.target.value })} />
            </label>
          </div>
          <div className="ops-row">
            <label className="check-row"><input type="checkbox" checked={form.setUpstream} onChange={(e) => set({ setUpstream: e.target.checked })} />{t('push.setUpstream')}</label>
            <label className="check-row"><input type="checkbox" checked={form.followTags} onChange={(e) => set({ followTags: e.target.checked })} />{t('push.followTags')}</label>
          </div>
          {preview.behind > 0 && <div className="ops-warn">{t('push.behind', { n: preview.behind })}</div>}
          <div className="ops-list-title">{t('push.outgoing', { n: preview.outgoing.length })}</div>
          <div className="ops-list" role="list">
            {preview.outgoing.map((c) => (
              <div key={c.hash} className="ops-list-row" role="listitem">
                <code>{c.hash.slice(0, 7)}</code>
                <span className="grow ellipsis" title={c.subject}>{c.subject}</span>
                <span className="muted">{c.authorName}</span>
                <span className="muted">{formatFullDate(c.authorTime)}</span>
              </div>
            ))}
            {preview.outgoing.length === 0 && <div className="pop-empty">{t('push.nothing')}</div>}
          </div>
        </>
      )}

      {failure === 'rejected' && (
        <div className="ops-warn">
          <p>{t('push.rejected')}</p>
          <div className="ops-inline-actions">
            <button type="button" className="btn small" onClick={pullInstead}>{t('push.pullFirst')}</button>
            <button type="button" className="btn small" disabled={!forcePossible} onClick={() => setConfirmForce(true)}>{t('push.forceLease')}</button>
          </div>
        </div>
      )}
      {failure === 'stale' && <div className="ops-warn">{t('push.stale')}</div>}
      {explain && <div className="field-error ops-pre">{explain}</div>}

      {forceNote && (
        <div className="ops-danger-box">
          <p>{forceNote}</p>
          <div className="ops-inline-actions">
            <button type="button" className="btn small" autoFocus onClick={() => setConfirmForce(false)}>{t('common.cancel')}</button>
            <button type="button" className="btn small danger" disabled={busy} onClick={() => void run(true)}>{t('push.forceConfirm')}</button>
          </div>
        </div>
      )}

      <div className="modal-actions">
        {!confirmForce && failure !== 'rejected' && (
          <button type="button" className="btn small ops-secondary" disabled={!forcePossible} title={t('push.forceTip')} onClick={() => setConfirmForce(true)}>{t('push.forceLease')}</button>
        )}
        <div className="grow" />
        <button type="button" className="btn" onClick={ops.close}>{t('common.cancel')}</button>
        <button type="submit" className="btn primary" disabled={!ready}>{t('push.push')}</button>
      </div>
    </Modal>
  );
}
