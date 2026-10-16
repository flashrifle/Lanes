import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogSnapshot, RepoInfo } from '../../types';

const calls: { cmd: string; args: any }[] = [];
let pending: { resolve: (v: any) => void; cmd: string; args: any }[] = [];
let manual = false;
let nextSnap = 1;

vi.mock('../../api', () => ({
  toAppError: (e: any) => ({ code: 'internal', message: String(e?.message ?? e), stderr: null }),
  call: (cmd: string, args: any) => {
    calls.push({ cmd, args });
    const run = () => {
      if (cmd === 'load_log') return makeSnap(nextSnap++, args.scope);
      if (cmd === 'get_authors') return [];
      return null;
    };
    if (manual && cmd === 'load_log') return new Promise((resolve) => pending.push({ resolve, cmd, args }));
    return Promise.resolve(run());
  },
}));

function makeSnap(id: number, scope: any): LogSnapshot {
  return {
    snapshotId: id, repoPath: '/r', scope, commitCount: 1, hashes: ['a'], parents: [[]], timestamps: [1],
    refs: { head: { detached: false, unborn: false, branch: 'main', fullName: 'refs/heads/main', hash: 'a' }, refs: [], operation: null },
    headIndex: 0, truncated: false, loadMillis: 1,
  } as LogSnapshot;
}

const info = { path: '/r', name: 'r' } as RepoInfo;
const released = () => calls.filter((c) => c.cmd === 'release_snapshot').map((c) => c.args.snapshotId);

beforeEach(() => { calls.length = 0; pending = []; manual = false; nextSnap = 1; });

describe('RepoStore reload races', () => {
  it('releases the old snapshot only after the new one is applied', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1);
    await s.reload();
    expect(s.getState().snapshot?.snapshotId).toBe(1);
    await s.reload();
    expect(s.getState().snapshot?.snapshotId).toBe(2);
    expect(released()).toEqual([1]);
  });

  it('a result arriving after dispose is released and never applied', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1);
    manual = true;
    const p = s.reload();
    s.dispose();
    pending[0].resolve(makeSnap(99, null));
    await p;
    expect(s.getState().snapshot).toBeNull();
    expect(released()).toContain(99);
  });

  it('scope changed during load: stale result is discarded and the load re-runs with the new scope', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1);
    manual = true;
    const p = s.reload();
    s.setScopeRefs(['refs/heads/x']);
    pending[0].resolve(makeSnap(10, { refs: null, limit: 1 }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    manual = false;
    // second load_log is pending (manual was true when it was issued)
    while (pending.length < 2) await Promise.resolve();
    pending[1].resolve(makeSnap(11, { refs: ['refs/heads/x'], limit: 1 }));
    await p;
    expect(s.getState().scopeRefs).toEqual(['refs/heads/x']);
    expect(s.getState().snapshot?.snapshotId).toBe(11);
    expect(released()).toContain(10);
  });

  it('a reopened tab is an independent store (old one cannot touch it)', async () => {
    const { RepoStore } = await import('./repoStore');
    const a = new RepoStore(info, 1);
    a.dispose();
    const b = new RepoStore(info, 2);
    await b.reload();
    await a.reload();
    expect(a.getState().snapshot).toBeNull();
    expect(b.getState().snapshot).not.toBeNull();
  });
});
