import { useMemo, useState } from 'react';
import type { Ref } from '../../types';
import { ContextMenu, useContextMenu } from '../common/ContextMenu';
import { Icon } from '../common/Icons';
import { Tooltip } from '../common/Tooltip';
import { useRepo, useRepoStore } from '../state/repoContext';
import { colorOf, MUTED_LINE } from '../log/palette';
import { allGroupIds, buildBranchTree, flattenTree, type FlatRow } from './branchTree';
import { t } from '../../i18n';
import { branchMenuItems } from '../ops/menus';

const TAG_COLOR = '#F2B84B';
const sectionTip = (g: string): string | undefined => (g === 'local' ? t('branches.tipLocal') : g === 'remote' ? t('branches.tipRemote') : g === 'tags' ? t('branches.tipTags') : undefined);

export function BranchPanel() {
  const store = useRepoStore();
  const { checkoutRef, deleteBranch, fetchAll, jumpToCommitIndex, openDialog, pull, setScopeRefs, toggleFavorite } = store;
  const snapshot = useRepo((s) => s.snapshot);
  const scopeRefs = useRepo((s) => s.scopeRefs);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selId, setSelId] = useState<string | null>(null);
  const ctx = useContextMenu();

  const refs = snapshot?.refs.refs;
  const tree = useMemo(() => buildBranchTree(refs ?? [], query), [refs, query]);
  const layout = useRepo((s) => s.layout);
  // With a single remote its folder row is folded into the section title ("REMOTE · ORIGIN").
  const soloRemote = useMemo(() => {
    const rg = tree.find((n) => n.kind === 'group' && n.id === 'remote');
    return rg && rg.kind === 'group' && rg.children.length === 1 && rg.children[0].kind === 'group' ? rg.children[0] : null;
  }, [tree]);
  const rows = useMemo(() => {
    const col = soloRemote ? new Set([...collapsed].filter((x) => x !== soloRemote.id)) : collapsed;
    const flat = flattenTree(tree, col, query.trim() !== '');
    if (!soloRemote) return flat;
    const out: FlatRow[] = [];
    let skip = -1;
    for (const r of flat) {
      if (r.node.id === soloRemote.id) { skip = r.depth; continue; }
      if (skip >= 0 && r.depth <= skip) skip = -1;
      out.push(skip >= 0 ? { ...r, depth: r.depth - 1 } : r);
    }
    return out;
  }, [tree, collapsed, query, soloRemote]);
  /** Line colour per ref, taken from the graph so sidebar and graph always agree. */
  const lineColor = (r: Ref): string => {
    if (r.type === 'tag') return TAG_COLOR;
    if (!layout || r.index == null) return MUTED_LINE;
    const row = layout.rowOf(r.index);
    return row < 0 ? MUTED_LINE : colorOf(layout.getRow(row).nodeColor);
  };
  const selectedRef: Ref | null = useMemo(() => {
    const r = rows.find((x) => x.node.id === selId)?.node;
    return r && r.kind === 'ref' ? r.ref : null;
  }, [rows, selId]);

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const openMenu = (e: React.MouseEvent, ref: Ref) => {
    setSelId('ref:' + ref.fullName);
    const isHead = ref.type === 'head';
    ctx.open(e, [
      { label: t('common.checkout'), disabled: isHead || ref.isCurrent, onClick: () => checkoutRef(ref) },
      { label: t('branches.newFrom', { name: ref.name }), onClick: () => openDialog({ kind: 'createBranch', startPoint: isHead ? 'HEAD' : ref.name, startLabel: ref.name }) },
      { separator: true },
      { label: t('branches.filterLog'), disabled: isHead, onClick: () => setScopeRefs([ref.fullName]) },
      { label: ref.isFavorite ? t('branches.unfavorite') : t('branches.favorite'), disabled: isHead || ref.type === 'tag', onClick: () => void toggleFavorite(ref) },
      { separator: true },
      { label: t('common.delete'), disabled: ref.type !== 'localBranch' || ref.isCurrent, onClick: () => deleteBranch(ref.name) },
      ...((extra) => (extra.length ? [{ separator: true } as const, ...extra] : []))(branchMenuItems(ref, store)),
    ]);
  };

  const favDisabled = !selectedRef || selectedRef.type === 'head' || selectedRef.type === 'tag';
  const favLabel = favDisabled
    ? t('branches.favHint')
    : selectedRef.isFavorite ? t('branches.favRemove', { name: selectedRef.name }) : t('branches.favAdd', { name: selectedRef.name });
  const newBranchFrom = selectedRef && selectedRef.type !== 'head' ? selectedRef.name : 'HEAD';

  const tools = (
    <div className="branch-tools" role="toolbar" aria-orientation="vertical" aria-label={t('branches.toolsAria')}>
      <Tooltip side="right" label={t('branches.newBranchFrom', { name: newBranchFrom })}>
        <button className="icon-btn" onClick={() => openDialog({ kind: 'createBranch', startPoint: newBranchFrom, startLabel: newBranchFrom })}>
          <Icon name="plus" size={15} />
        </button>
      </Tooltip>
      <Tooltip side="right" label={t('branches.fetchAll')}>
        <button className="icon-btn" onClick={() => void fetchAll()}><Icon name="download" size={15} /></button>
      </Tooltip>
      <Tooltip side="right" label={t('branches.pull')}>
        <button className="icon-btn" onClick={() => void pull('ffOnly')}><Icon name="pull" size={15} /></button>
      </Tooltip>
      <Tooltip side="right" label={favLabel}>
        <button
          className="icon-btn"
          aria-disabled={favDisabled}
          onClick={() => { if (!favDisabled && selectedRef) void toggleFavorite(selectedRef); }}
        >
          <Icon name={selectedRef?.isFavorite ? 'star' : 'starOutline'} size={15} />
        </button>
      </Tooltip>
      <div className="tools-sep" />
      <Tooltip side="right" label={t('branches.collapseAll')}>
        <button className="icon-btn" onClick={() => setCollapsed(new Set(allGroupIds(tree)))}><Icon name="collapse" size={15} /></button>
      </Tooltip>
      <Tooltip side="right" label={t('branches.expandAll')}>
        <button className="icon-btn" onClick={() => setCollapsed(new Set())}><Icon name="expand" size={15} /></button>
      </Tooltip>
    </div>
  );

  return (
    <div className="branch-panel">
      {tools}
      <div className="branch-main">
        <div className="branch-search">
          <Icon name="search" size={13} />
          <input value={query} placeholder={t('branches.searchPh')} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
          {query && <Tooltip side="bottom" label={t('branches.clearSearch')}><button className="icon-btn" onClick={() => setQuery('')}><Icon name="close" size={10} /></button></Tooltip>}
        </div>
        <div className="branch-tree" role="tree">
          {rows.map(({ node, depth, expanded }) => {
            const pad = 8 + depth * 14;
            if (node.kind === 'group') {
              const top = node.group === 'local' || node.group === 'remote' || node.group === 'tags';
              const title = node.group === 'local' ? 'LINES' : node.group === 'tags' ? 'TAGS'
                : node.group === 'remote' ? (soloRemote ? `REMOTE · ${soloRemote.label.toUpperCase()}` : 'REMOTE') : node.label;
              return (
                <div
                  key={node.id}
                  className={'bt-row group' + (top ? ' section' : '')}
                  style={{ paddingLeft: top ? 10 : pad }}
                  role="treeitem"
                  aria-expanded={expanded}
                  title={sectionTip(node.group)}
                  onClick={() => toggle(node.id)}
                >
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} />
                  <span className="bt-label">{title}</span>
                </div>
              );
            }
            const r = node.ref;
            const inScope = scopeRefs?.includes(r.fullName);
            return (
              <div
                key={node.id}
                className={'bt-row ref' + (selId === node.id ? ' selected' : '') + (r.isCurrent ? ' current' : '') + (inScope ? ' in-scope' : '')}
                style={{ paddingLeft: node.kind === 'ref' && depth === 0 ? 12 : pad + 4 }}
                role="treeitem"
                onClick={() => { setSelId(node.id); jumpToCommitIndex(r.index); }}
                onDoubleClick={() => { if (r.type !== 'head') setScopeRefs(inScope ? null : [r.fullName]); }}
                onContextMenu={(e) => openMenu(e, r)}
                title={r.fullName}
              >
                <span className={'line-bar' + (r.type === 'tag' ? ' tag' : '')} style={{ background: lineColor(r) }} aria-hidden="true" />
                <span className="bt-label">{node.label}</span>
                {r.isFavorite && <Icon name="star" size={10} className="fav" />}
                {r.isCurrent && r.type !== 'head' && <span className="bt-head" title={t('branches.currentTip')}>HEAD</span>}
                {(r.ahead || r.behind) ? (
                  <span className="bt-track" title={t('branches.track', { ahead: r.ahead ?? 0, behind: r.behind ?? 0 })}>{r.ahead ? `↑${r.ahead}` : ''}{r.ahead && r.behind ? ' ' : ''}{r.behind ? `↓${r.behind}` : ''}</span>
                ) : null}
              </div>
            );
          })}
          {rows.length === 0 && <div className="pop-empty">{snapshot ? t('branches.noMatch') : ''}</div>}
        </div>
      </div>
      {ctx.menu && <ContextMenu menu={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}
