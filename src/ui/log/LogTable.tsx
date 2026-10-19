import { memo, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CommitMeta, GraphRow, SignatureInfo } from '../../types';
import { formatFullDate } from '../format/date';
import { CommitDate } from '../format/CommitDate';
import { ContextMenu, useContextMenu } from '../common/ContextMenu';
import { Icon } from '../common/Icons';
import { currentFocusRow } from '../state/logic';
import { Tooltip } from '../common/Tooltip';
import { IS_MAC, hasMod } from '../platform';
import { useRepo, useRepoStore } from '../state/repoContext';
import { rowMapOf } from '../state/repoStore';
import { GraphCell } from './GraphCell';
import { useMetrics } from './density';
import { badgeOf } from './palette';
import { buildRefLabels, refsByIndex, type RefLabel } from './refLabels';
import { t } from '../../i18n';
import { WorkingTreeRow } from '../commit/WorkingTreeRow';
import { useWorkingRowVisible } from '../commit/commitStore';
import { commitMenuItems } from '../ops/menus';
import { hitTestGraphRow, nextHighlightKey } from './graphHit';
import './log-ext.css';

interface RowProps {
  row: number;
  top: number;
  rowH: number;
  graph: GraphRow;
  meta: CommitMeta | undefined;
  labels: RefLabel[] | undefined;
  sig: SignatureInfo | undefined;
  selected: boolean;
  focused: boolean;
  /** Highlighted branch line id (GraphLayout line), -1 = none. GraphCell dims everything else. */
  highlightLine: number;
  onContext: (e: React.MouseEvent, row: number) => void;
}

const Row = memo(function Row({ row, top, rowH, graph, meta, labels, sig, selected, focused, highlightLine, onContext }: RowProps) {
  const merge = (meta?.parentCount ?? 0) > 1;
  const badge = badgeOf(graph.nodeColor);
  const dim = highlightLine >= 0 && graph.nodeLine !== highlightLine;
  return (
    <div
      className={'log-row' + (selected ? ' selected' : '') + (focused ? ' focused' : '') + (merge ? ' merge' : '') + (dim ? ' line-dim' : '')}
      style={{ transform: `translateY(${top}px)`, height: rowH }}
      data-row={row}
      onContextMenu={(e) => onContext(e, row)}
    >
      <div className="cell subject-cell">
        <GraphCell row={graph} selected={selected} highlightLine={highlightLine} />
        <span className="subject" title={meta?.subject}>{meta ? meta.subject : ''}</span>
        {labels && labels.length > 0 && (
          <span className="badges">
            {labels.map((l) => (
              <span
                key={l.fullNames.join('+')}
                className={`badge ${l.kind}${l.isCurrent ? ' current' : ''}`}
                style={{ ['--c' as string]: badge.bg, ['--ink' as string]: badge.ink }}
                title={l.fullNames.join('\n')}
                data-ref={l.fullNames[0]}
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
        {meta ? <CommitDate ts={meta.authorTime} /> : ''}
      </div>
      <div className="cell status">
        {sig && sig.status !== 'none' && (
          <Tooltip side="left" label={t('log.signature', { text: `${sig.status}${sig.signer ? ' (' + sig.signer + ')' : ''}` })}>
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
  const metrics = useMetrics();
  const ROW_H = metrics.rowH;
  const ctx = useContextMenu();
  const highlightKey = useRepo((s) => s.highlightKey);
  const highlightLine = layout && highlightKey ? layout.lineOfKey(highlightKey) : -1;
  // "Uncommitted changes (N)" row sits above the virtual rows; the virtualizer offsets by it.
  const workingVisible = useWorkingRowVisible(store.commit);
  const scrollMargin = workingVisible ? ROW_H : 0;

  const rowCount = layout?.rowCount ?? 0;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
    scrollMargin,
  });
  const items = virtualizer.getVirtualItems();

  // Density change: row heights are derived from it, so re-measure and keep the top row anchored.
  const prevRowH = useRef(ROW_H);
  useEffect(() => {
    if (prevRowH.current === ROW_H) return;
    const topRow = Math.round((parentRef.current?.scrollTop ?? 0) / prevRowH.current);
    prevRowH.current = ROW_H;
    virtualizer.measure();
    virtualizer.scrollToIndex(topRow, { align: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ROW_H]);

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
      case 'ArrowUp':
        if (cur === 0 && workingVisible && !e.shiftKey) { e.preventDefault(); store.selectWorking(); return; }
        target = cur < 0 ? 0 : cur - 1;
        break;
      case 'Escape':
        if (highlightKey) { e.preventDefault(); store.setHighlightKey(null); }
        return;
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
    // Selected commits in row order (newest first); a right-click outside the selection selected just that row.
    const sel = selection.set.has(ci) ? [...selection.set] : [ci];
    const hashes = sel.filter((i) => layout.rowOf(i) >= 0).sort((a, b) => layout.rowOf(a) - layout.rowOf(b)).map((i) => snapshot.hashes[i]);
    const extra = commitMenuItems({ store, hashes, focusHash: hash });
    ctx.open(e, [
      { label: t('log.copyHash'), onClick: () => void navigator.clipboard?.writeText(hash) },
      { separator: true },
      { label: t('log.checkoutRev'), onClick: () => checkoutCommit(hash) },
      { label: t('log.newBranchHere'), onClick: () => openDialog({ kind: 'createBranch', startPoint: hash, startLabel: hash.slice(0, 10) }) },
      ...(extra.length ? [{ separator: true } as const, ...extra] : []),
    ]);
  };

  const onRowClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (IS_MAC && e.ctrlKey) return; // ctrl+click is a context-menu gesture on macOS
    const el = (e.target as HTMLElement).closest('[data-row]') as HTMLElement | null;
    if (!el) return;
    const row = Number(el.dataset.row);
    if (layout && !e.shiftKey && !hasMod(e)) {
      const key = graphClickKey(e, row);
      if (key !== undefined) store.setHighlightKey(nextHighlightKey(highlightKey, key));
    }
    selectRowAt(row, { shift: e.shiftKey, toggle: hasMod(e) });
  };

  /** Line key under a click: string = a line was hit, null = empty graph space (clears), undefined = not the graph. */
  const graphClickKey = (e: React.MouseEvent, row: number): string | null | undefined => {
    if (!layout) return undefined;
    const target = e.target as HTMLElement;
    const badge = target.closest('[data-ref]') as HTMLElement | null;
    if (badge?.dataset.ref) {
      const line = layout.lineOfRef(badge.dataset.ref);
      return line >= 0 ? layout.lineKey(line) || null : null;
    }
    const hit = graphHitAt(e, row);
    if (hit === undefined) return undefined;
    return hit ? layout.lineKey(hit.line) || null : null;
  };

  const graphHitAt = (e: React.MouseEvent, row: number) => {
    const target = e.target as HTMLElement;
    if (!layout || !(target instanceof HTMLCanvasElement) || !target.classList.contains('graph-cell')) return undefined;
    const r = target.getBoundingClientRect();
    return hitTestGraphRow(layout.getRow(row), metrics, e.clientX - r.left, e.clientY - r.top);
  };

  // Hover affordance: pointer + hint over clickable graph elements.
  const onMouseMove = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLCanvasElement)) return;
    const el = target.closest('[data-row]') as HTMLElement | null;
    if (!el) return;
    const hit = graphHitAt(e, Number(el.dataset.row));
    const on = !!hit;
    if (target.classList.contains('hit') !== on) {
      target.classList.toggle('hit', on);
      target.title = on ? t('graph.highlightHint') : '';
    }
  };

  void sigVersion;
  const focusRow = currentFocusRow(selection, map);

  return (
    <div className="log-table">
      {loading && <div className="loading-bar" />}
      <div className="log-scroll" ref={parentRef} tabIndex={0} onKeyDown={onKeyDown} onMouseDown={onRowClick} onMouseMove={onMouseMove}>
        {workingVisible && <WorkingTreeRow height={ROW_H} />}
        {!layout ? (
          <div className="empty-note">{loading ? t('common.loading') : ''}</div>
        ) : rowCount === 0 ? (
          <div className="empty-note">{snapshot && snapshot.commitCount === 0 ? t('log.noCommits') : t('log.noMatch')}</div>
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
                  top={v.start - scrollMargin}
                  rowH={ROW_H}
                  graph={g}
                  meta={getMeta(ci)}
                  labels={labelsByIndex.get(ci)}
                  sig={hash ? getSignature(hash) : undefined}
                  selected={selection.set.has(ci)}
                  focused={focusRow === v.index}
                  highlightLine={highlightLine}
                  onContext={onContext}
                />
              );
            })}
          </div>
        )}
      </div>
      {snapshot?.truncated && (
        <div className="trunc-banner">{t('log.truncated', { n: snapshot.commitCount })}</div>
      )}
      {ctx.menu && <ContextMenu menu={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}

