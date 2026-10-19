// Blame mode: file content at a revision with a per-line blame gutter (virtualized; up to 50k lines).
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { call, toAppError } from '../api';
import { displayCols } from '../diffwindow/align';
import type { BlameCommit, BlameLine, BlameResult, LineRange } from '../types';
import { Tooltip } from '../ui/common/Tooltip';
import { formatFullDate } from '../ui/format/date';
import { CommitDate } from '../ui/format/CommitDate';
import { colorOf } from '../ui/log/palette';
import { ageBuckets, buildBlameRuns, hashColorIndex, shortAuthor } from './blame';
import { clickLine, inRange, rangeFromDomSelection, rangeOf, type LineSel } from './lineSelection';
import { t } from '../i18n';

const ROW_H = 20;

export interface BlameTarget {
  rev: string;
  path: string;
  /** 1-based line to reveal + mark after loading. */
  focusLine: number | null;
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: BlameResult };

const cache = new Map<string, BlameResult>();

interface Props {
  repoPath: string;
  target: BlameTarget;
  selectedHash: string | null;
  onPick: (line: BlameLine, commit: BlameCommit | undefined) => void;
  onContext: (e: ReactMouseEvent, line: BlameLine, commit: BlameCommit | undefined) => void;
  /** Right-click on a line number / code: the selected range (or the clicked line). */
  onLineMenu?: (e: ReactMouseEvent, range: LineRange, target: BlameTarget) => void;
  /** "Show History for Selection". */
  onLineHistory?: (range: LineRange, target: BlameTarget) => void;
}

function tipOf(c: BlameCommit | undefined, hash: string): string {
  if (!c) return hash;
  return `${c.subject}\n${c.authorName} <${c.authorEmail}>\n${formatFullDate(c.authorTime)}\n${c.hash}${c.boundary ? ` · ${t('hw.boundary')}` : ''}\n${t('hw.gutterHint')}`;
}

export function BlameView({ repoPath, target, selectedHash, onPick, onContext, onLineMenu, onLineHistory }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const key = `${repoPath}\0${target.rev}\0${target.path}`;

  useEffect(() => {
    const hit = cache.get(key);
    if (hit) { setState({ kind: 'ok', data: hit }); return; }
    setState({ kind: 'loading' });
    let cancelled = false;
    call('get_blame', { repoPath, path: target.path, rev: target.rev })
      .then((r) => {
        if (cache.size > 12) cache.clear();
        cache.set(key, r);
        if (!cancelled) setState({ kind: 'ok', data: r });
      })
      .catch((e) => { if (!cancelled) setState({ kind: 'error', message: toAppError(e).message }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (state.kind === 'loading') return <div className="dw-placeholder">{t('common.loading')}</div>;
  if (state.kind === 'error') return <div className="dw-placeholder dw-err">{state.message}</div>;
  if (state.data.binary) return <div className="dw-placeholder">{t('hw.blameBinary')}</div>;
  if (state.data.lines.length === 0) return <div className="dw-placeholder">{t('dw.emptyFile')}</div>;
  return (
    <BlameBody
      key={key}
      data={state.data}
      focusLine={target.focusLine}
      selectedHash={selectedHash}
      onPick={onPick}
      onContext={onContext}
      onLineMenu={onLineMenu ? (e, r) => onLineMenu(e, r, target) : undefined}
      onLineHistory={onLineHistory ? (r) => onLineHistory(r, target) : undefined}
    />
  );
}

interface BodyProps {
  data: BlameResult;
  focusLine: number | null;
  selectedHash: string | null;
  onPick: Props['onPick'];
  onContext: Props['onContext'];
  onLineMenu?: (e: ReactMouseEvent, range: LineRange) => void;
  onLineHistory?: (range: LineRange) => void;
}

function BlameBody({ data, focusLine, selectedHash, onPick, onContext, onLineMenu, onLineHistory }: BodyProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = data.lines;
  const runs = useMemo(() => buildBlameRuns(lines), [lines]);
  const commits = useMemo(() => new Map(data.commits.map((c) => [c.hash, c])), [data.commits]);
  const ages = useMemo(() => ageBuckets(data.commits), [data.commits]);
  const maxCols = useMemo(() => {
    let m = 0;
    for (const l of lines) {
      if (l.text.length * 4 <= m) continue; // a char is at most 4 columns wide (tab)
      const c = displayCols(l.text);
      if (c > m) m = c;
    }
    return m;
  }, [lines]);
  const digits = Math.max(3, String(lines.length).length);
  const [mark, setMark] = useState<number | null>(focusLine);
  const [lineSel, setLineSel] = useState<LineSel | null>(null);
  const selRange = lineSel ? rangeOf(lineSel) : null;

  /** Native text selection wins, then the line-number selection, then the clicked line. */
  const rangeForMenu = (line: number): LineRange => {
    const root = scrollRef.current;
    const dom = root ? rangeFromDomSelection(root) : null;
    if (dom) return dom;
    if (selRange && inRange(selRange, line)) return selRange;
    return { start: line, end: line };
  };

  const virt = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 30,
  });

  useLayoutEffect(() => {
    if (focusLine != null && focusLine >= 1 && focusLine <= lines.length) {
      const el = scrollRef.current;
      const top = Math.max(0, (focusLine - 1) * ROW_H - Math.floor((el?.clientHeight ?? 0) / 3));
      virt.scrollToOffset(top);
    }
    scrollRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setMark(focusLine), [focusLine]);

  const gutterW = 'var(--hw-gutter-w)';
  const lnW = `calc(${digits}ch + 14px)`;
  const cols = `${gutterW} ${lnW} minmax(0, 1fr)`;
  const innerMinWidth = `calc(var(--hw-gutter-w) + ${lnW} + ${maxCols}ch + 24px)`;

  return (
    <div className="hw-blame">
      {data.truncated && <div className="dw-banner">{t('hw.blameTruncated', { n: lines.length })}</div>}
      <div className="hw-blame-scroll" ref={scrollRef} tabIndex={0} style={{ ['--hw-cols' as string]: cols }}>
        <div className="hw-blame-inner" style={{ height: virt.getTotalSize(), minWidth: innerMinWidth }}>
          {virt.getVirtualItems().map((vi) => {
            const i = vi.index;
            const l = lines[i];
            const run = runs.runOf[i];
            const start = runs.runStart[run] === i;
            const nextStart = runs.runStart[run + 1] ?? lines.length;
            const end = nextStart === i + 1;
            const c = commits.get(l.hash);
            const age = ages.get(l.hash) ?? 0;
            let gutter: ReactNode = null;
            if (start && c) {
              gutter = (
                <>
                  <span className="hw-g-hash">{c.hash.slice(0, 8)}</span>
                  <span className="hw-g-author">{shortAuthor(c.authorName)}</span>
                  <span className="hw-g-date"><CommitDate ts={c.authorTime} /></span>
                </>
              );
            } else if (start) {
              gutter = <span className="hw-g-hash">{l.hash.slice(0, 8)}</span>;
            }
            const sel = selectedHash !== null && l.hash === selectedHash;
            return (
              <div
                key={vi.key}
                data-line={i + 1}
                className={'hw-bl-row' + (sel ? ' sel' : '') + (mark === i + 1 ? ' mark' : '') + (selRange && inRange(selRange, i + 1) ? ' lsel' : '') + (start ? ' rs' : '') + (end ? ' re' : '')}
                style={{ transform: `translateY(${vi.start}px)` }}
              >
                <Tooltip label={tipOf(c, l.hash)} side="right">
                  <div
                    className={'hw-g hw-age-' + age}
                    style={{ ['--hw-stripe' as string]: colorOf(hashColorIndex(l.hash)) }}
                    onClick={() => { setMark(i + 1); onPick(l, c); }}
                    onContextMenu={(e) => onContext(e, l, c)}
                  >
                    {gutter}
                  </div>
                </Tooltip>
                <div
                  className="hw-bl-ln"
                  onClick={(e) => setLineSel((p) => clickLine(p, i + 1, e.shiftKey))}
                  onContextMenu={onLineMenu ? (e) => onLineMenu(e, rangeForMenu(i + 1)) : undefined}
                >{i + 1}</div>
                <div
                  className="hw-bl-code"
                  onContextMenu={onLineMenu ? (e) => onLineMenu(e, rangeForMenu(i + 1)) : undefined}
                >{l.text}</div>
              </div>
            );
          })}
        </div>
      </div>
      {selRange && (
        <div className="hw-selbar">
          <span>{t('history.selection', { range: t('history.range', { start: selRange.start, end: selRange.end }) })}</span>
          <span className="grow" />
          {onLineHistory && <button className="btn small primary" onClick={() => onLineHistory(selRange)}>{t('history.showForSelection')}</button>}
          <button className="btn small" onClick={() => setLineSel(null)} aria-label="×">×</button>
        </div>
      )}
    </div>
  );
}
