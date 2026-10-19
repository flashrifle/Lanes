import { describe, expect, it } from 'vitest';
import { REV_INDEX, REV_WORKTREE, type ChangedFile } from '../types';
import { makeDiff } from '../ui/commit/patchTestUtil';
import { buildDiffModel } from './align';
import { blockKeys, coverage, revLabel, setKeys, stagingCaps } from './staging';

const cf = (p: Partial<ChangedFile>): ChangedFile => ({
  path: 'f.txt', oldPath: null, status: 'modified', additions: null, deletions: null, binary: false, fromHash: REV_INDEX, toHash: REV_WORKTREE, ...p,
});

describe('diff window staging', () => {
  const diff = makeDiff('f.txt', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'a\nB\nc\nd\ne\nf\ng\nh\nI\nj\nk\n', 1_000_000);
  const model = buildDiffModel(diff);

  it('model lines carry h:l keys and blocks collect them', () => {
    expect(model.blocks).toHaveLength(3);
    expect(blockKeys(model)).toEqual([['0:1', '0:2'], ['0:9', '0:10'], ['0:12']]);
    expect(model.uni.filter((r) => r.kind === 'equal').every((r) => r.kind === 'equal' && r.line.key === null)).toBe(true);
  });

  it('set helpers', () => {
    const s = setKeys(new Set(['0:1']), ['0:9', '0:10'], true);
    expect(coverage(s, ['0:9', '0:10'])).toBe('all');
    expect(coverage(s, ['0:1', '0:2'])).toBe('some');
    expect(coverage(setKeys(s, ['0:1'], false), ['0:1', '0:2'])).toBe('none');
  });

  it('caps per side', () => {
    expect(stagingCaps(cf({}), diff)).toEqual({ side: 'unstaged', lineModes: ['stage', 'discard'] });
    expect(stagingCaps(cf({ fromHash: 'h', toHash: REV_INDEX }), diff)).toEqual({ side: 'staged', lineModes: ['unstage'] });
    expect(stagingCaps(cf({ status: 'added', fromHash: 'h', toHash: REV_INDEX }), diff)).toEqual({ side: 'staged', lineModes: [] });
    expect(stagingCaps(cf({ status: 'added', fromHash: null }), diff)).toEqual({ side: 'untracked', lineModes: [] });
    expect(stagingCaps(cf({ status: 'unmerged', fromHash: 'h' }), diff)).toEqual({ side: 'conflict', lineModes: [] });
    expect(stagingCaps(cf({}), null)).toEqual({ side: 'unstaged', lineModes: [] });
    expect(stagingCaps(cf({ fromHash: 'a', toHash: 'b' }), diff)).toBeNull();
  });

  it('header labels for sentinels', () => {
    const names = { index: 'Index', worktree: 'Working tree' };
    expect(revLabel(REV_INDEX, names)).toBe('Index');
    expect(revLabel(REV_WORKTREE, names)).toBe('Working tree');
    expect(revLabel('0123456789abcdef', names)).toBe('01234567');
    expect(revLabel(null, names)).toBeNull();
  });
});
