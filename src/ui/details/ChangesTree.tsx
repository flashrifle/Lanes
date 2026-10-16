import { useEffect, useMemo, useState } from 'react';
import { call, toAppError } from '../../api';
import type { ChangedFile, ChangesResult } from '../../types';
import { FileIcon, Icon } from '../common/Icons';
import { selectedInRowOrder } from '../state/logic';
import { useRepo, useRepoStore } from '../state/repoContext';
import { rowMapOf } from '../state/repoStore';
import { buildFileTree, fileExt, type FileTreeNode } from './fileTree';
import { openDiffWindow } from '../../diffwindow/session';
import { t } from '../../i18n';

const STATUS_CLASS: Record<ChangedFile['status'], string> = {
  added: 'st-added', modified: 'st-modified', deleted: 'st-deleted', renamed: 'st-renamed', copied: 'st-added',
  typeChanged: 'st-modified', unmerged: 'st-deleted', unknown: '',
};

/** Selecting more commits than this (e.g. Cmd+A on a huge log) is not sent to the backend. */
export const MAX_CHANGES_COMMITS = 500;

export function ChangesTree() {
  const store = useRepoStore();
  const repo = useRepo((s) => s.repo);
  const snapshot = useRepo((s) => s.snapshot);
  const layout = useRepo((s) => s.layout);
  const selection = useRepo((s) => s.selection);
  const [result, setResult] = useState<ChangesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selPath, setSelPath] = useState<string | null>(null);

  const tooMany = selection.set.size > MAX_CHANGES_COMMITS;
  const hashes = useMemo(() => {
    if (!snapshot || tooMany) return [] as string[];
    return selectedInRowOrder(selection, rowMapOf(layout)).map((i) => snapshot.hashes[i]);
  }, [snapshot, layout, selection, tooMany]);
  const key = useMemo(() => hashes.join(','), [hashes]);

  // Opens (or reuses) the separate side-by-side diff window, with the whole change list for ←/→ navigation.
  const openDiff = (f: ChangedFile) => {
    if (!repo || !result) return;
    const files = result.files;
    const title = hashes.length === 1 ? hashes[0].slice(0, 8) : t('changes.commitsTitle', { n: hashes.length });
    openDiffWindow({ repoPath: repo.path, repoName: repo.name, files, index: Math.max(0, files.indexOf(f)), title })
      .catch((e) => store.showToast('error', t('changes.diffOpenFail', { msg: toAppError(e).message })));
  };

  useEffect(() => {
    if (!repo || hashes.length === 0) { setResult(null); setError(null); setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(() => {
      call('get_changed_files', { repoPath: repo.path, hashes })
        .then((r) => { if (!cancelled) { setResult(r); setError(null); setSelPath(null); } })
        .catch((e) => { if (!cancelled) { setError(toAppError(e).message); setResult(null); } })
        .finally(() => { if (!cancelled) setBusy(false); });
    }, 80);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, key]);

  const tree = useMemo(() => buildFileTree(result?.files ?? []), [result]);
  const count = result?.files.length ?? 0;

  const renderNode = (n: FileTreeNode, depth: number): React.ReactNode => {
    const pad = 6 + depth * 14;
    if (n.kind === 'dir') {
      const open = !collapsed.has(n.id);
      return (
        <div key={n.id}>
          <div
            className="ct-row dir"
            style={{ paddingLeft: pad }}
            onClick={() => setCollapsed((c) => { const x = new Set(c); if (x.has(n.id)) x.delete(n.id); else x.add(n.id); return x; })}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
            <Icon name="folder" size={13} />
            <span className="ct-name">{n.name}</span>
            <span className="muted ct-count">{t('changes.files', { n: n.fileCount })}</span>
          </div>
          {open && n.children.map((c) => renderNode(c, depth + 1))}
        </div>
      );
    }
    const f = n.file;
    return (
      <div
        key={n.id}
        className={'ct-row file ' + STATUS_CLASS[f.status] + (selPath === f.path ? ' selected' : '')}
        style={{ paddingLeft: pad + 14 }}
        tabIndex={0}
        title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
        onClick={() => setSelPath(f.path)}
        onDoubleClick={() => openDiff(f)}
        onKeyDown={(e) => { if (e.key === 'Enter') openDiff(f); }}
      >
        <FileIcon ext={fileExt(n.name)} />
        <span className="ct-name">{n.name}</span>
        {f.oldPath && <span className="muted ct-old">← {f.oldPath.split('/').pop()}</span>}
        {!f.binary && (f.additions || f.deletions) ? (
          <span className="ct-stat"><span className="add">+{f.additions ?? 0}</span> <span className="del">-{f.deletions ?? 0}</span></span>
        ) : null}
      </div>
    );
  };

  return (
    <div className="changes">
      <div className="pane-header">
        <span>{hashes.length === 0 ? t('changes.heading') : t('changes.files', { n: count })}</span>
        {result?.isMerge && <span className="muted">{t('changes.mergeNote')}</span>}
        {result && result.mode !== 'single' && <span className="muted"> · {result.mode === 'range' ? t('changes.range') : t('changes.union')}</span>}
        {busy && <span className="muted"> …</span>}
      </div>
      <div className="changes-body">
        {tooMany && <div className="empty-note">{t('changes.tooMany', { n: selection.set.size })}</div>}
        {!tooMany && hashes.length === 0 && <div className="empty-note">{t('changes.selectCommit')}</div>}
        {error && <div className="empty-note err">{error}</div>}
        {result && count === 0 && <div className="empty-note">{t('changes.noFiles')}</div>}
        {tree.map((n) => renderNode(n, 0))}
      </div>
    </div>
  );
}
