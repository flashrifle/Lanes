// Right-column panel shown while the working-tree row is selected (IntelliJ "Local Changes" + commit tool window):
// Conflicts / Staged / Unstaged / Untracked groups with stage checkboxes, commit message box with amend and
// sign-off, Commit and Commit & Push, and the stash list.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { toAppError } from '../../api';
import type { StashEntry, WorkingTreeStatus } from '../../types';
import { openDiffWindow } from '../../diffwindow/session';
import { openHistoryWindow } from '../../historywindow/session';
import { t } from '../../i18n';
import { ContextMenu, useContextMenu, type MenuItem } from '../common/ContextMenu';
import { FileIcon, Icon } from '../common/Icons';
import { fileExt } from '../details/fileTree';
import { formatCommitDate } from '../format/date';
import { SplitPane } from '../layout/SplitPane';
import { hasMod, IS_MAC } from '../platform';
import { useStoreState } from '../state/createStore';
import { useRepo, useRepoStore } from '../state/repoContext';
import type { CommitStore } from './commitStore';
import { GROUP_ORDER, workingCounts, workingEntries, type WorkingEntry, type WorkingGroup } from './workingFiles';
import { conflictSideLabel } from './conflictLabels';
import './commit.css';

const STATUS_LETTER: Record<string, string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typeChanged: 'T', unmerged: 'U', unknown: '?',
};
const STATUS_CLASS: Record<string, string> = {
  added: 'st-added', modified: 'st-modified', deleted: 'st-deleted', renamed: 'st-renamed', copied: 'st-added',
  typeChanged: 'st-modified', unmerged: 'st-conflict', unknown: '',
};

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const unique = (xs: string[]) => [...new Set(xs)];

/** Selection by entry key; keys of entries that moved group (stage/unstage) follow the path. */
function remapSelection(sel: ReadonlySet<string>, entries: WorkingEntry[]): Set<string> {
  const keys = new Set(entries.map((e) => e.key));
  const out = new Set<string>();
  for (const k of sel) {
    if (keys.has(k)) { out.add(k); continue; }
    const path = k.slice(k.indexOf(':') + 1);
    const moved = entries.find((e) => e.file.path === path);
    if (moved) out.add(moved.key);
  }
  return out;
}

export function LocalChangesPanel() {
  return (
    <div className="lc">
      <SplitPane dir="v" fixed="end" defaultSize={220} min={150} storageKey="commitbox">
        <ChangesSection />
        <CommitBox />
      </SplitPane>
    </div>
  );
}

// ───────────── file list ─────────────
function ChangesSection() {
  const store = useRepoStore();
  const cs = store.commit;
  const repo = useRepo((s) => s.repo);
  const status = useStoreState(cs, (s) => s.status);
  const statusError = useStoreState(cs, (s) => s.statusError);
  const loading = useStoreState(cs, (s) => s.statusLoading);
  const pending = useStoreState(cs, (s) => s.pending);
  const entries = useMemo(() => workingEntries(status), [status]);
  const counts = useMemo(() => workingCounts(status), [status]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<WorkingGroup>>(new Set());
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const ctx = useContextMenu();

  useEffect(() => { void cs.refreshStatus(); }, [cs]);

  // keep the selection across status refreshes (an entry that moved group stays selected)
  useEffect(() => {
    setSel((s) => remapSelection(s, entries));
    setFocus((f) => (f ? [...remapSelection(new Set([f]), entries)][0] ?? null : null));
    setAnchor((a) => (a ? [...remapSelection(new Set([a]), entries)][0] ?? null : null));
  }, [entries]);

  const visible = useMemo(() => entries.filter((e) => !collapsed.has(e.group)), [entries, collapsed]);
  const byGroup = useMemo(() => {
    const m = new Map<WorkingGroup, WorkingEntry[]>();
    for (const g of GROUP_ORDER) m.set(g, []);
    for (const e of entries) m.get(e.group)!.push(e);
    return m;
  }, [entries]);
  const selected = useMemo(() => entries.filter((e) => sel.has(e.key)), [entries, sel]);
  const operation = status?.operation ?? null;

  // ── actions ──
  const openDiff = (e: WorkingEntry) => {
    const files = entries.map((x) => x.change);
    openDiffWindow({ repoPath: repo.path, repoName: repo.name, files, index: Math.max(0, entries.indexOf(e)), title: t('commit.diffTitle') })
      .catch((err) => store.showToast('error', t('changes.diffOpenFail', { msg: toAppError(err).message })));
  };
  const openHistory = (e: WorkingEntry) => {
    openHistoryWindow({ repoPath: repo.path, repoName: repo.name, path: e.file.path, rev: null })
      .catch((err) => store.showToast('error', t('changes.historyOpenFail', { msg: toAppError(err).message })));
  };
  /** Checkbox semantics: staged rows are checked. Toggling a set: all staged → unstage, else stage the rest. */
  const toggle = (es: WorkingEntry[]) => {
    const list = es.filter((e) => e.group !== 'conflicts');
    if (list.length === 0) return;
    if (list.every((e) => e.group === 'staged')) void cs.unstage(unique(list.flatMap((e) => (e.file.oldPath ? [e.file.path, e.file.oldPath] : [e.file.path]))));
    else void cs.stage(unique(list.filter((e) => e.group !== 'staged').map((e) => e.file.path)));
  };
  const actOn = (e: WorkingEntry) => (sel.has(e.key) ? selected : [e]);
  const conflictPaths = (es: WorkingEntry[]) => unique(es.filter((e) => e.group === 'conflicts').map((e) => e.file.path));

  // ── selection ──
  const click = (ev: MouseEvent, e: WorkingEntry) => {
    const mod = hasMod(ev);
    if (ev.shiftKey && anchor) {
      const a = visible.findIndex((x) => x.key === anchor);
      const b = visible.findIndex((x) => x.key === e.key);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        const next = new Set(mod ? sel : []);
        for (let i = lo; i <= hi; i++) next.add(visible[i].key);
        setSel(next);
        setFocus(e.key);
        return;
      }
    }
    if (mod) {
      const next = new Set(sel);
      if (next.has(e.key)) next.delete(e.key); else next.add(e.key);
      setSel(next);
    } else setSel(new Set([e.key]));
    setFocus(e.key);
    setAnchor(e.key);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.target !== listRef.current) return;
    const i = focus ? visible.findIndex((x) => x.key === focus) : -1;
    const moveTo = (j: number) => {
      if (visible.length === 0) return;
      const n = Math.max(0, Math.min(visible.length - 1, j));
      const k = visible[n].key;
      if (ev.shiftKey && anchor) {
        const a = Math.max(0, visible.findIndex((x) => x.key === anchor));
        const [lo, hi] = a < n ? [a, n] : [n, a];
        setSel(new Set(visible.slice(lo, hi + 1).map((x) => x.key)));
      } else {
        setSel(new Set([k]));
        setAnchor(k);
      }
      setFocus(k);
      listRef.current?.querySelector(`[data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    const cur = i >= 0 ? visible[i] : null;
    const targets = selected.length ? selected : cur ? [cur] : [];
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); moveTo(i + 1); return;
      case 'ArrowUp': ev.preventDefault(); moveTo(i < 0 ? 0 : i - 1); return;
      case 'Home': ev.preventDefault(); moveTo(0); return;
      case 'End': ev.preventDefault(); moveTo(visible.length - 1); return;
      case ' ': ev.preventDefault(); toggle(targets); return;
      case 'Enter': if (cur) { ev.preventDefault(); openDiff(cur); } return;
      case 'F4': if (cur) { ev.preventDefault(); cs.openInEditor(cur.file.path); } return;
      case 'Delete':
      case 'Backspace':
        if (targets.length) { ev.preventDefault(); cs.confirmDiscard(targets.filter((e) => e.group !== 'conflicts')); }
        return;
    }
    if (hasMod(ev) && !ev.altKey && ev.key.toLowerCase() === 'a') { ev.preventDefault(); setSel(new Set(visible.map((x) => x.key))); return; }
    if (hasMod(ev) && !ev.altKey && ev.key.toLowerCase() === 'd' && cur) { ev.preventDefault(); openDiff(cur); }
  };

  const menuFor = (ev: MouseEvent, e: WorkingEntry) => {
    if (!sel.has(e.key)) { setSel(new Set([e.key])); setFocus(e.key); setAnchor(e.key); }
    const es = actOn(e);
    const staged = es.filter((x) => x.group === 'staged');
    const unstaged = es.filter((x) => x.group === 'unstaged' || x.group === 'untracked');
    const conflicts = conflictPaths(es);
    const discardable = es.filter((x) => x.group !== 'conflicts');
    const items: MenuItem[] = [{ label: t('commit.menu.diff'), onClick: () => openDiff(e) }];
    if (unstaged.length) items.push({ label: t('stage.menu.stage', { n: unstaged.length }), onClick: () => void cs.stage(unique(unstaged.map((x) => x.file.path))) });
    if (staged.length) items.push({ label: t('stage.menu.unstage', { n: staged.length }), onClick: () => toggle(staged) });
    if (conflicts.length) {
      items.push({ separator: true });
      items.push({ label: conflictSideLabel('ours', operation), onClick: () => void cs.resolveConflict(conflicts, 'ours') });
      items.push({ label: conflictSideLabel('theirs', operation), onClick: () => void cs.resolveConflict(conflicts, 'theirs') });
      items.push({ label: t('conflict.markResolved'), onClick: () => void cs.markResolved(conflicts) });
    }
    if (discardable.length) {
      items.push({ separator: true });
      items.push({ label: t('commit.menu.discard'), onClick: () => cs.confirmDiscard(discardable) });
      const stashPaths = unique(discardable.filter((x) => x.group !== 'untracked').map((x) => x.file.path));
      if (stashPaths.length) items.push({ label: t('stash.menu.selected'), onClick: () => cs.openStashSave(stashPaths) });
    }
    items.push({ separator: true });
    items.push({ label: t('commit.menu.editor'), onClick: () => cs.openInEditor(e.file.path), disabled: e.file.unstaged === 'deleted' || e.file.conflict === 'bothDeleted' });
    items.push({ label: IS_MAC ? t('commit.menu.reveal') : t('commit.menu.revealOther'), onClick: () => cs.revealInFinder(e.file.path) });
    if (!e.file.untracked) items.push({ label: t('commit.menu.history'), onClick: () => openHistory(e) });
    ctx.open(ev, items);
  };

  // ── render ──
  const groupLabel: Record<WorkingGroup, string> = {
    conflicts: t('conflict.group'), staged: t('stage.group.staged'), unstaged: t('stage.group.unstaged'), untracked: t('stage.group.untracked'),
  };

  const renderGroup = (g: WorkingGroup): ReactNode => {
    const list = byGroup.get(g)!;
    if (list.length === 0) return null;
    const open = !collapsed.has(g);
    const checked = g === 'staged';
    return (
      <div key={g} className={'lc-group lc-group-' + g}>
        <div className="lc-group-head">
          <button
            className="lc-chev"
            aria-expanded={open}
            aria-label={groupLabel[g]}
            onClick={() => setCollapsed((c) => { const x = new Set(c); if (x.has(g)) x.delete(g); else x.add(g); return x; })}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
          {g !== 'conflicts' && (
            <input
              type="checkbox"
              className="lc-check"
              checked={checked}
              title={checked ? t('stage.unstageAll') : t('stage.stageAll')}
              aria-label={checked ? t('stage.unstageAll') : t('stage.stageAll')}
              onChange={() => toggle(list)}
            />
          )}
          {g === 'conflicts' && <Icon name="warning" size={13} className="lc-warn" />}
          <span className="lc-group-label">{groupLabel[g]}</span>
          <span className="muted">{list.length}</span>
          <span className="grow" />
          {g === 'conflicts' && (
            <ConflictActions store={cs} paths={conflictPaths(selected).length ? conflictPaths(selected) : list.map((e) => e.file.path)} op={operation} />
          )}
        </div>
        {open && list.map((e) => renderEntry(e))}
      </div>
    );
  };

  const renderEntry = (e: WorkingEntry): ReactNode => {
    const name = baseName(e.file.path);
    const isSel = sel.has(e.key);
    return (
      <div
        key={e.key}
        data-key={e.key}
        className={'lc-row ' + (STATUS_CLASS[e.status] ?? '') + (isSel ? ' selected' : '') + (focus === e.key ? ' focused' : '')}
        role="option"
        aria-selected={isSel}
        title={e.file.oldPath && e.group === 'staged' ? `${e.file.oldPath} → ${e.file.path}` : e.file.path}
        onMouseDown={(ev) => { if (ev.button === 0 && !(ev.target as HTMLElement).closest('input')) click(ev, e); }}
        onDoubleClick={(ev) => { if (!(ev.target as HTMLElement).closest('input')) openDiff(e); }}
        onContextMenu={(ev) => menuFor(ev, e)}
      >
        {e.group === 'conflicts' ? (
          <span className="lc-check-spacer" />
        ) : (
          <input
            type="checkbox"
            className="lc-check"
            tabIndex={-1}
            checked={e.group === 'staged'}
            aria-label={e.group === 'staged' ? t('stage.unstageFile', { name }) : t('stage.stageFile', { name })}
            onChange={() => toggle(sel.has(e.key) ? selected.filter((x) => x.group === e.group) : [e])}
          />
        )}
        <FileIcon ext={fileExt(name)} />
        <span className="ct-name">{name}</span>
        {e.group === 'staged' && e.file.oldPath && <span className="muted lc-old">← {baseName(e.file.oldPath)}</span>}
        <span className="lc-dir muted">{dirName(e.file.path)}</span>
        <span className="grow" />
        {e.file.submodule && <span className="lc-tag">{t('stage.submodule')}</span>}
        {e.file.conflict ? (
          <span className="lc-tag lc-tag-conflict">{t(`conflict.kind.${e.file.conflict}`)}</span>
        ) : (
          <span className={'lc-letter ' + (STATUS_CLASS[e.status] ?? '')}>{STATUS_LETTER[e.status]}</span>
        )}
      </div>
    );
  };

  return (
    <div className="lc-top">
      <div className="pane-header">
        <span>{t('commit.title')}</span>
        <span className="muted">&nbsp;· {t('commit.files', { n: counts.total })}{status?.truncated ? '+' : ''}</span>
        <span className="grow" />
        {(loading || pending > 0) && <span className="spinner lc-spin" aria-label={t('common.loading')} />}
        <button className="icon-btn" title={t('stash.saveMenu')} aria-label={t('stash.saveMenu')} onClick={() => cs.openStashSave(null)} disabled={counts.total === 0}>
          <Icon name="download" size={14} />
        </button>
        <button className="icon-btn" title={t('commit.refresh')} aria-label={t('commit.refresh')} onClick={() => void cs.refreshStatus()}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {status?.truncated && <div className="lc-note">{t('commit.truncated')}</div>}
      <div
        ref={listRef}
        className="lc-list"
        tabIndex={0}
        role="listbox"
        aria-multiselectable
        aria-label={t('commit.title')}
        onKeyDown={onKey}
        onMouseDown={(ev) => { if (ev.target === ev.currentTarget) { setSel(new Set()); } }}
      >
        {statusError && <div className="empty-note err">{statusError.message}</div>}
        {!statusError && status && entries.length === 0 && <div className="empty-note">{t('commit.clean')}</div>}
        {!status && !statusError && <div className="empty-note">{t('common.loading')}</div>}
        {GROUP_ORDER.map(renderGroup)}
      </div>
      <StashSection />
      {ctx.menu && <ContextMenu menu={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}

function ConflictActions({ store, paths, op }: { store: CommitStore; paths: string[]; op: WorkingTreeStatus['operation'] }) {
  const stop = (ev: MouseEvent) => ev.stopPropagation();
  return (
    <span className="lc-conflict-actions" onMouseDown={stop}>
      <button className="btn small" title={conflictSideLabel('ours', op)} onClick={() => void store.resolveConflict(paths, 'ours')}>{conflictSideLabel('ours', op, true)}</button>
      <button className="btn small" title={conflictSideLabel('theirs', op)} onClick={() => void store.resolveConflict(paths, 'theirs')}>{conflictSideLabel('theirs', op, true)}</button>
      <button className="btn small" onClick={() => void store.markResolved(paths)}>{t('conflict.markResolvedShort')}</button>
    </span>
  );
}

// ───────────── stash ─────────────
function StashSection() {
  const cs = useRepoStore().commit;
  const stashes = useStoreState(cs, (s) => s.stashes);
  const loading = useStoreState(cs, (s) => s.stashLoading);
  const [open, setOpen] = useState(false);
  useEffect(() => { void cs.loadStashes(); }, [cs]);
  const n = stashes?.length ?? 0;
  return (
    <div className={'lc-stash' + (open ? ' open' : '')}>
      <div className="lc-group-head lc-stash-head">
        <button className="lc-chev" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        </button>
        <span className="lc-group-label" onClick={() => setOpen(!open)}>{t('stash.title')}</span>
        <span className="muted">{loading && stashes == null ? '…' : n}</span>
        <span className="grow" />
        <button className="btn small" onClick={() => cs.openStashSave(null)}>{t('stash.saveShort')}</button>
      </div>
      {open && (
        <div className="lc-stash-list">
          {n === 0 && <div className="lc-note muted">{t('stash.empty')}</div>}
          {stashes?.map((s) => <StashRow key={s.hash + s.index} s={s} store={cs} />)}
        </div>
      )}
    </div>
  );
}

function StashRow({ s, store }: { s: StashEntry; store: CommitStore }) {
  return (
    <div className="lc-stash-row" title={s.message}>
      <span className="lc-stash-ref">{`stash@{${s.index}}`}</span>
      <span className="lc-stash-msg">{s.message}</span>
      <span className="muted lc-stash-time">{formatCommitDate(s.time)}</span>
      <span className="lc-stash-btns">
        <button className="btn small" onClick={() => void store.applyStash(s, false)} title={t('stash.applyTip')}>{t('stash.apply')}</button>
        <button className="btn small" onClick={() => void store.applyStash(s, true)} title={t('stash.popTip')}>{t('stash.pop')}</button>
        <button className="btn small" onClick={() => store.confirmDropStash(s)}>{t('stash.drop')}</button>
      </span>
    </div>
  );
}

// ───────────── commit box ─────────────
const SUBJECT_SOFT_LIMIT = 72;

function CommitBox() {
  const cs = useRepoStore().commit;
  const status = useStoreState(cs, (s) => s.status);
  const message = useStoreState(cs, (s) => s.message);
  const amend = useStoreState(cs, (s) => s.amend);
  const signOff = useStoreState(cs, (s) => s.signOff);
  const committing = useStoreState(cs, (s) => s.committing);
  const counts = workingCounts(status);
  const subject = message.split('\n', 1)[0] ?? '';
  const unborn = status != null && status.headHash == null;
  const detached = status != null && status.headHash != null && status.branch == null;

  let blocker: string | null = null;
  if (counts.conflicts > 0) blocker = t('commit.block.conflicts');
  else if (!amend && counts.staged === 0) blocker = t('commit.block.nothingStaged');
  else if (!message.trim()) blocker = t('commit.block.noMessage');
  const canCommit = !committing && blocker == null && status != null;
  const canPush = canCommit && !detached;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && hasMod(e)) {
      e.preventDefault();
      if (e.altKey ? canPush : canCommit) void cs.commit(e.altKey);
    }
  };

  return (
    <div className="lc-commit">
      <div className="lc-commit-opts">
        <label className="lc-opt" title={unborn ? t('commit.amendUnborn') : t('commit.amendTip')}>
          <input type="checkbox" checked={amend} disabled={unborn || committing} onChange={(e) => void cs.setAmend(e.target.checked)} />
          {t('commit.amend')}
        </label>
        <label className="lc-opt" title={t('commit.signOffTip')}>
          <input type="checkbox" checked={signOff} disabled={committing} onChange={(e) => cs.setSignOff(e.target.checked)} />
          {t('commit.signOff')}
        </label>
        <span className="grow" />
        <span className={'lc-subj-len' + (subject.length > SUBJECT_SOFT_LIMIT ? ' over' : '')} title={t('commit.subjectTip', { n: SUBJECT_SOFT_LIMIT })}>
          {subject.length}
        </span>
      </div>
      <textarea
        className="lc-message"
        value={message}
        placeholder={amend ? t('commit.placeholderAmend') : t('commit.placeholder')}
        spellCheck={false}
        disabled={committing}
        aria-label={t('commit.messageLabel')}
        onChange={(e) => cs.setMessage(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="lc-commit-actions">
        <span className="lc-commit-target muted" title={blocker ?? undefined}>
          {blocker ?? (status?.branch
            ? t('commit.target', { branch: status.branch, n: counts.staged })
            : t('commit.targetDetached', { n: counts.staged }))}
        </span>
        <span className="grow" />
        <button
          className="btn"
          disabled={!canPush}
          title={detached ? t('commit.pushDetached') : t('commit.commitPushTip', { key: IS_MAC ? '⌥⌘↩' : 'Ctrl+Alt+Enter' })}
          onClick={() => void cs.commit(true)}
        >
          {t('commit.commitPush')}
        </button>
        <button
          className="btn primary"
          disabled={!canCommit}
          title={t('commit.commitTip', { key: IS_MAC ? '⌘↩' : 'Ctrl+Enter' })}
          onClick={() => void cs.commit(false)}
        >
          {committing ? t('commit.committingShort') : amend ? t('commit.amendCommit') : t('commit.commit')}
        </button>
      </div>
    </div>
  );
}
