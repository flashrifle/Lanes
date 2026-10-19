import { describe, expect, it } from 'vitest';
import { REV_INDEX, REV_WORKTREE, type StatusFile, type WorkingTreeStatus } from '../../types';
import { discardRequestOf, isWorkingRev, workingCounts, workingEntries, workingSideOf } from './workingFiles';

const sf = (p: Partial<StatusFile> & { path: string }): StatusFile => ({
  oldPath: null, staged: null, unstaged: null, untracked: false, conflict: null, submodule: false, ...p,
});
const status = (files: StatusFile[], headHash: string | null = 'h'.repeat(40)): WorkingTreeStatus => ({
  headHash, branch: 'main', upstream: null, ahead: null, behind: null, files, truncated: false, operation: null,
});

describe('workingEntries', () => {
  const st = status([
    sf({ path: 'b.txt', staged: 'modified', unstaged: 'modified' }),
    sf({ path: 'a.txt', unstaged: 'deleted' }),
    sf({ path: 'new.txt', oldPath: 'old.txt', staged: 'renamed' }),
    sf({ path: 'u.txt', untracked: true }),
    sf({ path: 'c.txt', conflict: 'bothModified' }),
    sf({ path: 'add.txt', staged: 'added' }),
  ]);
  const es = workingEntries(st);

  it('groups conflicts, staged, unstaged, untracked; paths sorted inside groups', () => {
    expect(es.map((e) => e.key)).toEqual([
      'conflicts:c.txt', 'staged:add.txt', 'staged:b.txt', 'staged:new.txt', 'unstaged:a.txt', 'unstaged:b.txt', 'untracked:u.txt',
    ]);
  });

  it('maps staged rows to (HEAD, INDEX) keeping the rename', () => {
    const e = es.find((x) => x.key === 'staged:new.txt')!;
    expect(e.change).toEqual({ path: 'new.txt', oldPath: 'old.txt', status: 'renamed', additions: null, deletions: null, binary: false, fromHash: 'h'.repeat(40), toHash: REV_INDEX });
  });

  it('maps unstaged rows to (INDEX, WORKTREE) without oldPath', () => {
    const e = es.find((x) => x.key === 'unstaged:b.txt')!;
    expect(e.change).toMatchObject({ path: 'b.txt', oldPath: null, status: 'modified', fromHash: REV_INDEX, toHash: REV_WORKTREE });
    expect(es.find((x) => x.key === 'unstaged:a.txt')!.change.status).toBe('deleted');
  });

  it('maps untracked to (null, WORKTREE) added and conflicts to (HEAD, WORKTREE) unmerged', () => {
    expect(es.find((x) => x.group === 'untracked')!.change).toMatchObject({ status: 'added', fromHash: null, toHash: REV_WORKTREE });
    expect(es.find((x) => x.group === 'conflicts')!.change).toMatchObject({ status: 'unmerged', fromHash: 'h'.repeat(40), toHash: REV_WORKTREE });
  });

  it('unborn HEAD diffs staged files against the empty tree', () => {
    const e = workingEntries(status([sf({ path: 'x', staged: 'added' })], null))[0];
    expect(e.change).toMatchObject({ fromHash: null, toHash: REV_INDEX, status: 'added' });
  });

  it('null status → []', () => expect(workingEntries(null)).toEqual([]));

  it('counts', () => {
    expect(workingCounts(st)).toEqual({ total: 6, staged: 3, unstaged: 2, untracked: 1, conflicts: 1 });
    expect(workingCounts(null).total).toBe(0);
  });

  it('workingSideOf round-trips every group', () => {
    const sides = es.map((e) => [e.group, workingSideOf(e.change)]);
    expect(sides).toEqual([
      ['conflicts', 'conflict'], ['staged', 'staged'], ['staged', 'staged'], ['staged', 'staged'],
      ['unstaged', 'unstaged'], ['unstaged', 'unstaged'], ['untracked', 'untracked'],
    ]);
    expect(workingSideOf({ fromHash: 'a', toHash: 'b', status: 'modified' })).toBeNull();
    expect(isWorkingRev(REV_INDEX) && isWorkingRev(REV_WORKTREE) && !isWorkingRev('abc') && !isWorkingRev(null)).toBe(true);
  });

  it('discardRequestOf splits tracked / untracked and flags staged rows', () => {
    expect(discardRequestOf(es.filter((e) => e.group === 'unstaged'))).toEqual({ paths: ['a.txt', 'b.txt'], untrackedPaths: [], includeStaged: false });
    expect(discardRequestOf(es.filter((e) => e.key === 'staged:new.txt' || e.group === 'untracked' || e.group === 'conflicts')))
      .toEqual({ paths: ['new.txt', 'old.txt'], untrackedPaths: ['u.txt'], includeStaged: true });
  });
});
