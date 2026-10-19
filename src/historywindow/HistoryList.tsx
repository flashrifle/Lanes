// Virtualized commit list of the File History window (newest first), keyboard navigable.
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useRef, type KeyboardEvent } from 'react';
import type { FileHistoryEntry } from '../types';
import { formatFullDate } from '../ui/format/date';
import { CommitDate } from '../ui/format/CommitDate';
import { basename } from './session';
import { t } from '../i18n';

export const LIST_ROW_H = 44;

interface Props {
  entries: FileHistoryEntry[];
  selectedHash: string | null;
  onSelect: (hash: string) => void;
  /** Bumped when the selection changed from outside (blame click) to force a scroll into view. */
  revealToken: number;
}

const Row = memo(function Row({ e, selected }: { e: FileHistoryEntry; selected: boolean }) {
  const renamed = e.oldPath && e.oldPath !== e.path && (e.status === 'renamed' || e.status === 'copied');
  const stats = !e.binary && (e.additions != null || e.deletions != null);
  return (
    <div className={'hw-item' + (selected ? ' selected' : '')} title={`${e.subject}\n${e.authorName} <${e.authorEmail}>\n${formatFullDate(e.authorTime)}\n${e.hash}`}>
      <div className="hw-item-line1">
        <span className={'hw-item-dot hw-st-' + e.status} aria-hidden="true" />
        <span className="hw-item-subject">{e.subject}</span>
        {stats && (
          <span className="hw-item-stat">
            <span className="add">+{e.additions ?? 0}</span> <span className="del">-{e.deletions ?? 0}</span>
          </span>
        )}
      </div>
      <div className="hw-item-line2">
        <span className="hw-item-hash">{e.hash.slice(0, 8)}</span>
        <span className="hw-item-author">{e.authorName}</span>
        <span className="hw-item-date"><CommitDate ts={e.authorTime} /></span>
        {renamed && (
          <span className="hw-badge" title={e.oldPath ?? ''}>
            {e.status === 'copied' ? t('hw.copiedFrom', { name: basename(e.oldPath!) }) : t('hw.renamedFrom', { name: basename(e.oldPath!) })}
          </span>
        )}
      </div>
    </div>
  );
});

export function HistoryList({ entries, selectedHash, onSelect, revealToken }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LIST_ROW_H,
    overscan: 12,
  });
  const selIndex = selectedHash ? entries.findIndex((e) => e.hash === selectedHash) : -1;

  // keep the selected row visible (keyboard moves, external selection, filter changes)
  useEffect(() => {
    if (selIndex >= 0) virt.scrollToIndex(selIndex, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIndex, revealToken, entries]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (entries.length === 0) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / LIST_ROW_H) - 1);
    let next = -1;
    if (e.key === 'ArrowDown') next = selIndex < 0 ? 0 : Math.min(entries.length - 1, selIndex + 1);
    else if (e.key === 'ArrowUp') next = selIndex < 0 ? 0 : Math.max(0, selIndex - 1);
    else if (e.key === 'PageDown') next = Math.min(entries.length - 1, Math.max(0, selIndex) + page);
    else if (e.key === 'PageUp') next = Math.max(0, selIndex - page);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = entries.length - 1;
    else return;
    e.preventDefault();
    onSelect(entries[next].hash);
  };

  return (
    <div
      className="hw-list"
      ref={scrollRef}
      tabIndex={0}
      role="listbox"
      aria-label={t('hw.listAria')}
      aria-activedescendant={selIndex >= 0 ? 'hw-row-' + selIndex : undefined}
      onKeyDown={onKey}
      onMouseDown={(e) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-idx]');
        if (!el || e.button !== 0) return;
        const i = Number(el.dataset.idx);
        if (entries[i]) onSelect(entries[i].hash);
      }}
    >
      <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
        {virt.getVirtualItems().map((vi) => {
          const e = entries[vi.index];
          return (
            <div
              key={e.hash}
              id={'hw-row-' + vi.index}
              role="option"
              aria-selected={vi.index === selIndex}
              data-idx={vi.index}
              className="hw-row"
              style={{ transform: `translateY(${vi.start}px)`, height: LIST_ROW_H }}
            >
              <Row e={e} selected={vi.index === selIndex} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
