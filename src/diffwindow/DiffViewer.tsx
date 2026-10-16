// Virtualized side-by-side / unified diff body. One vertical scroller keeps both panes in sync;
// each pane scrolls horizontally via its own bar (content shifted with a CSS variable, no re-render).
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref, type UIEvent } from 'react';
import { buildDisplay, sbsKinds, uniKinds, type BlockType, type DiffModel, type SbsRow, type SideLine, type UniRow } from './align';
import { t } from '../i18n';

export const ROW_H = 20;

export type ViewMode = 'sbs' | 'unified';

export interface DiffViewerHandle {
  /** Move to the next/previous change. Returns false when there is none in that direction. */
  navigate(dir: 1 | -1): boolean;
  focus(): void;
}

interface Props {
  model: DiffModel;
  mode: ViewMode;
  collapse: boolean;
  initialBlock: 'first' | 'last';
  ref?: Ref<DiffViewerHandle>;
}

const TYPE_CLS: Record<BlockType, string> = { insert: 'dw-ins', delete: 'dw-del', modify: 'dw-mod' };

function CodeText({ line }: { line: SideLine }) {
  const { text, hl } = line;
  let body: ReactNode = text;
  if (hl && hl.length > 0) {
    const parts: ReactNode[] = [];
    let p = 0;
    hl.forEach(([s, e], i) => {
      if (s > p) parts.push(text.slice(p, s));
      parts.push(<span key={i} className="dw-w">{text.slice(s, e)}</span>);
      p = e;
    });
    if (p < text.length) parts.push(text.slice(p));
    body = parts;
  }
  return (
    <>
      {body}
      {line.noNewline && <span className="dw-nonl" title={t('dw.noNewline')}>⏎̸</span>}
    </>
  );
}

export function DiffViewer({ model, mode, collapse, initialBlock, ref }: Props) {
  const [expanded, setExpanded] = useState<{ sbs: Set<number>; unified: Set<number> }>(() => ({ sbs: new Set(), unified: new Set() }));
  const kinds = useMemo(() => (mode === 'sbs' ? sbsKinds(model) : uniKinds(model)), [model, mode]);
  const display = useMemo(() => buildDisplay(kinds, { collapse, expanded: expanded[mode] }), [kinds, collapse, expanded, mode]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const leftBar = useRef<HTMLDivElement>(null);
  const rightBar = useRef<HTMLDivElement>(null);

  const virt = useVirtualizer({
    count: display.items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 25,
  });

  const blocks = model.blocks;
  const [cur, setCur] = useState(() => (blocks.length === 0 ? -1 : initialBlock === 'last' ? blocks.length - 1 : 0));
  const blockItem = useCallback(
    (b: number) => display.rowToItem[mode === 'sbs' ? blocks[b].sbsStart : blocks[b].uniStart],
    [display, mode, blocks],
  );

  const scrollToBlock = useCallback(
    (b: number) => {
      setCur(b);
      const el = scrollRef.current;
      const idx = blockItem(b);
      if (!el) return;
      // put the change ~1/3 from the top, like IntelliJ
      const top = Math.max(0, idx * ROW_H - Math.floor(el.clientHeight / 3));
      virt.scrollToOffset(top);
    },
    [blockItem, virt],
  );

  // initial position + re-anchor on mode / collapse change
  useLayoutEffect(() => {
    if (cur >= 0) scrollToBlock(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, collapse]);

  // reset horizontal offsets when switching layout
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.style.setProperty('--dw-lx', '0');
    el.style.setProperty('--dw-rx', '0');
    if (leftBar.current) leftBar.current.scrollLeft = 0;
    if (rightBar.current) rightBar.current.scrollLeft = 0;
  }, [mode]);

  useImperativeHandle(
    ref,
    () => ({
      navigate(dir) {
        if (blocks.length === 0) return false;
        const el = scrollRef.current;
        const top = el ? el.scrollTop : 0;
        const h = el ? el.clientHeight : 0;
        const firstVis = Math.floor(top / ROW_H);
        const lastVis = Math.floor((top + h - 1) / ROW_H);
        let target: number;
        if (cur >= 0 && cur < blocks.length && blockItem(cur) >= firstVis && blockItem(cur) <= lastVis) {
          target = cur + dir;
        } else if (dir > 0) {
          target = blocks.findIndex((_, b) => blockItem(b) >= firstVis);
        } else {
          target = -1;
          for (let b = blocks.length - 1; b >= 0; b--) if (blockItem(b) < firstVis) { target = b; break; }
        }
        if (target < 0 || target >= blocks.length) return false;
        scrollToBlock(target);
        return true;
      },
      focus() {
        scrollRef.current?.focus({ preventScroll: true });
      },
    }),
    [blocks, cur, blockItem, scrollToBlock],
  );

  // horizontal wheel → the pane under the pointer
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      let dx = e.deltaX;
      if (e.shiftKey && dx === 0) dx = e.deltaY;
      if (dx === 0 || (!e.shiftKey && Math.abs(dx) < Math.abs(e.deltaY))) return;
      let bar = leftBar.current;
      if (mode === 'sbs') {
        const r = el.getBoundingClientRect();
        if (e.clientX > r.left + r.width / 2) bar = rightBar.current;
      }
      if (!bar) return;
      bar.scrollLeft += dx;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode]);

  const onBarScroll = (side: 'l' | 'r') => (e: UIEvent<HTMLDivElement>) => {
    scrollRef.current?.style.setProperty(side === 'l' ? '--dw-lx' : '--dw-rx', String(e.currentTarget.scrollLeft));
  };

  const expand = (start: number) =>
    setExpanded((s) => {
      const next = new Set(s[mode]);
      next.add(start);
      return { ...s, [mode]: next };
    });

  // gutter width from the largest line number
  const digits = useMemo(() => {
    let max = 1;
    for (const r of model.sbs) {
      if (r.left && r.left.line > max) max = r.left.line;
      if (r.right && r.right.line > max) max = r.right.line;
    }
    return Math.max(3, String(max).length);
  }, [model]);

  const curRange = cur >= 0 && cur < blocks.length
    ? (mode === 'sbs' ? [blocks[cur].sbsStart, blocks[cur].sbsEnd] : [blocks[cur].uniStart, blocks[cur].uniEnd])
    : [-1, -1];

  const renderSbs = (r: SbsRow, rowIdx: number) => {
    if (r.kind === 'gap') return <div className="dw-gaprow">⋯ {t('dw.gap', { n: r.count })}</div>;
    let lc = '';
    let rc = '';
    let edge = '';
    if (r.kind === 'change') {
      const b = blocks[r.block];
      const t = TYPE_CLS[b.type];
      lc = r.left ? t : t + ' dw-fill';
      rc = r.right ? t : t + ' dw-fill';
      if (rowIdx === b.sbsStart) edge += ' dw-bstart';
      if (rowIdx === b.sbsEnd - 1) edge += ' dw-bend';
      if (rowIdx >= curRange[0] && rowIdx < curRange[1]) edge += ' dw-cur';
    }
    return (
      <div className={'dw-sbs' + edge}>
        <div className={'dw-code dw-l ' + lc}>
          <div className="dw-text">{r.left && <CodeText line={r.left} />}</div>
        </div>
        <div className={'dw-ln dw-ln-l ' + lc}>{r.left?.line ?? ''}</div>
        <div className={'dw-ln dw-ln-r ' + rc}>{r.right?.line ?? ''}</div>
        <div className={'dw-code dw-r ' + rc}>
          <div className="dw-text">{r.right && <CodeText line={r.right} />}</div>
        </div>
      </div>
    );
  };

  const renderUni = (r: UniRow, rowIdx: number) => {
    if (r.kind === 'gap') return <div className="dw-gaprow">⋯ {t('dw.gap', { n: r.count })}</div>;
    let c = '';
    let edge = '';
    if (r.kind !== 'equal') {
      const b = blocks[r.block];
      c = r.kind === 'add' ? 'dw-ins' : b.type === 'modify' ? 'dw-udel' : 'dw-del';
      if (rowIdx === b.uniStart) edge += ' dw-bstart';
      if (rowIdx === b.uniEnd - 1) edge += ' dw-bend';
      if (rowIdx >= curRange[0] && rowIdx < curRange[1]) edge += ' dw-cur';
    }
    return (
      <div className={'dw-uni' + edge}>
        <div className={'dw-ln dw-ln-l ' + c}>{r.oldLine ?? ''}</div>
        <div className={'dw-ln dw-ln-r ' + c}>{r.newLine ?? ''}</div>
        <div className={'dw-code dw-l ' + c}>
          <div className="dw-text"><CodeText line={r.line} /></div>
        </div>
      </div>
    );
  };

  const gutterCol = `calc(${digits}ch + 14px)`;
  const cols = mode === 'sbs'
    ? `minmax(0, 1fr) ${gutterCol} ${gutterCol} minmax(0, 1fr)`
    : `${gutterCol} ${gutterCol} minmax(0, 1fr)`;

  return (
    <div className="dw-viewer" style={{ ['--dw-cols' as string]: cols }}>
      <div className="dw-scroll" ref={scrollRef} tabIndex={0}>
        <div className="dw-inner" style={{ height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((vi) => {
            const it = display.items[vi.index];
            return (
              <div key={vi.key} className="dw-row" style={{ transform: `translateY(${vi.start}px)` }}>
                {it.kind === 'fold' ? (
                  <button className="dw-foldrow" onClick={() => expand(it.start)} title={t('dw.expandTip')}>
                    <span className="dw-fold-ico">⋯</span> {t('dw.hidden', { n: it.end - it.start })}
                  </button>
                ) : mode === 'sbs' ? (
                  renderSbs(model.sbs[it.index], it.index)
                ) : (
                  renderUni(model.uni[it.index], it.index)
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="dw-hbars">
        <div className="dw-hbar" ref={leftBar} onScroll={onBarScroll('l')}>
          <div style={{ width: `calc(${mode === 'sbs' ? model.leftCols : Math.max(model.leftCols, model.rightCols)}ch + 40px)` }} />
        </div>
        {mode === 'sbs' && (
          <>
            <div style={{ width: `calc(2 * ${gutterCol})` }} />
            <div className="dw-hbar" ref={rightBar} onScroll={onBarScroll('r')}>
              <div style={{ width: `calc(${model.rightCols}ch + 40px)` }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
