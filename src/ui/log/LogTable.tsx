import { memo, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CommitMeta, GraphRow, SignatureInfo } from '../../types';
import { formatCommitDate, formatFullDate } from '../format/date';
import { ContextMenu, useContextMenu } from '../common/ContextMenu';
import { Icon } from '../common/Icons';
import { currentFocusRow } from '../state/logic';
import { Tooltip } from '../common/Tooltip';
import { IS_MAC, hasMod } from '../platform';
import { useRepo, useRepoStore } from '../state/repoContext';
import { rowMapOf } from '../state/repoStore';
import { GraphCell, colorOf } from './GraphCell';
import { buildRefLabels, refsByIndex, type RefLabel } from './refLabels';

const ROW_H = 22;

interface RowProps {
  row: number;
  top: number;
  graph: GraphRow;
  meta: CommitMeta | undefined;
  labels: RefLabel[] | undefined;
  sig: SignatureInfo | undefined;
  selected: boolean;
  focused: boolean;
  onContext: (e: React.MouseEvent, row: number) => void;
}

const Row = memo(function Row({ row, top, graph, meta, labels, sig, selected, focused, onContext }: RowProps) {
  const merge = (meta?.parentCount ?? 0) > 1;
  const color = colorOf(graph.nodeColor);
  return (
    <div
      className={'log-row' + (selected ? ' selected' : '') + (focused ? ' focused' : '') + (merge ? ' merge' : '')}
      style={{ transform: `translateY(${top}px)`, height: ROW_H }}
      data-row={row}
      onContextMenu={(e) => onContext(e, row)}
    >
      <div className="cell subject-cell">
        <GraphCell row={graph} />
        <span className="subject" title={meta?.subject}>{meta ? meta.subject : ''}</span>
        {labels && labels.length > 0 && (
          <span className="chips">
            {labels.map((l) => (
              <span
                key={l.fullNames.join('+')}
                className={`chip ${l.kind}${l.isCurrent ? ' current' : ''}`}
                style={{ ['--c' as string]: color }}
                title={l.fullNames.join('\n')}
              >
                {l.isFavorite && <Icon name="star" size={9} />}
                {l.kind === 'tag' && <Icon name="tag" size={10} />}
                {l.text}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="cell author" title={meta ? `${meta.authorName} <${meta.authorEmail}>` : undefined}>{meta?.authorName}</div>
      <div className="cell date" title={meta ? formatFullDate(meta.authorTime) : undefined}>
        {meta ? formatCommitDate(meta.authorTime) : ''}
      </div>
      <div className="cell status">
        {sig && sig.status !== 'none' && (
          <Tooltip side="left" label={`서명: ${sig.status}${sig.signer ? ' (' + sig.signer + ')' : ''}`}>
            <span className={'sig ' + (sig.status === 'good' ? 'good' : 'bad')}>
              <Icon name={sig.status === 'good' ? 'check' : 'warning'} size={12} />
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  );
});

export function LogTable() {
  const store = useRepoStore();
  const { checkoutCommit, ensureMeta, ensureSignatures, getMeta, getSignature, moveFocus, openDialog, selectAllRows, selectRowAt, setTopCommitIndex } = store;
  const layout = useRepo((s) => s.layout);
  const snapshot = useRepo((s) => s.snapshot);
  const selection = useRepo((s) => s.selection);
  const metaVersion = useRepo((s) => s.metaVersion);
  const sigVersion = useRepo((s) => s.sigVersion);
  const scrollRequest = useRepo((s) => s.scrollRequest);
  const loading = useRepo((s) => s.loading);
  const parentRef = useRef<HTMLDivElement>(null);
  const ctx = useContextMenu();

  const rowCount = layout?.rowCount ?? 0;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();

  const labelsByIndex = useMemo(() => {
    const out = new Map<number, RefLabel[]>();
    if (!snapshot) return out;
    for (const [idx, refs] of refsByIndex(snapshot.refs.refs)) out.set(idx, buildRefLabels(refs));
    return out;
  }, [snapshot]);

  // Fetch row text for visible range +-50 (debounced).
  const first = items.length ? items[0].index : 0;
  const last = items.length ? items[items.length - 1].index : -1;
  useEffect(() => {
    if (!layout || last < first) return;
    setTopCommitIndex(layout.commitIndexAt(first));
    const t = setTimeout(() => {
      const idx: number[] = [];
      for (let r = Math.max(0, first - 50); r <= Math.min(layout.rowCount - 1, last + 50); r++) idx.push(layout.commitIndexAt(r));
      void ensureMeta(idx);
      const hashes: string[] = [];
      for (let r = first; r <= last; r++) {
        const h = snapshot?.hashes[layout.commitIndexAt(r)];
        if (h) hashes.push(h);
      }
      void ensureSignatures(hashes);
    }, 30);
    return () => clearTimeout(t);
  }, [layout, snapshot, first, last, metaVersion, ensureMeta, ensureSignatures, setTopCommitIndex]);

  useEffect(() => {
    if (!scrollRequest) return;
    const { row } = scrollRequest;
    const inView = items.length > 2 && row > items[1].index && row < items[items.length - 2].index;
    if (!inView) virtualizer.scrollToIndex(row, { align: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest]);

  const map = rowMapOf(layout);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!layout) return;
    const cur = currentFocusRow(selection, map);
    const page = Math.max(1, Math.floor((parentRef.current?.clientHeight ?? 400) / ROW_H) - 1);
    let target: number | null = null;
    switch (e.key) {
      case 'ArrowDown': target = cur + 1; break;
      case 'ArrowUp': target = cur < 0 ? 0 : cur - 1; break;
      case 'PageDown': target = cur + page; break;
      case 'PageUp': target = cur - page; break;
      case 'Home': target = 0; break;
      case 'End': target = rowCount - 1; break;
      case 'a':
      case 'A':
        if (hasMod(e)) { e.preventDefault(); selectAllRows(); }
        return;
      default: return;
    }
    e.preventDefault();
    moveFocus(target, e.shiftKey);
  };

  const onContext = (e: React.MouseEvent, row: number) => {
    if (!layout || !snapshot) return;
    const ci = layout.commitIndexAt(row);
    if (!selection.set.has(ci)) selectRowAt(row, { shift: false, toggle: false });
    const hash = snapshot.hashes[ci];
    ctx.open(e, [
      { label: '해시 복사', onClick: () => void navigator.clipboard?.writeText(hash) },
      { separator: true },
      { label: '리비전 체크아웃…', onClick: () => checkoutCommit(hash) },
      { label: '여기서 새 브랜치…', onClick: () => openDialog({ kind: 'createBranch', startPoint: hash, startLabel: hash.slice(0, 10) }) },
    ]);
  };

  const onRowClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (IS_MAC && e.ctrlKey) return; // ctrl+click is a context-menu gesture on macOS
    const el = (e.target as HTMLElement).closest('[data-row]') as HTMLElement | null;
    if (!el) return;
    selectRowAt(Number(el.dataset.row), { shift: e.shiftKey, toggle: hasMod(e) });
  };

  void sigVersion;
  const focusRow = currentFocusRow(selection, map);

  return (
    <div className="log-table">
      {loading && <div className="loading-bar" />}
      <div className="log-scroll" ref={parentRef} tabIndex={0} onKeyDown={onKeyDown} onMouseDown={onRowClick}>
        {!layout ? (
          <div className="empty-note">{loading ? '불러오는 중…' : ''}</div>
        ) : rowCount === 0 ? (
          <div className="empty-note">{snapshot && snapshot.commitCount === 0 ? '커밋이 없습니다' : '일치하는 커밋이 없습니다'}</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: 640 }}>
            {items.map((v) => {
              const ci = layout.commitIndexAt(v.index);
              const g = layout.getRow(v.index);
              const hash = snapshot?.hashes[ci];
              return (
                <Row
                  key={v.key}
                  row={v.index}
                  top={v.start}
                  graph={g}
                  meta={getMeta(ci)}
                  labels={labelsByIndex.get(ci)}
                  sig={hash ? getSignature(hash) : undefined}
                  selected={selection.set.has(ci)}
                  focused={focusRow === v.index}
                  onContext={onContext}
                />
              );
            })}
          </div>
        )}
      </div>
      {snapshot?.truncated && (
        <div className="trunc-banner">처음 {snapshot.commitCount.toLocaleString('ko-KR')}개의 커밋만 표시됩니다</div>
      )}
      {ctx.menu && <ContextMenu menu={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}

