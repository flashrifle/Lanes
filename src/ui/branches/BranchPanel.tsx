import { useMemo, useState } from 'react';
import type { Ref } from '../../types';
import { ContextMenu, useContextMenu } from '../common/ContextMenu';
import { Icon } from '../common/Icons';
import {
  checkoutRef, deleteBranch, fetchAll, jumpToCommitIndex, openDialog, pull, setScopeRefs, toggleFavorite, useStore,
} from '../state/store';
import { allGroupIds, buildBranchTree, flattenTree } from './branchTree';

export function BranchPanel() {
  const snapshot = useStore((s) => s.snapshot);
  const scopeRefs = useStore((s) => s.scopeRefs);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selId, setSelId] = useState<string | null>(null);
  const ctx = useContextMenu();

  const refs = snapshot?.refs.refs;
  const tree = useMemo(() => buildBranchTree(refs ?? [], query), [refs, query]);
  const rows = useMemo(() => flattenTree(tree, collapsed, query.trim() !== ''), [tree, collapsed, query]);
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
      { label: '체크아웃', disabled: isHead || ref.isCurrent, onClick: () => checkoutRef(ref) },
      { label: `'${ref.name}'에서 새 브랜치…`, onClick: () => openDialog({ kind: 'createBranch', startPoint: isHead ? 'HEAD' : ref.name, startLabel: ref.name }) },
      { separator: true },
      { label: '이 브랜치로 로그 필터', disabled: isHead, onClick: () => setScopeRefs([ref.fullName]) },
      { label: ref.isFavorite ? '즐겨찾기 해제' : '즐겨찾기에 추가', disabled: isHead || ref.type === 'tag', onClick: () => void toggleFavorite(ref) },
      { separator: true },
      { label: '삭제', disabled: ref.type !== 'localBranch' || ref.isCurrent, onClick: () => deleteBranch(ref.name) },
    ]);
  };

  const tools = (
    <div className="branch-tools">
      <button className="icon-btn" title="새 브랜치" onClick={() => openDialog({ kind: 'createBranch', startPoint: selectedRef && selectedRef.type !== 'head' ? selectedRef.name : 'HEAD', startLabel: selectedRef?.name ?? 'HEAD' })}>
        <Icon name="plus" size={15} />
      </button>
      <button className="icon-btn" title="모두 가져오기 (Fetch)" onClick={() => void fetchAll()}><Icon name="download" size={15} /></button>
      <button className="icon-btn" title="풀 (Pull)" onClick={() => void pull('ffOnly')}><Icon name="pull" size={15} /></button>
      <button
        className="icon-btn"
        title="즐겨찾기 토글"
        disabled={!selectedRef || selectedRef.type === 'head' || selectedRef.type === 'tag'}
        onClick={() => selectedRef && void toggleFavorite(selectedRef)}
      >
        <Icon name={selectedRef?.isFavorite ? 'star' : 'starOutline'} size={15} />
      </button>
      <div className="tools-sep" />
      <button className="icon-btn" title="모두 접기" onClick={() => setCollapsed(new Set(allGroupIds(tree)))}><Icon name="collapse" size={15} /></button>
      <button className="icon-btn" title="모두 펼치기" onClick={() => setCollapsed(new Set())}><Icon name="expand" size={15} /></button>
    </div>
  );

  return (
    <div className="branch-panel">
      {tools}
      <div className="branch-main">
        <div className="branch-search">
          <Icon name="search" size={13} />
          <input value={query} placeholder="브랜치 또는 태그" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
          {query && <button className="icon-btn" onClick={() => setQuery('')}><Icon name="close" size={10} /></button>}
        </div>
        <div className="branch-tree" role="tree">
          {rows.map(({ node, depth, expanded }) => {
            const pad = 8 + depth * 14;
            if (node.kind === 'group') {
              return (
                <div key={node.id} className="bt-row group" style={{ paddingLeft: pad }} role="treeitem" onClick={() => toggle(node.id)}>
                  <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
                  {node.group === 'tags' ? <Icon name="tag" size={13} /> : <Icon name="folder" size={13} />}
                  <span className="bt-label">{node.label}</span>
                </div>
              );
            }
            const r = node.ref;
            const inScope = scopeRefs?.includes(r.fullName);
            return (
              <div
                key={node.id}
                className={'bt-row ref' + (selId === node.id ? ' selected' : '') + (r.isCurrent ? ' current' : '') + (inScope ? ' in-scope' : '')}
                style={{ paddingLeft: pad + 14 }}
                role="treeitem"
                onClick={() => { setSelId(node.id); jumpToCommitIndex(r.index); }}
                onDoubleClick={() => { if (r.type !== 'head') setScopeRefs(inScope ? null : [r.fullName]); }}
                onContextMenu={(e) => openMenu(e, r)}
                title={r.fullName}
              >
                <Icon name={r.type === 'head' ? 'head' : r.type === 'tag' ? 'tag' : 'branch'} size={13} />
                <span className="bt-label">{node.label}</span>
                {r.isFavorite && <Icon name="star" size={10} className="fav" />}
                {(r.ahead || r.behind) ? (
                  <span className="bt-track">{r.behind ? `↓${r.behind}` : ''}{r.ahead ? `↑${r.ahead}` : ''}</span>
                ) : null}
              </div>
            );
          })}
          {rows.length === 0 && <div className="pop-empty">{snapshot ? '일치하는 항목이 없습니다' : ''}</div>}
        </div>
      </div>
      {ctx.menu && <ContextMenu menu={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}
