// Menu bar "Quick Commit" popover (label "quick-commit", index.html?quickCommit=1). Owned by ui-app.
// File checklist (stage/unstage), message, Commit / Commit & Push. Esc hides the window.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef, useState } from 'react';
import '../App.css';
import './quickcommit.css';
import { call, onEvent, onRepoChanged } from '../api';
import { LangRoot, t } from '../i18n';
import { EVENT_QUICK_COMMIT_TARGET, type FileStatus, type QuickCommitTargetEvent, type RepoSummary, type StatusFile } from '../types';
import { Tooltip, TooltipHost } from '../ui/common/Tooltip';
import { hasMod } from '../ui/platform';
import { useStoreState } from '../ui/state/createStore';
import { QuickCommitModel, isConflicted, isPartiallyStaged } from './quickModel';

const model = new QuickCommitModel();

const LETTER: Record<FileStatus, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typeChanged: 'T', unmerged: 'U', unknown: '?' };

function letterOf(f: StatusFile): { ch: string; cls: string } {
  if (f.conflict) return { ch: '!', cls: 'conflict' };
  if (f.untracked) return { ch: 'U', cls: 'added' };
  const s = f.staged ?? f.unstaged ?? 'unknown';
  return { ch: LETTER[s], cls: s };
}

const split = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};

function hide(): void {
  getCurrentWindow().hide().catch(() => {});
}

function openLanes(repoPath: string | null): void {
  void call('show_main_window', { repoPath }).then(hide).catch(() => {});
}

function Inner() {
  const s = useStoreState(model, (x) => x);
  const msgRef = useRef<HTMLTextAreaElement>(null);
  const [repos, setRepos] = useState<RepoSummary[]>([]);

  // each show re-targets the window
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    onEvent<QuickCommitTargetEvent>(EVENT_QUICK_COMMIT_TARGET, (e) => {
      void model.retarget(e.repoPath);
      setTimeout(() => msgRef.current?.focus(), 30);
    })
      .then((u) => (dead ? u() : (un = u)))
      .catch(() => {});
    return () => { dead = true; un?.(); };
  }, []);

  // the first show may emit before this listener existed: offer the repos instead of a blank window
  useEffect(() => {
    if (s.repoPath) return;
    call('get_repo_summaries', {}).then(setRepos).catch(() => {});
  }, [s.repoPath]);

  // live status while the window is open
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onRepoChanged((e) => {
      if (e.repoPath !== model.getState().repoPath || model.getState().busy) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void model.refresh(); }, 200);
    })
      .then((u) => (dead ? u() : (un = u)))
      .catch(() => {});
    return () => { dead = true; clearTimeout(timer); un?.(); };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
      else if (hasMod(e) && e.key === 'Enter') { e.preventDefault(); void model.commit(e.shiftKey); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const files = s.status?.files ?? [];
  const staged = files.filter((f) => model.checked(f)).length;
  const hasConflict = files.some(isConflicted);
  const can = model.canCommit();
  const busy = s.busy !== null;
  const st = s.status;
  const repoName = s.repoPath ? s.repoPath.split('/').filter(Boolean).pop() : null;

  if (!s.repoPath) {
    return (
      <div className="qc-root">
        <div className="qc-empty">
          <b>{t('quick.noRepo')}</b>
          {repos.length === 0 ? (
            <span className="muted">{t('quick.noRepoHint')}</span>
          ) : (
            <ul className="qc-repos">
              {repos.map((r) => (
                <li key={r.path}><button className="btn" onClick={() => void model.retarget(r.path)}>{r.name}{r.branch ? <span className="muted"> · {r.branch}</span> : null}</button></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="qc-root">
      <div className="qc-head">
        <div className="qc-repo" title={s.repoPath}>{repoName}</div>
        <div className="qc-branch">
          <span className="qc-branch-name">{st ? st.branch ?? t('quick.detached') : '…'}</span>
          {st && (st.ahead ?? 0) > 0 && <span className="qc-ahead" title="ahead">↑{st.ahead}</span>}
          {st && (st.behind ?? 0) > 0 && <span className="qc-behind" title="behind">↓{st.behind}</span>}
        </div>
      </div>

      <div className="qc-listhead">
        <label className="qc-check">
          <input
            type="checkbox"
            checked={files.length > 0 && staged === files.length}
            ref={(el) => { if (el) el.indeterminate = staged > 0 && staged < files.length; }}
            disabled={files.length === 0 || busy}
            onChange={() => void model.toggleAll()}
            aria-label={t('quick.selectAll')}
          />
          <span className="muted">{s.loading ? t('quick.loading') : t('quick.files', { n: files.length })}</span>
        </label>
        <span className="grow" />
        {files.length > 0 && <span className="muted">{t('quick.staged', { n: staged })}</span>}
      </div>

      <div className="qc-list" role="list">
        {s.statusError && <div className="qc-note err">{t('quick.statusFail', { msg: s.statusError })}</div>}
        {!s.loading && !s.statusError && files.length === 0 && <div className="qc-note">{t('quick.noChanges')}</div>}
        {files.map((f) => {
          const [dir, name] = split(f.path);
          const L = letterOf(f);
          const conflict = isConflicted(f);
          return (
            <label key={f.path} className={'qc-file' + (conflict ? ' conflict' : '')} role="listitem" title={f.path}>
              <input
                type="checkbox"
                checked={model.checked(f)}
                ref={(el) => { if (el) el.indeterminate = !s.overlay[f.path] && isPartiallyStaged(f); }}
                disabled={conflict || busy}
                onChange={() => void model.toggle(f.path)}
              />
              <span className={'qc-st st-' + L.cls}>{L.ch}</span>
              <span className="qc-path"><span className="qc-dir">{dir}</span><span className="qc-name">{name}</span></span>
            </label>
          );
        })}
        {st?.truncated && <div className="qc-note">{t('quick.truncated')}</div>}
      </div>

      {hasConflict && <div className="qc-banner warn">{t('quick.conflictHint')}</div>}

      <textarea
        ref={msgRef}
        className="qc-msg"
        value={s.message}
        placeholder={t('quick.messagePh')}
        spellCheck={false}
        disabled={s.busy === 'commit'}
        onChange={(e) => model.setMessage(e.target.value)}
        aria-label={t('quick.messagePh')}
      />

      {s.commitError && <div className="qc-banner err" role="alert">{t('quick.commitFail', { msg: s.commitError })}</div>}
      {s.pushFailure && (
        <div className="qc-banner err" role="alert">
          <div>
            {s.pushFailure.kind === 'noRemote' ? t('quick.noRemote') : t('quick.pushFail', { msg: s.pushFailure.error.message })}
          </div>
          {s.pushFailure.kind === 'error' && s.pushFailure.error.stderr && <pre className="qc-stderr">{s.pushFailure.error.stderr.trim().split('\n').slice(-6).join('\n')}</pre>}
          <div className="qc-banner-actions">
            {s.pushFailure.kind === 'error' && <button className="btn small" disabled={busy} onClick={() => void model.retryPush()}>{t('quick.retryPush')}</button>}
            <button className="btn small primary" onClick={() => openLanes(s.repoPath)}>{t('quick.openLanes')}</button>
          </div>
        </div>
      )}
      {s.done && !s.pushFailure && !s.commitError && <div className="qc-banner ok" role="status">{s.done.pushed ? t('quick.pushed') : t('quick.committed')}</div>}

      <div className="qc-actions">
        <Tooltip label={t('quick.hint')} side="top"><span className="qc-hint muted">{busy ? <><span className="spinner" /> {s.busy === 'push' ? t('quick.pushing') : t('quick.committing')}</> : '⌘↩'}</span></Tooltip>
        <span className="grow" />
        <button className="btn" disabled={!can} onClick={() => void model.commit(false)}>{t('quick.commit')}</button>
        <button className="btn primary" disabled={!can} onClick={() => void model.commit(true)}>{t('quick.commitPush')}</button>
      </div>
      <TooltipHost />
    </div>
  );
}

export default function QuickCommitApp() {
  return (
    <LangRoot>
      <Inner />
    </LangRoot>
  );
}
