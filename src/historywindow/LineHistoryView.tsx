// Line-history mode ("Show History for Selection"): commits that touched a line range (git log -L),
// each with just that range's hunks. Owned by ui-app.
import { useEffect, useMemo, useState } from 'react';
import { call, toAppError } from '../api';
import { t } from '../i18n';
import type { LineHistory, LineHistoryEntry, LineRange } from '../types';
import { formatFullDate } from '../ui/format/date';
import { CommitDate } from '../ui/format/CommitDate';
import { basename } from './session';

export interface LineMode {
  path: string;
  rev: string | null;
  range: LineRange;
}

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: LineHistory };

const cache = new Map<string, LineHistory>();
const keyOf = (repoPath: string, m: LineMode) => `${repoPath}\0${m.rev ?? ''}\0${m.path}\0${m.range.start}-${m.range.end}`;

interface Props {
  repoPath: string;
  mode: LineMode;
  onBack: () => void;
}

export function LineHistoryView({ repoPath, mode, onBack }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [sel, setSel] = useState<string | null>(null);
  const key = keyOf(repoPath, mode);

  useEffect(() => {
    setSel(null);
    const hit = cache.get(key);
    if (hit) { setState({ kind: 'ok', data: hit }); return; }
    setState({ kind: 'loading' });
    let cancelled = false;
    call('get_line_history', { repoPath, path: mode.path, rev: mode.rev, range: mode.range })
      .then((d) => {
        if (cache.size > 20) cache.clear();
        cache.set(key, d);
        if (!cancelled) setState({ kind: 'ok', data: d });
      })
      .catch((e) => { if (!cancelled) setState({ kind: 'error', message: toAppError(e).message }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const entries: LineHistoryEntry[] = useMemo(() => (state.kind === 'ok' ? state.data.entries : []), [state]);
  const cur = entries.find((e) => e.hash === sel) ?? entries[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (entries.length === 0) return;
      const i = Math.max(0, entries.findIndex((x) => x.hash === (cur?.hash ?? '')));
      const n = Math.min(entries.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
      e.preventDefault();
      setSel(entries[n].hash);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entries, cur]);

  const range = t('history.range', { start: mode.range.start, end: mode.range.end });
  return (
    <div className="lh-root">
      <div className="lh-bar">
        <button className="btn small" onClick={onBack}>{t('history.back')}</button>
        <span className="lh-title" title={mode.path}>{t('history.lineHeader', { path: basename(mode.path), range })}</span>
        <span className="grow" />
        {state.kind === 'ok' && <span className="muted">{t('hw.commitCount', { n: entries.length })}{state.data.truncated ? ` · ${t('history.truncated')}` : ''}</span>}
      </div>
      <div className="lh-main">
        <div className="hw-left lh-left">
          {state.kind === 'loading' && <div className="empty-note">{t('history.loading')}</div>}
          {state.kind === 'error' && <div className="empty-note err">{state.message}</div>}
          {state.kind === 'ok' && entries.length === 0 && <div className="empty-note">{t('history.noEntries')}</div>}
          {entries.length > 0 && (
            <div className="hw-list" role="listbox" tabIndex={0} aria-label={t('hw.listAria')}>
              {entries.map((e) => (
                <div
                  key={e.hash}
                  role="option"
                  aria-selected={e.hash === cur?.hash}
                  className="lh-row"
                  onMouseDown={() => setSel(e.hash)}
                  title={`${e.subject}\n${e.authorName} <${e.authorEmail}>\n${formatFullDate(e.authorTime)}\n${e.hash}`}
                >
                  <div className={'hw-item' + (e.hash === cur?.hash ? ' selected' : '')}>
                    <div className="hw-item-line1"><span className="hw-item-subject">{e.subject}</span></div>
                    <div className="hw-item-line2">
                      <span className="hw-item-hash">{e.hash.slice(0, 8)}</span>
                      <span className="hw-item-author">{e.authorName}</span>
                      <span className="hw-item-date"><CommitDate ts={e.authorTime} /></span>
                      <span className="grow" />
                      <span>{t('history.hunkCount', { n: e.hunks.length })}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="hw-right lh-right">
          {cur ? (
            <>
              <div className="hw-commitbar" title={cur.hash}>
                <span className="dw-hash">{cur.hash.slice(0, 8)}</span>
                <span className="hw-commitbar-subject">{cur.subject}</span>
                {cur.path !== mode.path && <span className="dw-path" title={cur.path}>{cur.path}</span>}
              </div>
              <div className="lh-hunks">
                {cur.hunks.map((h, hi) => (
                  <div key={hi}>
                    <div className="lh-hunk-head">{h.header}</div>
                    {h.lines.map((l, li) => (
                      <div key={li} className={'lh-line ' + l.kind}>
                        <span className="lh-ln">{l.kind === 'add' || l.kind === 'context' ? l.newLine ?? '' : l.oldLine ?? ''}</span>
                        <span className="lh-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : l.kind === 'noNewline' ? '\\' : ' '}</span>
                        <span>{l.text}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="dw-placeholder">{state.kind === 'loading' ? t('common.loading') : ''}</div>
          )}
        </div>
      </div>
    </div>
  );
}
