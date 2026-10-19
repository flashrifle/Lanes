// Diff mode: side-by-side diff of the file in one history commit vs its first parent (reuses the diff window viewer).
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from 'react';
import { call, toAppError } from '../api';
import { buildDiffModel, type DiffModel } from '../diffwindow/align';
import { DiffViewer, type DiffViewerHandle } from '../diffwindow/DiffViewer';
import type { DiffRequest, FileDiff, FileHistoryEntry, LineRange } from '../types';
import { diffLineOfTarget, diffRangeFromSelection } from './lineSelection';
import { t } from '../i18n';

const FULL_CONTEXT = 1_000_000;
/** Shared across mode switches (the component unmounts in Blame mode). */
const cache = new Map<string, Loaded>();

interface Loaded {
  diff: FileDiff;
  model: DiffModel;
  partial: boolean;
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'binary' } | { kind: 'ok'; data: Loaded };

export function diffRequestFor(e: FileHistoryEntry, contextLines: number | null): DiffRequest {
  return { path: e.path, oldPath: e.oldPath, fromHash: e.parents[0] ?? null, toHash: e.hash, contextLines };
}

async function fetchDiff(repoPath: string, e: FileHistoryEntry): Promise<Loaded> {
  let diff = await call('get_file_diff', { repoPath, request: diffRequestFor(e, FULL_CONTEXT) });
  let partial = false;
  if (diff.truncated) {
    diff = await call('get_file_diff', { repoPath, request: diffRequestFor(e, 3) });
    partial = true;
  }
  return { diff, model: buildDiffModel(diff), partial };
}

interface Props {
  repoPath: string;
  entry: FileHistoryEntry;
  collapse: boolean;
  ref?: Ref<DiffViewerHandle>;
  onChangeCount?: (n: number | null) => void;
  /** Right-click in the diff: new-side line range of the native selection (or the clicked row), null if none. */
  onLineMenu?: (e: ReactMouseEvent, range: LineRange | null) => void;
}

export function HistoryDiff({ repoPath, entry, collapse, ref, onChangeCount, onLineMenu }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const key = `${repoPath}:${entry.hash}:${entry.path}`;

  useEffect(() => {
    if (entry.binary) { setState({ kind: 'binary' }); return; }
    const hit = cache.get(key);
    if (hit) { setState({ kind: 'ok', data: hit }); return; }
    setState({ kind: 'loading' });
    let cancelled = false;
    fetchDiff(repoPath, entry)
      .then((d) => {
        if (cache.size > 40) cache.clear();
        cache.set(key, d);
        if (!cancelled) setState(d.diff.binary ? { kind: 'binary' } : { kind: 'ok', data: d });
      })
      .catch((e) => { if (!cancelled) setState({ kind: 'error', message: toAppError(e).message }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    onChangeCount?.(state.kind === 'ok' ? state.data.model.blocks.length : null);
  }, [state, onChangeCount]);

  const parent = entry.parents[0] ?? null;
  const leftPath = entry.oldPath ?? entry.path;
  const leftMissing = parent === null || entry.status === 'added';
  const rightMissing = entry.status === 'deleted';
  const renamed = !!entry.oldPath && entry.oldPath !== entry.path;

  let body: ReactNode;
  if (state.kind === 'loading') body = <div className="dw-placeholder">{t('common.loading')}</div>;
  else if (state.kind === 'error') body = <div className="dw-placeholder dw-err">{state.message}</div>;
  else if (state.kind === 'binary') body = <div className="dw-placeholder">{t('dw.binary')}</div>;
  else if (state.data.model.sbs.length === 0) {
    body = (
      <div className="dw-placeholder">
        {renamed ? t('dw.renameOnly') : entry.status === 'added' || entry.status === 'deleted' ? t('dw.emptyFile') : t('dw.noDiff')}
      </div>
    );
  } else {
    body = <DiffViewer key={key} ref={ref} model={state.data.model} mode="sbs" collapse={collapse} initialBlock="first" />;
  }

  return (
    <div className="hw-diff">
      <div className="dw-headers">
        <div className="dw-fh">
          {leftMissing ? (
            <span className="dw-fh-muted">{parent === null ? t('hw.rootCommit') : t('dw.noFileParen')}</span>
          ) : (
            <>
              <span className="dw-hash">{parent!.slice(0, 8)}</span>
              <span className="dw-path" title={leftPath}>{leftPath}</span>
            </>
          )}
        </div>
        <div className="dw-fh">
          {rightMissing ? (
            <span className="dw-fh-muted">{t('dw.noFileParen')}</span>
          ) : (
            <>
              <span className="dw-hash">{entry.hash.slice(0, 8)}</span>
              <span className="dw-path" title={entry.path}>{entry.path}</span>
            </>
          )}
        </div>
        <div className="dw-fh-meta">{t(`dw.status.${entry.status}`)}</div>
      </div>
      {state.kind === 'ok' && state.data.partial && <div className="dw-banner">{t('dw.bannerBigFile')}</div>}
      {state.kind === 'ok' && state.data.diff.truncated && <div className="dw-banner">{t('dw.bannerBigDiff')}</div>}
      <div
        className="dw-body"
        onContextMenu={onLineMenu ? (e) => onLineMenu(e, diffRangeFromSelection(e.currentTarget) ?? diffLineOfTarget(e.target)) : undefined}
      >{body}</div>
    </div>
  );
}
