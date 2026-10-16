// Root component of the separate diff window (index.html?diffSession=<id>).
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { call, toAppError } from '../api';
import type { ChangedFile, FileDiff } from '../types';
import { buildDiffModel, type DiffModel } from './align';
import { DiffViewer, type DiffViewerHandle, type ViewMode } from './DiffViewer';
import {
  diffWindowTitle,
  EVENT_DIFF_SESSION_UPDATE,
  latestDiffSessionId,
  loadDiffSession,
  type DiffSession,
  type DiffSessionUpdateEvent,
} from './session';
import './diff.css';
import { t } from '../i18n';

const FULL_CONTEXT = 1_000_000;
const PREFS_KEY = 'dw-prefs';

interface Prefs {
  mode: ViewMode;
  collapse: boolean;
}

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return { mode: p.mode === 'unified' ? 'unified' : 'sbs', collapse: p.collapse === true };
  } catch {
    return { mode: 'sbs', collapse: false };
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

interface Loaded {
  diff: FileDiff;
  model: DiffModel;
  partial: boolean; // full-context diff was truncated → refetched with 3 context lines
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'binary' }
  | { kind: 'ok'; data: Loaded };

const fileKey = (f: ChangedFile) => `${f.fromHash ?? '∅'}:${f.toHash}:${f.oldPath ?? ''}:${f.path}`;
const shortHash = (h: string | null) => (h ? h.slice(0, 8) : null);

async function fetchDiff(repoPath: string, f: ChangedFile): Promise<Loaded> {
  const request = { path: f.path, oldPath: f.oldPath, fromHash: f.fromHash, toHash: f.toHash, contextLines: FULL_CONTEXT };
  let diff = await call('get_file_diff', { repoPath, request });
  let partial = false;
  if (diff.truncated) {
    diff = await call('get_file_diff', { repoPath, request: { ...request, contextLines: 3 } });
    partial = true;
  }
  return { diff, model: buildDiffModel(diff), partial };
}

function initialSessionId(): string | null {
  const q = new URLSearchParams(window.location.search).get('diffSession');
  // The latest pointer wins: it covers a session update that arrived before this window listened.
  return latestDiffSessionId() ?? q;
}

// ───────────── icons ─────────────
const I = {
  up: <path d="M8 3.5 3.5 8h3v4.5h3V8h3z" />,
  down: <path d="M8 12.5 12.5 8h-3V3.5h-3V8h-3z" />,
  left: <path d="M3.5 8 8 3.5v3h4.5v3H8v3z" />,
  right: <path d="M12.5 8 8 12.5v-3H3.5v-3H8v-3z" />,
  collapse: <path d="M4 2.5h8M4 13.5h8M8 4.5v2.5M6 6l2 2 2-2M8 11.5V9M6 10l2-2 2 2" fill="none" stroke="currentColor" strokeWidth="1.2" />,
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
      />
    </>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </>
  ),
};
const Ico = ({ n, size = 16 }: { n: keyof typeof I; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">{I[n]}</svg>
);

const statusLabel = (s: ChangedFile['status']): string => t(`dw.status.${s}`);

export default function DiffWindowApp() {
  const [session, setSession] = useState<DiffSession | null>(() => {
    const id = initialSessionId();
    return id ? loadDiffSession(id) : null;
  });
  const [index, setIndex] = useState(() => session?.index ?? 0);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [entryBlock, setEntryBlock] = useState<'first' | 'last'>('first');
  const [menu, setMenu] = useState<null | 'files' | 'settings'>(null);
  const [hint, setHint] = useState<string | null>(null);
  const viewer = useRef<DiffViewerHandle>(null);
  const cache = useRef(new Map<string, Loaded>());
  const edge = useRef<{ dir: 1 | -1; at: number } | null>(null);

  const files = session?.files ?? [];
  const file: ChangedFile | undefined = files[index];

  // session updates from the main window
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    listen<DiffSessionUpdateEvent>(EVENT_DIFF_SESSION_UPDATE, (e) => {
      const s = loadDiffSession(e.payload.id);
      if (!s) return;
      cache.current.clear();
      setSession(s);
      setIndex(s.index);
      setEntryBlock('first');
      setMenu(null);
    })
      .then((u) => (dead ? u() : (un = u)))
      .catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, []);

  // load the current file
  useEffect(() => {
    if (!session || !file) return;
    setHint(null);
    edge.current = null;
    if (file.binary) {
      setState({ kind: 'binary' });
      return;
    }
    const key = fileKey(file);
    const hit = cache.current.get(key);
    if (hit) {
      setState({ kind: 'ok', data: hit });
      return;
    }
    setState({ kind: 'loading' });
    let cancelled = false;
    fetchDiff(session.repoPath, file)
      .then((d) => {
        if (cache.current.size > 40) cache.current.clear();
        cache.current.set(key, d);
        if (!cancelled) setState(d.diff.binary ? { kind: 'binary' } : { kind: 'ok', data: d });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: 'error', message: toAppError(e).message });
      });
    return () => {
      cancelled = true;
    };
  }, [session, file]);

  // window title
  useEffect(() => {
    if (!session) return;
    const t = diffWindowTitle(session.repoName, file);
    document.title = t;
    getCurrentWindow().setTitle(t).catch(() => {});
  }, [session, file]);

  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((old) => {
      const n = { ...old, ...p };
      savePrefs(n);
      return n;
    });

  const goFile = useCallback(
    (dir: 1 | -1, entry: 'first' | 'last' = 'first') => {
      const n = index + dir;
      if (n < 0 || n >= files.length) return false;
      setEntryBlock(entry);
      setIndex(n);
      return true;
    },
    [index, files.length],
  );

  const goChange = useCallback(
    (dir: 1 | -1) => {
      if (viewer.current?.navigate(dir)) {
        edge.current = null;
        setHint(null);
        return;
      }
      const canFile = dir > 0 ? index < files.length - 1 : index > 0;
      if (!canFile) {
        setHint(dir > 0 ? t('dw.lastChange') : t('dw.firstChange'));
        return;
      }
      const now = Date.now();
      if (edge.current && edge.current.dir === dir && now - edge.current.at < 3000) {
        edge.current = null;
        goFile(dir, dir > 0 ? 'first' : 'last');
        return;
      }
      edge.current = { dir, at: now };
      setHint(dir > 0 ? t('dw.nextFileHint') : t('dw.prevFileHint'));
    },
    [goFile, index, files.length],
  );

  const closeWindow = useCallback(() => {
    getCurrentWindow().close().catch(() => window.close());
  }, []);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (menu) setMenu(null);
        else closeWindow();
        return;
      }
      if (meta && (e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        closeWindow();
        return;
      }
      if (e.key === 'F7') {
        e.preventDefault();
        goChange(e.shiftKey ? -1 : 1);
        return;
      }
      if (meta && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        goChange(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if ((meta || e.altKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        goFile(e.key === 'ArrowRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goChange, goFile, closeWindow, menu]);

  // close popovers on outside click
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.dw-pop, .dw-pop-anchor')) setMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu]);

  // focus the code area once content is there (arrow keys / PageUp scroll)
  useEffect(() => {
    if (state.kind === 'ok') viewer.current?.focus();
  }, [state]);

  const changeCount = state.kind === 'ok' ? state.data.model.blocks.length : 0;

  const headers = useMemo(() => {
    if (!file) return null;
    const leftPath = file.oldPath ?? file.path;
    const leftMissing = file.status === 'added' || file.fromHash === null;
    const rightMissing = file.status === 'deleted';
    return { leftPath, leftMissing, rightMissing, renamed: !!file.oldPath && file.oldPath !== file.path };
  }, [file]);

  if (!session) {
    return (
      <div className="dw-root">
        <div className="dw-placeholder">{t('dw.noSession')}</div>
      </div>
    );
  }

  const modeNote = state.kind === 'ok' && state.data.diff.oldMode && state.data.diff.newMode && state.data.diff.oldMode !== state.data.diff.newMode
    ? t('dw.mode', { a: state.data.diff.oldMode, b: state.data.diff.newMode })
    : null;

  let body: ReactNode;
  if (!file) body = <div className="dw-placeholder">{t('dw.noFile')}</div>;
  else if (state.kind === 'loading') body = <div className="dw-placeholder">{t('common.loading')}</div>;
  else if (state.kind === 'error') body = <div className="dw-placeholder dw-err">{state.message}</div>;
  else if (state.kind === 'binary') body = <div className="dw-placeholder">{t('dw.binary')}</div>;
  else if (state.data.model.sbs.length === 0) {
    body = (
      <div className="dw-placeholder">
        {headers?.renamed
          ? t('dw.renameOnly')
          : file.status === 'added' || file.status === 'deleted'
            ? t('dw.emptyFile')
            : modeNote
              ? t('dw.modeOnly')
              : t('dw.noDiff')}
      </div>
    );
  } else {
    body = (
      <DiffViewer
        key={fileKey(file)}
        ref={viewer}
        model={state.data.model}
        mode={prefs.mode}
        collapse={prefs.collapse}
        initialBlock={entryBlock}
      />
    );
  }

  const sbs = prefs.mode === 'sbs';

  return (
    <div className="dw-root">
      {/* toolbar */}
      <div className="dw-toolbar">
        <button className="dw-btn" title={t('dw.prevChange')} onClick={() => goChange(-1)} disabled={state.kind !== 'ok'}>
          <Ico n="up" />
        </button>
        <button className="dw-btn" title={t('dw.nextChange')} onClick={() => goChange(1)} disabled={state.kind !== 'ok'}>
          <Ico n="down" />
        </button>
        <span className="dw-sep" />
        <button className="dw-btn" title={t('dw.prevFile')} onClick={() => goFile(-1)} disabled={index <= 0}>
          <Ico n="left" />
        </button>
        <button
          className={'dw-filepos dw-pop-anchor' + (menu === 'files' ? ' on' : '')}
          title={session.title}
          onClick={() => setMenu(menu === 'files' ? null : 'files')}
        >
          {t('dw.fileCount', { i: index + 1, n: files.length })}
        </button>
        <button className="dw-btn" title={t('dw.nextFile')} onClick={() => goFile(1)} disabled={index >= files.length - 1}>
          <Ico n="right" />
        </button>
        <span className="dw-sep" />
        <button
          className={'dw-btn' + (prefs.collapse ? ' on' : '')}
          title={t('dw.collapseUnchanged')}
          aria-pressed={prefs.collapse}
          onClick={() => updatePrefs({ collapse: !prefs.collapse })}
        >
          <Ico n="collapse" />
        </button>
        {hint && <span className="dw-hint">{hint}</span>}
        <span className="dw-grow" />
        {state.kind === 'ok' && <span className="dw-count">{changeCount === 0 ? t('dw.noDifferences') : t('dw.diffCount', { n: changeCount })}</span>}
        <div className="dw-seg" role="group" aria-label={t('dw.viewMode')}>
          <button className={sbs ? 'on' : ''} onClick={() => updatePrefs({ mode: 'sbs' })} title={t('dw.sbsLong')}>{t('dw.sbsShort')}</button>
          <button className={!sbs ? 'on' : ''} onClick={() => updatePrefs({ mode: 'unified' })} title={t('dw.unifiedLong')}>{t('dw.unifiedShort')}</button>
        </div>
        <button
          className={'dw-btn dw-pop-anchor' + (menu === 'settings' ? ' on' : '')}
          title={t('dw.settings')}
          onClick={() => setMenu(menu === 'settings' ? null : 'settings')}
        >
          <Ico n="gear" />
        </button>

        {menu === 'files' && (
          <div className="dw-pop dw-pop-files">
            {files.map((f, i) => (
              <button
                key={fileKey(f) + i}
                className={'dw-pop-item' + (i === index ? ' on' : '')}
                onClick={() => {
                  setEntryBlock('first');
                  setIndex(i);
                  setMenu(null);
                }}
              >
                <span className={'dw-st dw-st-' + f.status}>{f.path.split('/').pop()}</span>
                <span className="dw-pop-dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
              </button>
            ))}
          </div>
        )}
        {menu === 'settings' && (
          <div className="dw-pop dw-pop-settings">
            <div className="dw-pop-title">{t('dw.scope')}</div>
            <label className="dw-pop-check">
              <input type="radio" checked={!prefs.collapse} onChange={() => updatePrefs({ collapse: false })} /> {t('dw.showAll')}
            </label>
            <label className="dw-pop-check">
              <input type="radio" checked={prefs.collapse} onChange={() => updatePrefs({ collapse: true })} /> {t('dw.collapseUnchanged')}
            </label>
            <div className="dw-pop-sep" />
            <div className="dw-pop-title">{t('dw.view')}</div>
            <label className="dw-pop-check">
              <input type="radio" checked={sbs} onChange={() => updatePrefs({ mode: 'sbs' })} /> {t('dw.sbsLong')}
            </label>
            <label className="dw-pop-check">
              <input type="radio" checked={!sbs} onChange={() => updatePrefs({ mode: 'unified' })} /> {t('dw.unifiedLong')}
            </label>
            <div className="dw-pop-sep" />
            <label className="dw-pop-check dw-disabled" title={t('dw.soon')}>
              <input type="checkbox" disabled /> {t('dw.ignoreWs')}
            </label>
          </div>
        )}
      </div>

      {/* file headers */}
      {file && headers && (
        <div className={'dw-headers' + (sbs ? '' : ' dw-headers-uni')}>
          <div className="dw-fh">
            <Ico n="lock" size={13} />
            {headers.leftMissing ? (
              <span className="dw-fh-muted">{t('dw.noFileParen')}</span>
            ) : (
              <>
                <span className="dw-hash">{shortHash(file.fromHash)}</span>
                <span className="dw-path" title={headers.leftPath}>{headers.leftPath}</span>
              </>
            )}
            {!sbs && (
              <>
                <span className="dw-fh-arrow">→</span>
                <span className="dw-hash">{shortHash(file.toHash)}</span>
                {headers.renamed && <span className="dw-path">{file.path}</span>}
              </>
            )}
          </div>
          {sbs && (
            <div className="dw-fh">
              <Ico n="lock" size={13} />
              {headers.rightMissing ? (
                <span className="dw-fh-muted">{t('dw.noFileParen')}</span>
              ) : (
                <>
                  <span className="dw-hash">{shortHash(file.toHash)}</span>
                  {headers.renamed && <span className="dw-path" title={file.path}>{file.path}</span>}
                </>
              )}
            </div>
          )}
          <div className="dw-fh-meta">
            {statusLabel(file.status)}
            {modeNote && <> · {modeNote}</>}
          </div>
        </div>
      )}

      {state.kind === 'ok' && state.data.partial && (
        <div className="dw-banner">{t('dw.bannerBigFile')}</div>
      )}
      {state.kind === 'ok' && state.data.diff.truncated && (
        <div className="dw-banner">{t('dw.bannerBigDiff')}</div>
      )}

      <div className="dw-body">{body}</div>
    </div>
  );
}
