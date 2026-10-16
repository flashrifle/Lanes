import { describe, expect, it } from 'vitest';
import type { BranchTreeNode, Ref, RefType } from '../../types';
import { allGroupIds, buildBranchTree, flattenTree } from './branchTree';

function ref(type: RefType, name: string, extra: Partial<Ref> = {}): Ref {
  const prefix = { head: '', localBranch: 'refs/heads/', remoteBranch: 'refs/remotes/', tag: 'refs/tags/' }[type];
  return {
    name, fullName: type === 'head' ? 'HEAD' : prefix + name, type, hash: 'a'.repeat(40), index: 0,
    remote: type === 'remoteBranch' ? name.split('/')[0] : null, upstream: null, ahead: null, behind: null,
    upstreamGone: false, isCurrent: false, isFavorite: false, ...extra,
  };
}
const labels = (n: BranchTreeNode[]) => n.map((x) => x.label);

describe('buildBranchTree', () => {
  const refs = [
    ref('head', 'HEAD', { isCurrent: true }),
    ref('localBranch', 'main', { isCurrent: true, isFavorite: true }),
    ref('localBranch', 'feature/a'),
    ref('localBranch', 'feature/b'),
    ref('localBranch', 'zeta'),
    ref('localBranch', 'alpha', { isFavorite: true }),
    ref('remoteBranch', 'origin/main'),
    ref('remoteBranch', 'origin/fix/login'),
    ref('tag', 'v1.0'),
  ];
  it('top-level order', () => {
    expect(labels(buildBranchTree(refs))).toEqual(['HEAD(현재 브랜치)', '로컬', '리모트', '태그']);
  });
  it('favorites first, then folders, then refs', () => {
    const local = buildBranchTree(refs)[1];
    if (local.kind !== 'group') throw new Error();
    expect(labels(local.children)).toEqual(['alpha', 'main', 'feature', 'zeta']);
  });
  it('remote -> origin -> folders', () => {
    const remote = buildBranchTree(refs)[2];
    if (remote.kind !== 'group') throw new Error();
    expect(labels(remote.children)).toEqual(['origin']);
    const origin = remote.children[0];
    if (origin.kind !== 'group') throw new Error();
    expect(labels(origin.children)).toEqual(['fix', 'main']);
    const fix = origin.children[0];
    if (fix.kind !== 'group') throw new Error();
    expect(fix.id).toBe('remote/origin/fix');
    expect(labels(fix.children)).toEqual(['login']);
    expect(fix.children[0].id).toBe('ref:refs/remotes/origin/fix/login');
  });
  it('omits empty groups and filters by query', () => {
    const t = buildBranchTree(refs, 'LOGIN');
    expect(labels(t)).toEqual(['리모트']);
  });
  it('flatten respects collapsed and forceExpand', () => {
    const t = buildBranchTree(refs);
    const open = flattenTree(t, new Set());
    const closed = flattenTree(t, new Set(['local']));
    expect(open.length).toBeGreaterThan(closed.length);
    expect(flattenTree(t, new Set(['local']), true).length).toBe(open.length);
    expect(open.find((r) => r.node.label === 'login')?.depth).toBe(3);
    expect(allGroupIds(t)).toContain('remote/origin/fix');
  });
});
