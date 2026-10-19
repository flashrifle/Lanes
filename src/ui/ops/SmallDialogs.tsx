import { useEffect, useState } from 'react';
import { call } from '../../api';
import { t } from '../../i18n';
import type { MergeMode, Ref, ResetMode } from '../../types';
import { Modal } from '../dialogs/Modal';
import { useStoreState } from '../state/createStore';
import { useRepo, useRepoStore } from '../state/repoContext';
import { headCtxOf, resetConfirmWord, resetReady, shortHash } from './logic';

// ───────────── merge into current ─────────────
const MODES: { id: MergeMode; key: Parameters<typeof t>[0] }[] = [
  { id: 'default', key: 'merge.mode.default' },
  { id: 'ffOnly', key: 'merge.mode.ffOnly' },
  { id: 'noFf', key: 'merge.mode.noFf' },
  { id: 'squash', key: 'merge.mode.squash' },
];

export function MergeDialog({ refToMerge }: { refToMerge: Ref }) {
  const store = useRepoStore();
  const ops = store.ops;
  const snapshot = useRepo((s) => s.snapshot);
  const head = headCtxOf(snapshot?.refs);
  const [mode, setMode] = useState<MergeMode>('default');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const canMessage = mode === 'default' || mode === 'noFf';
  const run = async () => {
    if (busy) return;
    setBusy(true);
    ops.close();
    await ops.merge({ ref: refToMerge.fullName, mode, message: canMessage && message.trim() ? message.trim() : null }, refToMerge.name);
  };
  return (
    <Modal title={t('merge.title')} onClose={ops.close} onSubmit={() => void run()}>
      <p>{t('merge.desc', { name: refToMerge.name, cur: head.branch ?? 'HEAD' })}</p>
      <div className="ops-radios" role="radiogroup">
        {MODES.map((m) => (
          <label key={m.id} className="check-row"><input type="radio" name="merge-mode" checked={mode === m.id} onChange={() => setMode(m.id)} />{t(m.key)}</label>
        ))}
      </div>
      <textarea className="text-input ops-textarea" disabled={!canMessage} placeholder={t('merge.messagePh')} value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={ops.close}>{t('common.cancel')}</button>
        <button type="submit" className="btn primary" disabled={busy}>{t('common.merge')}</button>
      </div>
    </Modal>
  );
}

// ───────────── cherry-pick / revert mainline ─────────────
export function MainlineDialog({ op, hashes, maxParents }: { op: 'cherryPick' | 'revert'; hashes: string[]; maxParents: number }) {
  const ops = useRepoStore().ops;
  const [mainline, setMainline] = useState(1);
  const [record, setRecord] = useState(false);
  const run = () => { ops.close(); void ops.runSequence(op, hashes, mainline, record); };
  return (
    <Modal title={t(op === 'cherryPick' ? 'ops.mainlineTitlePick' : 'ops.mainlineTitleRevert')} onClose={ops.close} onSubmit={run}>
      <p>{t('ops.mainlineDesc')}</p>
      <div className="ops-radios" role="radiogroup">
        {Array.from({ length: maxParents }, (_, i) => i + 1).map((n) => (
          <label key={n} className="check-row"><input type="radio" name="mainline" checked={mainline === n} onChange={() => setMainline(n)} />{t('ops.mainlineParent', { n })}</label>
        ))}
      </div>
      {op === 'cherryPick' && (
        <label className="check-row"><input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />{t('ops.recordOrigin')}</label>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={ops.close}>{t('common.cancel')}</button>
        <button type="submit" className="btn primary">{t(op === 'cherryPick' ? 'ops.cherryPick' : 'ops.revert')}</button>
      </div>
    </Modal>
  );
}

// ───────────── reset current branch ─────────────
export function ResetDialog({ hash }: { hash: string }) {
  const store = useRepoStore();
  const ops = store.ops;
  const snapshot = useRepo((s) => s.snapshot);
  const head = headCtxOf(snapshot?.refs);
  const word = resetConfirmWord(head);
  const [mode, setMode] = useState<ResetMode>('mixed');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mine] = useState(() => ops.getState().dialog);
  // Tracked files with uncommitted changes (untracked files survive `reset --hard`).
  const lost = useStoreState(store.commit, (s) => s.status?.files.filter((f) => !f.untracked).length ?? null);
  const ready = resetReady(mode, typed, word);
  const run = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const e = await ops.reset({ hash, mode, discardLocalChanges: mode === 'hard' });
    setBusy(false);
    if (e) setErr(e.stderr?.trim() || e.message); else ops.closeIf(mine);
  };
  const MODE_ROWS: { id: ResetMode; label: string; hint: string }[] = [
    { id: 'soft', label: t('reset.soft'), hint: t('reset.softHint') },
    { id: 'mixed', label: t('reset.mixed'), hint: t('reset.mixedHint') },
    { id: 'hard', label: t('reset.hard'), hint: t('reset.hardHint') },
  ];
  return (
    <Modal title={t('reset.title')} onClose={ops.close} busy={busy} onSubmit={() => void run()}>
      <p>{t('reset.desc', { branch: head.branch ?? 'HEAD', hash: shortHash(hash) })}</p>
      <div className="ops-radios" role="radiogroup">
        {MODE_ROWS.map((m) => (
          <label key={m.id} className={'ops-radio' + (m.id === 'hard' ? ' danger' : '')}>
            <input type="radio" name="reset-mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
            <span><b>{m.label}</b><span className="muted"> — {m.hint}</span></span>
          </label>
        ))}
      </div>
      {mode === 'hard' && (
        <div className="ops-danger-box">
          <p>{t('reset.hardWarn', { cur: shortHash(head.hash) })}</p>
          {lost != null && lost > 0 && <p className="field-error">{t('reset.hardLost', { n: lost })}</p>}
          <p className="muted">{t('reset.reflogHint')}</p>
          <p>{t('reset.typeToConfirm', { word })}</p>
          <input className="text-input" autoFocus spellCheck={false} value={typed} placeholder={word} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}
      <div className="field-error">{err ?? ' '}</div>
      <div className="modal-actions">
        <button type="button" className="btn" autoFocus={mode !== 'hard'} disabled={busy} onClick={ops.close}>{t('common.cancel')}</button>
        <button type="submit" className={'btn ' + (mode === 'hard' ? 'danger' : 'primary')} disabled={!ready || busy}>{t('reset.run')}</button>
      </div>
    </Modal>
  );
}

// ───────────── new tag ─────────────
export function TagDialog({ hash }: { hash: string }) {
  const store = useRepoStore();
  const ops = store.ops;
  const repo = useRepo((s) => s.repo);
  const [name, setName] = useState('');
  const [annotated, setAnnotated] = useState(false);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [valid, setValid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mine] = useState(() => ops.getState().dialog);

  useEffect(() => {
    // Any edit invalidates the previous answer until the new name is validated (Enter is blocked meanwhile).
    setValid(false);
    if (name.trim() === '') { setProblem(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      call('validate_tag_name', { repoPath: repo.path, name: name.trim() })
        .then((r) => {
          if (cancelled) return;
          setValid(r.valid && !r.exists);
          setProblem(r.exists ? t('tag.exists') : r.valid ? null : r.message ?? t('tag.invalid'));
        })
        .catch((e) => { if (!cancelled) { setValid(false); setProblem((e as Error).message); } });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [repo.path, name]);

  const ok = valid && !busy && (!annotated || message.trim() !== '');
  const run = async () => {
    if (!ok) return;
    setBusy(true);
    const e = await ops.createTag(name.trim(), hash, annotated ? message.trim() : null);
    setBusy(false);
    if (e) setProblem(e.stderr?.trim() || e.message); else ops.closeIf(mine);
  };
  return (
    <Modal title={t('tag.title')} onClose={ops.close} busy={busy} onSubmit={() => void run()}>
      <p className="muted">{t('tag.at', { hash: shortHash(hash) })}</p>
      <input className={'text-input' + (problem ? ' error' : '')} autoFocus spellCheck={false} placeholder={t('tag.namePh')} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="field-error">{problem ?? ' '}</div>
      <label className="check-row"><input type="checkbox" checked={annotated} onChange={(e) => setAnnotated(e.target.checked)} />{t('tag.annotated')}</label>
      {annotated && <textarea className="text-input ops-textarea" placeholder={t('tag.messagePh')} value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />}
      <div className="modal-actions">
        <button type="button" className="btn" disabled={busy} onClick={ops.close}>{t('common.cancel')}</button>
        <button type="submit" className="btn primary" disabled={!ok}>{t('tag.create')}</button>
      </div>
    </Modal>
  );
}

// ───────────── push tag: choose remote ─────────────
export function TagPushDialog({ name }: { name: string }) {
  const store = useRepoStore();
  const ops = store.ops;
  const remotes = useRepo((s) => s.repo.remotes);
  const [remote, setRemote] = useState(remotes.includes('origin') ? 'origin' : remotes[0] ?? '');
  const run = () => { ops.close(); void ops.pushTag(remote, name).then((e) => ops.fail({ ok: !e, error: e ?? undefined })); };
  return (
    <Modal title={t('tag.pushTitle')} onClose={ops.close} onSubmit={run}>
      <p>{t('tag.pushPick', { name })}</p>
      <select className="text-input" value={remote} onChange={(e) => setRemote(e.target.value)}>
        {remotes.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={ops.close}>{t('common.cancel')}</button>
        <button type="submit" className="btn primary" disabled={!remote}>{t('push.push')}</button>
      </div>
    </Modal>
  );
}
