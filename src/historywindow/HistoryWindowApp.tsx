// Root component of the File History window (index.html?historySession=<id>):
// commit list for one file (git log --follow) + Diff / Blame view of the selected commit.
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import '../App.css';
import '../diffwindow/diff.css';
import './history.css';
import { call, toAppError } from '../api';
import type { DiffViewerHandle } from '../diffwindow/DiffViewer';
import type { BlameCommit, BlameLine, FileHistory, FileHistoryEntry } from '../types';
import { ContextMenu, useContextMenu, type MenuItem } from '../ui/common/ContextMenu';
import { Icon } from '../ui/common/Icons';
import { Tooltip, TooltipHost } from '../ui/common/Tooltip';
import { Toast } from '../ui/dialogs/Toast';
import { formatFullDate } from '../ui/format/date';
import { SplitPane } from '../ui/layout/SplitPane';
import { hasMod } from '../ui/platform';
import type { ToastState } from '../ui/state/repoStore';
import { BlameView, type BlameTarget } from './BlameView';
import { filterEntries, findEntry, previousNames } from './entries';
import { HistoryDiff } from './HistoryDiff';
import { HistoryList } from './HistoryList';
import {
  basename,
  EVENT_HISTORY_SESSION_UPDATE,
  historyWindowTitle,
  latestHistorySessionId,
  loadHistorySession,
  type HistorySession,
  type HistorySessionUpdateEvent,
} from './session';
import { t } from '../i18n';

type Mode = 'diff' | 'blame';
const PREFS_KEY = 'hw-prefs';
interface Prefs { mode: Mode; collapse: boolean }

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { mode: p.mode === 'blame' ? 'blame' : 'diff', collapse: p.collapse === true };
  } catch {
    return { mode: 'diff', collapse: false };
  }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

type HistoryState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: FileHistory };

function initialSessionId(): string | null {
  const q = new URLSearchParams(window.location.search).get('historySession');
  return latestHistorySessionId() ?? q;
}

let toastNonce = 1;

export default function HistoryWindowApp() {
  const [session, setSession] = useState<HistorySession | null>(() => {
    const id = initialSessionId();
    return id ? loadHistorySession(id) : null;
  });
  const [history, setHistory] = useState<HistoryState>({ kind: 'loading' });
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [focusLine, setFocusLine] = useState<number | null>(null);
  const [override, setOverride] = useState<(BlameTarget & { label: string }) | null>(null);
  const [revealToken, setRevealToken] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [changeCount, setChangeCount] = useState<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewer = useRef<DiffViewerHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const ctx = useContextMenu();

  const showToast = useCallback((kind: ToastState['kind'], text: string) => {
    clearTimeout(toastTimer.current);
    const id = toastNonce++;
    setToast({ id, kind, text });
    toastTimer.current = setTimeout(() => setToast((x) => (x?.id === id ? null : x)), kind === 'error' ? 8000 : 4000);
  }, []);

  // session updates from other windows
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    listen<HistorySessionUpdateEvent>(EVENT_HISTORY_SESSION_UPDATE, (e) => {
      const s = loadHistorySession(e.payload.id);
      if (s) setSession(s);
    })
      .then((u) => (dead ? u() : (un = u)))
      .catch(() => {});
    return () => { dead = true; un?.(); };
  }, []);

  // load the history for the session
  useEffect(() => {
    if (!session) return;
    setHistory({ kind: 'loading' });
    setSelectedHash(null);
    setFilter('');
    setOverride(null);
    setFocusLine(null);
    let cancelled = false;
    call('get_file_history', { repoPath: session.repoPath, path: session.path, rev: session.rev })
      .then((h) => {
        if (cancelled) return;
        setHistory({ kind: 'ok', data: h });
        const i = findEntry(h.entries, session.selectHash);
        setSelectedHash(h.entries[i >= 0 ? i : 0]?.hash ?? null);
        setRevealToken((n) => n + 1);
      })
      .catch((e) => { if (!cancelled) setHistory({ kind: 'error', message: toAppError(e).message }); });
    return () => { cancelled = true; };
  }, [session]);

  // window title
  useEffect(() => {
    if (!session) return;
    const title = historyWindowTitle(session.repoName, session.path);
    document.title = title;
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [session]);

  const entries = useMemo(() => (history.kind === 'ok' ? history.data.entries : []), [history]);
  const visible = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const selIdx = useMemo(() => findEntry(entries, selectedHash), [entries, selectedHash]);
  const selected: FileHistoryEntry | undefined = selIdx >= 0 ? entries[selIdx] : undefined;
  const formerly = useMemo(() => previousNames(entries), [entries]);

  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((old) => { const n = { ...old, ...p }; savePrefs(n); return n; });

  const selectFromList = useCallback((hash: string) => {
    setSelectedHash(hash);
    setOverride(null);
    setFocusLine(null);
  }, []);

  /** Select a blamed commit in the list ("when did this line come in"). */
  const pickCommit = useCallback(
    (hash: string, origLine: number | null) => {
      const i = findEntry(entries, hash);
      if (i < 0) {
        showToast('info', t('hw.outsideHistory', { hash: hash.slice(0, 8) }));
        return false;
      }
      if (!filterEntries([entries[i]], filter).length) setFilter('');
      setSelectedHash(entries[i].hash);
      setOverride(null);
      setFocusLine(origLine);
      setRevealToken((n) => n + 1);
      return true;
    },
    [entries, filter, showToast],
  );

  const blamePrevious = useCallback(
    (hash: string, origPath: string, origLine: number | null) => {
      const i = findEntry(entries, hash);
      const e = i >= 0 ? entries[i] : undefined;
      const rev = e ? e.parents[0] ?? null : hash + '^';
      if (!rev) return;
      const path = e ? e.oldPath ?? e.path : origPath;
      setOverride({ rev, path, focusLine: origLine, label: e?.parents[0] ? rev.slice(0, 8) : hash.slice(0, 8) + '^' });
    },
    [entries],
  );

  const onBlameContext = useCallback(
    (ev: ReactMouseEvent, line: BlameLine, c: BlameCommit | undefined) => {
      const inHistory = findEntry(entries, line.hash) >= 0;
      const e = inHistory ? entries[findEntry(entries, line.hash)] : undefined;
      const canPrev = !c?.boundary && (e ? e.parents.length > 0 && e.status !== 'added' : true);
      const items: MenuItem[] = [
        { label: t('hw.selectInList'), onClick: () => { pickCommit(line.hash, line.origLine); } },
        {
          label: t('hw.showDiff'),
          disabled: !inHistory,
          onClick: () => { if (pickCommit(line.hash, line.origLine)) updatePrefs({ mode: 'diff' }); },
        },
        { separator: true },
        { label: t('hw.blamePrevRev'), disabled: !canPrev, onClick: () => blamePrevious(line.hash, line.origPath, line.origLine) },
        { separator: true },
        {
          label: t('hw.copyHash'),
          onClick: () => {
            navigator.clipboard?.writeText(line.hash).then(() => showToast('info', t('details.hashCopied')), () => {});
          },
        },
      ];
      ctx.open(ev, items);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, pickCommit, blamePrevious, showToast],
  );

  const closeWindow = useCallback(() => {
    getCurrentWindow().close().catch(() => window.close());
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ctx.menu) return; // the context menu handles its own Escape
      if (e.key === 'Escape') {
        e.preventDefault();
        if (document.activeElement === filterRef.current && filter) { setFilter(''); return; }
        closeWindow();
        return;
      }
      if (hasMod(e) && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); closeWindow(); return; }
      if (hasMod(e) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); filterRef.current?.focus(); filterRef.current?.select(); return; }
      if (e.key === 'F7' && prefs.mode === 'diff') { e.preventDefault(); viewer.current?.navigate(e.shiftKey ? -1 : 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeWindow, ctx.menu, filter, prefs.mode]);

  if (!session) {
    return (
      <div className="hw-root">
        <div className="dw-placeholder">{t('hw.noSession')}</div>
      </div>
    );
  }

  // ───────────── right pane ─────────────
  let blameTarget: BlameTarget | null = null;
  if (override) blameTarget = override;
  else if (selected && selected.status !== 'deleted') blameTarget = { rev: selected.hash, path: selected.path, focusLine };
  else if (!selected && history.kind === 'ok' && entries.length === 0) blameTarget = { rev: session.rev ?? 'HEAD', path: session.path, focusLine: null };

  let right: ReactNode;
  if (history.kind === 'loading') right = <div className="dw-placeholder">{t('common.loading')}</div>;
  else if (history.kind === 'error') right = <div className="dw-placeholder dw-err">{history.message}</div>;
  else if (prefs.mode === 'blame') {
    if (blameTarget) {
      right = (
        <BlameView
          repoPath={session.repoPath}
          target={blameTarget}
          selectedHash={override ? null : selectedHash}
          onPick={(l) => { pickCommit(l.hash, l.origLine); }}
          onContext={onBlameContext}
        />
      );
    } else if (selected?.status === 'deleted') {
      right = (
        <div className="dw-placeholder">
          <div>{t('hw.deletedHere')}</div>
          {selected.parents[0] && (
            <button className="btn small hw-gap-top" onClick={() => blamePrevious(selected.hash, selected.path, null)}>{t('hw.blameParentInstead')}</button>
          )}
        </div>
      );
    } else right = <div className="dw-placeholder">{t('hw.selectCommit')}</div>;
  } else if (selected) {
    right = <HistoryDiff ref={viewer} repoPath={session.repoPath} entry={selected} collapse={prefs.collapse} onChangeCount={setChangeCount} />;
  } else right = <div className="dw-placeholder">{entries.length === 0 ? t('hw.noHistory') : t('hw.selectCommit')}</div>;

  const atPath = selected && selected.path !== session.path ? selected.path : null;
  const dir = session.path.includes('/') ? session.path.slice(0, session.path.lastIndexOf('/') + 1) : '';
  const isDiff = prefs.mode === 'diff';

  // ───────────── left pane ─────────────
  let left: ReactNode;
  if (history.kind === 'loading') left = <div className="empty-note">{t('common.loading')}</div>;
  else if (history.kind === 'error') left = <div className="empty-note err">{history.message}</div>;
  else if (entries.length === 0) left = <div className="empty-note">{t('hw.noHistory')}</div>;
  else if (visible.length === 0) left = <div className="empty-note">{t('hw.noMatch')}</div>;
  else left = <HistoryList entries={visible} selectedHash={selectedHash} onSelect={selectFromList} revealToken={revealToken} />;

  return (
    <div className="hw-root">
      <div className="hw-toolbar">
        <div className="hw-file" title={session.path}>
          {/* LRM marks keep the slashes in place under direction: rtl (used to ellipsize the start of long paths). */}
          <span className="hw-file-dir">{dir && `\u200E${dir}\u200E`}</span>
          <span className="hw-file-name">{basename(session.path)}</span>
          {(atPath || formerly.length > 0) && (
            <span className="hw-file-hint" title={formerly.join('\n')}>
              {atPath ? t('hw.atCommitPath', { path: atPath }) : t('hw.formerly', { names: formerly.slice(0, 2).map(basename).join(', ') + (formerly.length > 2 ? '…' : '') })}
            </span>
          )}
        </div>
        <span className="grow" />
        {isDiff && (
          <>
            <Tooltip label={t('dw.prevChange')}>
              <button className="dw-btn" disabled={!changeCount} onClick={() => viewer.current?.navigate(-1)}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 3.5 3.5 8h3v4.5h3V8h3z" /></svg>
              </button>
            </Tooltip>
            <Tooltip label={t('dw.nextChange')}>
              <button className="dw-btn" disabled={!changeCount} onClick={() => viewer.current?.navigate(1)}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 12.5 12.5 8h-3V3.5h-3V8h-3z" /></svg>
              </button>
            </Tooltip>
            <Tooltip label={t('dw.collapseUnchanged')}>
              <button className={'dw-btn' + (prefs.collapse ? ' on' : '')} aria-pressed={prefs.collapse} onClick={() => updatePrefs({ collapse: !prefs.collapse })}>
                <Icon name="collapse" size={14} />
              </button>
            </Tooltip>
            <span className="dw-sep" />
          </>
        )}
        <div className="dw-seg" role="group" aria-label={t('hw.modeAria')}>
          <button className={isDiff ? 'on' : ''} aria-pressed={isDiff} title={t('hw.diffTip')} onClick={() => updatePrefs({ mode: 'diff' })}>{t('hw.diff')}</button>
          <button className={!isDiff ? 'on' : ''} aria-pressed={!isDiff} title={t('hw.blameTip')} onClick={() => updatePrefs({ mode: 'blame' })}>{t('hw.blame')}</button>
        </div>
        <div className="search-box hw-search">
          <Icon name="search" size={13} />
          <input
            ref={filterRef}
            value={filter}
            placeholder={t('hw.filterPh')}
            aria-label={t('hw.filterAria')}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <div className="hw-main">
        <SplitPane dir="h" fixed="start" defaultSize={380} min={240} storageKey="history-list">
          <div className="hw-left">
            <div className="pane-header">
              <span>
                {history.kind === 'ok'
                  ? filter.trim()
                    ? t('hw.filteredCount', { shown: visible.length, n: entries.length })
                    : t('hw.commitCount', { n: entries.length })
                  : t('hw.commitCount', { n: 0 })}
              </span>
              {history.kind === 'ok' && history.data.truncated && <span className="muted"> · {t('hw.truncated', { n: entries.length })}</span>}
            </div>
            {left}
          </div>
          <div className="hw-right">
            {selected && !(override && !isDiff) && (
              <div className="hw-commitbar" title={`${selected.subject}\n${selected.authorName} <${selected.authorEmail}>\n${selected.hash}`}>
                <span className="dw-hash">{selected.hash.slice(0, 8)}</span>
                <span className="hw-commitbar-subject">{selected.subject}</span>
                <span className="muted">{selected.authorName} · {formatFullDate(selected.authorTime)}</span>
              </div>
            )}
            {override && !isDiff && (
              <div className="hw-commitbar">
                <span>{t('hw.blameAt', { rev: override.label })}</span>
                <span className="dw-path hw-commitbar-subject" title={override.path}>{override.path}</span>
                <button className="btn small" onClick={() => setOverride(null)}>{t('hw.backToSelected')}</button>
              </div>
            )}
            <div className="hw-right-body">{right}</div>
          </div>
        </SplitPane>
      </div>

      {ctx.menu && <ContextMenu menu={ctx.menu} onClose={ctx.close} />}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      <TooltipHost />
    </div>
  );
}
