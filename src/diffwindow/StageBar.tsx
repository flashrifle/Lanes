// Diff window bar for working-tree entries: line / hunk stage, unstage, discard (apply_patch) and the
// file-level fallbacks (stage_files / unstage_files / discard_files). Ops are serialized and retried once on busy.
import { useEffect, useState } from 'react';
import { call, toAppError } from '../api';
import type { ChangedFile, FileDiff } from '../types';
import { t } from '../i18n';
import { createOpQueue } from '../ui/commit/opQueue';
import { buildPatch, patchRequest, type PatchMode } from '../ui/commit/patch';
import type { StagingCaps } from './staging';

const queue = createOpQueue();

type FileOp = 'stage' | 'unstage' | 'discard' | 'delete' | 'resolve';

interface Props {
  repoPath: string;
  file: ChangedFile;
  diff: FileDiff | null;
  caps: StagingCaps;
  selected: ReadonlySet<string>;
  allKeys: readonly string[];
  setSelected(s: ReadonlySet<string>): void;
  /** Re-fetch the diff (after an op, or when the patch was stale). */
  reload(): void;
}

type Confirm = { kind: 'lines' } | { kind: 'file'; op: 'discard' | 'delete' };
type Failure = { message: string; fallback: FileOp | null };

const FALLBACK: Record<PatchMode, FileOp> = { stage: 'stage', unstage: 'unstage', discard: 'discard' };

export function StageBar({ repoPath, file, diff, caps, selected, allKeys, setSelected, reload }: Props) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => { setConfirm(null); setFailure(null); }, [file.path, file.fromHash, file.toHash]);

  const n = selected.size;
  const lineModes = caps.lineModes;

  const run = async (fn: () => Promise<unknown>, onFail: (e: ReturnType<typeof toAppError>) => void) => {
    setBusy(true);
    setFailure(null);
    try {
      await queue.run(fn);
      setSelected(new Set());
    } catch (e) {
      onFail(toAppError(e));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const applyLines = (mode: PatchMode) => {
    if (!diff) return;
    if (mode === 'discard' && confirm?.kind !== 'lines') { setConfirm({ kind: 'lines' }); return; }
    setConfirm(null);
    const patch = buildPatch(diff, selected, mode);
    if (!patch) return;
    void run(
      () => call('apply_patch', { repoPath, request: patchRequest(file.path, patch, mode) }),
      (e) => setFailure(e.code === 'patchFailed'
        ? { message: t('stage.dw.patchFailed'), fallback: FALLBACK[mode] }
        : { message: e.stderr?.trim().split('\n').slice(-2).join(' ') || e.message, fallback: null }),
    );
  };

  const fileOp = (op: FileOp) => {
    if ((op === 'discard' || op === 'delete') && !(confirm?.kind === 'file' && confirm.op === op)) { setConfirm({ kind: 'file', op }); return; }
    setConfirm(null);
    const paths = [file.path];
    const fn = () => {
      switch (op) {
        case 'stage':
        case 'resolve':
          return call('stage_files', { repoPath, paths });
        case 'unstage':
          return call('unstage_files', { repoPath, paths: file.oldPath ? [file.path, file.oldPath] : paths });
        case 'discard':
          return call('discard_files', { repoPath, request: { paths, untrackedPaths: [], includeStaged: false } });
        case 'delete':
          return call('discard_files', { repoPath, request: { paths: [], untrackedPaths: paths, includeStaged: false } });
      }
    };
    void run(fn, (e) => setFailure({ message: e.stderr?.trim().split('\n').slice(-2).join(' ') || e.message, fallback: null }));
  };

  const sideLabel = t(`stage.dw.side.${caps.side}`);
  const lineNote = lineModes.length
    ? t('stage.dw.selected', { n })
    : caps.side === 'staged' || caps.side === 'unstaged' ? t('stage.dw.fileOnly') : null;

  return (
    <>
      <div className="dw-stagebar" role="toolbar" aria-label={sideLabel}>
        <span className="dw-stagebar-side">{sideLabel}</span>
        {lineNote && <span className="dw-stagebar-note">{lineNote}</span>}
        {lineModes.length > 0 && (
          <>
            <button className="dw-sbtn link" disabled={busy || allKeys.length === 0} onClick={() => setSelected(new Set(allKeys))}>{t('stage.dw.selectAll')}</button>
            <button className="dw-sbtn link" disabled={busy || n === 0} onClick={() => setSelected(new Set())}>{t('stage.dw.clear')}</button>
          </>
        )}
        <span className="dw-grow" />
        {lineModes.includes('stage') && (
          <button className="dw-sbtn primary" disabled={busy || n === 0} onClick={() => applyLines('stage')}>{t('stage.dw.stageSel')}</button>
        )}
        {lineModes.includes('unstage') && (
          <button className="dw-sbtn primary" disabled={busy || n === 0} onClick={() => applyLines('unstage')}>{t('stage.dw.unstageSel')}</button>
        )}
        {lineModes.includes('discard') && (
          <button className="dw-sbtn" disabled={busy || n === 0} onClick={() => applyLines('discard')}>{t('stage.dw.discardSel')}</button>
        )}
        {caps.side === 'unstaged' && (
          <>
            <button className="dw-sbtn" disabled={busy} onClick={() => fileOp('stage')}>{t('stage.dw.stageFile')}</button>
            <button className="dw-sbtn" disabled={busy} onClick={() => fileOp('discard')}>{t('stage.dw.discardFile')}</button>
          </>
        )}
        {caps.side === 'staged' && <button className="dw-sbtn" disabled={busy} onClick={() => fileOp('unstage')}>{t('stage.dw.unstageFile')}</button>}
        {caps.side === 'untracked' && (
          <>
            <button className="dw-sbtn" disabled={busy} onClick={() => fileOp('stage')}>{t('stage.dw.stageFile')}</button>
            <button className="dw-sbtn" disabled={busy} onClick={() => fileOp('delete')}>{t('stage.dw.deleteFile')}</button>
          </>
        )}
        {caps.side === 'conflict' && <button className="dw-sbtn" disabled={busy} onClick={() => fileOp('resolve')}>{t('conflict.markResolved')}</button>}
      </div>
      {confirm && (
        <div className="dw-banner dw-banner-warn" role="alertdialog">
          <span>
            {confirm.kind === 'lines'
              ? t('stage.dw.confirmLines', { n })
              : confirm.op === 'delete' ? t('stage.dw.confirmDelete') : t('stage.dw.confirmFile')}
          </span>
          <span className="dw-grow" />
          <button className="dw-sbtn" autoFocus onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
          <button className="dw-sbtn danger" onClick={() => (confirm.kind === 'lines' ? applyLines('discard') : fileOp(confirm.op))}>
            {confirm.kind === 'file' && confirm.op === 'delete' ? t('stage.dw.deleteFile') : t('commit.discard.confirm')}
          </button>
        </div>
      )}
      {failure && (
        <div className="dw-banner dw-banner-err" role="alert">
          <span>{failure.message}</span>
          <span className="dw-grow" />
          {failure.fallback && (
            <button className="dw-sbtn" onClick={() => fileOp(failure.fallback!)}>{t(`stage.dw.fallback.${failure.fallback as 'stage' | 'unstage' | 'discard'}`)}</button>
          )}
          <button className="dw-sbtn link" onClick={() => setFailure(null)}>{t('stage.dw.dismiss')}</button>
        </div>
      )}
    </>
  );
}
