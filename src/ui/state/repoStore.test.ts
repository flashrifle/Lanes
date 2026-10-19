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

describe('RepoStore write queue and dialogs', () => {
  it('runOp and commit-store ops share one serialized queue', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1, async () => {});
    const order: string[] = [];
    let release!: () => void;
    const a = s.runOp('checkout', async () => { order.push('checkout start'); await new Promise<void>((r) => { release = r; }); order.push('checkout end'); return { message: '' }; });
    // CommitStore light op (stage) goes through the same queue
    const b = s.commit.queue.run(async () => { order.push('stage'); });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['checkout start']);
    expect(s.getState().opPending).toBe(2);
    expect(s.commit.getState().pending).toBe(2);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['checkout start', 'checkout end', 'stage']);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getState().opPending).toBe(0);
    s.dispose();
  });

  it('a keyed op ignores a second call while the first is running', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1, async () => {});
    let n = 0;
    let release!: () => void;
    const fn = async () => { n++; await new Promise<void>((r) => { release = r; }); return { message: 'ok' }; };
    const p1 = s.runOp('fetch', fn, 'fetch');
    expect(s.isRunning('fetch')).toBe(true);
    const p2 = s.runOp('fetch', fn, 'fetch');
    await expect(p2).resolves.toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await p1;
    expect(n).toBe(1);
    expect(s.isRunning('fetch')).toBe(false);
    s.dispose();
  });

  it('a late dialog never replaces an open one; it is shown after the current one closes', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1);
    const d1 = { kind: 'confirm' as const, title: 'one', message: '', confirmLabel: 'ok', onConfirm: () => {} };
    const d2 = { ...d1, title: 'two' };
    s.openDialog(d1);
    s.openDialog(d2);
    expect(s.getState().dialog).toBe(d1);
    s.closeDialog();
    expect(s.getState().dialog).toBe(d2);
    s.closeDialog();
    expect(s.getState().dialog).toBeNull();
    s.dispose();
  });

  it('closeDialogIf closes only the same dialog', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1);
    const d1 = { kind: 'createBranch' as const, startPoint: 'a', startLabel: 'a' };
    const d2 = { kind: 'createBranch' as const, startPoint: 'b', startLabel: 'b' };
    s.openDialog(d1);
    s.closeDialog();
    s.openDialog(d2);
    s.closeDialogIf(d1); // late close of the first dialog
    expect(s.getState().dialog).toBe(d2);
    s.closeDialogIf(d2);
    expect(s.getState().dialog).toBeNull();
    s.dispose();
  });

  it('leaving the working row selects the HEAD commit', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1);
    await s.reload();
    s.selectWorking();
    expect(s.getState().workingSelected).toBe(true);
    s.leaveWorking();
    expect(s.getState().workingSelected).toBe(false);
    expect(s.getState().selection.focus).toBe(0); // headIndex of the fake snapshot
    s.dispose();
  });

  it('the pull non-fast-forward dialog does not autofocus its primary button', async () => {
    const { RepoStore } = await import('./repoStore');
    const s = new RepoStore(info, 1, async () => {});
    s.runOp = (async () => ({ ok: false, error: { code: 'nonFastForward', message: 'nff', stderr: null } })) as typeof s.runOp;
    await s.pull('ffOnly');
    const d = s.getState().dialog;
    expect(d?.kind).toBe('confirm');
    expect(d && d.kind === 'confirm' && d.noAutoFocus).toBe(true);
    s.dispose();
  });
});
