import { describe, expect, it } from 'vitest';
import type { Ref, RefType } from '../../types';
import { buildRefLabels, refsByIndex } from './refLabels';

function ref(type: RefType, name: string, extra: Partial<Ref> = {}): Ref {
  const prefix = { head: '', localBranch: 'refs/heads/', remoteBranch: 'refs/remotes/', tag: 'refs/tags/' }[type];
  return {
    name, fullName: type === 'head' ? 'HEAD' : prefix + name, type, hash: 'h', index: 3,
    remote: type === 'remoteBranch' ? name.split('/')[0] : null, upstream: null, ahead: null, behind: null,
    upstreamGone: false, isCurrent: false, isFavorite: false, ...extra,
  };
}

describe('buildRefLabels', () => {
  it('merges local with upstream at same commit', () => {
    const l = buildRefLabels([
      ref('remoteBranch', 'origin/main'),
      ref('localBranch', 'main', { upstream: 'refs/remotes/origin/main' }),
    ]);
    expect(l).toHaveLength(1);
    expect(l[0].text).toBe('origin & main');
    expect(l[0].fullNames).toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
  });
  it('keeps differing names explicit', () => {
    const l = buildRefLabels([
      ref('remoteBranch', 'origin/dev'),
      ref('localBranch', 'work', { upstream: 'refs/remotes/origin/dev' }),
    ]);
    expect(l[0].text).toBe('origin/dev & work');
  });
  it('drops HEAD when a current branch is here, keeps it when detached', () => {
    expect(buildRefLabels([ref('head', 'HEAD', { isCurrent: true }), ref('localBranch', 'main', { isCurrent: true })]).map((x) => x.text)).toEqual(['main']);
    expect(buildRefLabels([ref('head', 'HEAD', { isCurrent: true })]).map((x) => x.text)).toEqual(['HEAD']);
  });
  it('orders current, favorites, local, remote, tags', () => {
    const l = buildRefLabels([
      ref('tag', 'v1'),
      ref('remoteBranch', 'origin/x'),
      ref('localBranch', 'b'),
      ref('localBranch', 'fav', { isFavorite: true }),
      ref('localBranch', 'cur', { isCurrent: true }),
    ]);
    expect(l.map((x) => x.text)).toEqual(['cur', 'fav', 'b', 'origin/x', 'v1']);
  });
  it('refsByIndex groups and skips unloaded', () => {
    const m = refsByIndex([ref('tag', 'a', { index: 1 }), ref('tag', 'b', { index: 1 }), ref('tag', 'c', { index: null })]);
    expect(m.size).toBe(1);
    expect(m.get(1)).toHaveLength(2);
  });
});
