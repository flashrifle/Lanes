import type { BranchTreeNode, Ref } from '../../types';

type Group = Extract<BranchTreeNode, { kind: 'group' }>;

function sortLevel(children: BranchTreeNode[]): BranchTreeNode[] {
  const fav = (n: BranchTreeNode) => n.kind === 'ref' && n.ref.isFavorite;
  const rank = (n: BranchTreeNode) => (fav(n) ? 0 : n.kind === 'group' ? 1 : 2);
  return [...children].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** Insert refs into nested folder groups split by "/". */
function addPath(root: Group, rootId: string, segments: string[], ref: Ref): void {
  let parent = root;
  let id = rootId;
  for (let i = 0; i < segments.length - 1; i++) {
    id += '/' + segments[i];
    let next = parent.children.find((c): c is Group => c.kind === 'group' && c.id === id);
    if (!next) {
      next = { kind: 'group', id, label: segments[i], group: 'folder', children: [] };
      parent.children.push(next);
    }
    parent = next;
  }
  parent.children.push({ kind: 'ref', id: 'ref:' + ref.fullName, label: segments[segments.length - 1], ref });
}

function sortDeep(g: Group): void {
  g.children = sortLevel(g.children);
  for (const c of g.children) if (c.kind === 'group') sortDeep(c);
}

export const HEAD_LABEL = 'HEAD(현재 브랜치)';

/**
 * HEAD / 로컬 / 리모트 > remote > folders / 태그. Empty groups are omitted.
 * `query` filters by case-insensitive substring of the short ref name.
 */
export function buildBranchTree(refs: Ref[], query = ''): BranchTreeNode[] {
  const q = query.trim().toLowerCase();
  const match = (r: Ref) => !q || r.name.toLowerCase().includes(q);
  const out: BranchTreeNode[] = [];

  const head = refs.find((r) => r.type === 'head');
  if (head && match({ ...head, name: HEAD_LABEL }) ) {
    out.push({ kind: 'ref', id: 'ref:' + head.fullName, label: HEAD_LABEL, ref: head });
  }

  const local: Group = { kind: 'group', id: 'local', label: '로컬', group: 'local', children: [] };
  for (const r of refs) if (r.type === 'localBranch' && match(r)) addPath(local, 'local', r.name.split('/'), r);

  const remote: Group = { kind: 'group', id: 'remote', label: '리모트', group: 'remote', children: [] };
  for (const r of refs) {
    if (r.type !== 'remoteBranch' || !match(r)) continue;
    const remoteName = r.remote ?? r.name.split('/')[0];
    const rest = r.name.startsWith(remoteName + '/') ? r.name.slice(remoteName.length + 1) : r.name;
    const rid = 'remote/' + remoteName;
    let rg = remote.children.find((c): c is Group => c.kind === 'group' && c.id === rid);
    if (!rg) {
      rg = { kind: 'group', id: rid, label: remoteName, group: 'remoteName', children: [] };
      remote.children.push(rg);
    }
    addPath(rg, rid, rest.split('/'), r);
  }

  const tags: Group = { kind: 'group', id: 'tags', label: '태그', group: 'tags', children: [] };
  for (const r of refs) if (r.type === 'tag' && match(r)) addPath(tags, 'tags', r.name.split('/'), r);

  for (const g of [local, remote, tags]) {
    if (g.children.length === 0) continue;
    sortDeep(g);
    out.push(g);
  }
  return out;
}

export interface FlatRow {
  node: BranchTreeNode;
  depth: number;
  expanded: boolean; // meaningful for groups
}

/** Flatten for rendering. `forceExpand` (active search) ignores `collapsed`. */
export function flattenTree(nodes: BranchTreeNode[], collapsed: ReadonlySet<string>, forceExpand = false): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (list: BranchTreeNode[], depth: number) => {
    for (const n of list) {
      if (n.kind === 'ref') {
        rows.push({ node: n, depth, expanded: false });
      } else {
        const expanded = forceExpand || !collapsed.has(n.id);
        rows.push({ node: n, depth, expanded });
        if (expanded) walk(n.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return rows;
}

export function allGroupIds(nodes: BranchTreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: BranchTreeNode[]) => {
    for (const n of list) if (n.kind === 'group') { ids.push(n.id); walk(n.children); }
  };
  walk(nodes);
  return ids;
}
