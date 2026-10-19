import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError, WorkingTreeStatus } from '../../types';

const call = vi.fn();
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), call: (...a: unknown[]) => call(...a) }));

const { CommitStore } = await import('./commitStore');
const { toAppError } = await import('../../api');
type RepoStore = import('../state/repoStore').RepoStore;

const status = (over: Partial<WorkingTreeStatus> = {}): WorkingTreeStatus => ({
  headHash: 'h'.repeat(40), branch: 'main', upstream: null, ahead: null, behind: null, files: [], truncated: false, operation: null, ...over,
});

function fakeRepo() {
  const repo = {
    path: '/repo',
    runOp: vi.fn(async (_label: string, fn: (p: string) => Promise<{ message: string }>) => {
      try { await fn('/repo'); return { ok: true as const }; } catch (e) { return { ok: false as const, error: toAppError(e) }; }
    }),
    failToast: vi.fn(),
    showToast: vi.fn(),
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    selectWorking: vi.fn(),
  };
  return repo;
}

const noSleep = async () => {};
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { call.mockReset(); });

describe('CommitStore.refreshStatus', () => {
  it('is single-flight: calls during a fetch coalesce into one re-run', async () => {
    let resolve!: (s: WorkingTreeStatus) => void;
    call.mockImplementation((cmd: string) => (cmd === 'get_status' ? new Promise((r) => { resolve = r; }) : Promise.resolve(null)));
    const cs = new CommitStore(fakeRepo() as unknown as RepoStore, noSleep);
    const p1 = cs.refreshStatus();
    void cs.refreshStatus();
    void cs.refreshStatus();
    expect(call).toHaveBeenCalledTimes(1);
    resolve(status());
    await flush();
    expect(call).toHaveBeenCalledTimes(2);
    resolve(status({ branch: 'dev' }));
    await p1;
    expect(cs.getState().status?.branch).toBe('dev');
    expect(cs.getState().statusLoading).toBe(false);
  });

  it('keeps the error', async () => {
    call.mockRejectedValue({ code: 'notARepo', message: 'gone', stderr: null });
    const cs = new CommitStore(fakeRepo() as unknown as RepoStore, noSleep);
    await cs.refreshStatus();
    expect(cs.getState().statusError?.code).toBe('notARepo');
  });
});

describe('CommitStore write ops', () => {
  it('serializes stage / unstage in order and refreshes status', async () => {
    const order: string[] = [];
    let release!: () => void;
    call.mockImplementation((cmd: string, args: { paths?: string[] }) => {
      if (cmd === 'get_status') return Promise.resolve(status());
      order.push(`${cmd}:${args.paths?.join(',')}`);
      if (order.length === 1) return new Promise((r) => { release = () => r({ message: '' }); });
      return Promise.resolve({ message: '' });
    });
    const cs = new CommitStore(fakeRepo() as unknown as RepoStore, noSleep);
    const a = cs.stage(['a']);
    const b = cs.unstage(['b']);
    await flush();
    expect(order).toEqual(['stage_files:a']);
    expect(cs.getState().pending).toBe(2);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['stage_files:a', 'unstage_files:b']);
    expect(call.mock.calls.some((c) => c[0] === 'get_status')).toBe(true);
  });

  it('retries once on busy, then toasts a friendly error', async () => {
    const busy: AppError = { code: 'busy', message: 'lock', stderr: 'Unable to create index.lock' };
    call.mockImplementation((cmd: string) => (cmd === 'stage_files' ? Promise.reject(busy) : Promise.resolve(status())));
    const repo = fakeRepo();
    const cs = new CommitStore(repo as unknown as RepoStore, noSleep);
    const o = await cs.stage(['x']);
    expect(o.ok).toBe(false);
    expect(call.mock.calls.filter((c) => c[0] === 'stage_files')).toHaveLength(2);
    expect(repo.failToast).toHaveBeenCalledTimes(1);
    expect(repo.failToast.mock.calls[0][0].error.stderr).toBeNull();
  });

  it('commit sends the message via the request, clears it on success, then pushes with preview defaults', async () => {
    call.mockImplementation((cmd: string) => {
      switch (cmd) {
        case 'commit': return Promise.resolve({ hash: 'n'.repeat(40), message: 'done' });
        case 'get_push_preview': return Promise.resolve({
          localBranch: 'main', remotes: ['origin'], remote: 'origin', remoteBranch: 'main', upstream: null, remoteHash: null, outgoing: [], behind: 0,
        });
        case 'push': return Promise.resolve({ message: 'pushed' });
        default: return Promise.resolve(status());
      }
    });
    const cs = new CommitStore(fakeRepo() as unknown as RepoStore, noSleep);
    cs.setMessage('-subject\n\nbody');
    cs.setSignOff(true);
    expect(await cs.commit(true)).toBe(true);
    const commitCall = call.mock.calls.find((c) => c[0] === 'commit')!;
    expect(commitCall[1]).toEqual({ repoPath: '/repo', request: { message: '-subject\n\nbody', amend: false, signOff: true, allowEmpty: false } });
    const pushCall = call.mock.calls.find((c) => c[0] === 'push')!;
    expect(pushCall[1].request).toEqual({ remote: 'origin', localBranch: 'main', remoteBranch: 'main', setUpstream: true, forceWithLease: null, followTags: false });
    expect(cs.getState().message).toBe('');
    expect(cs.getState().committing).toBe(false);
  });

  it('keeps the message when the commit fails', async () => {
    call.mockImplementation((cmd: string) => (cmd === 'commit' ? Promise.reject({ code: 'nothingToCommit', message: 'x', stderr: null }) : Promise.resolve(status())));
    const repo = fakeRepo();
    const cs = new CommitStore(repo as unknown as RepoStore, noSleep);
    cs.setMessage('msg');
    expect(await cs.commit(true)).toBe(false);
    expect(cs.getState().message).toBe('msg');
    expect(call.mock.calls.some((c) => c[0] === 'push' || c[0] === 'get_push_preview')).toBe(false);
    expect(repo.failToast).toHaveBeenCalled();
  });

  it('amend prefills the HEAD message and restores the draft when turned off', async () => {
    call.mockImplementation((cmd: string) => (cmd === 'get_commit_details'
      ? Promise.resolve({ subject: 'Last', body: 'Body' })
      : Promise.resolve(status())));
    const cs = new CommitStore(fakeRepo() as unknown as RepoStore, noSleep);
    await cs.refreshStatus();
    await cs.setAmend(true);
    expect(cs.getState().message).toBe('Last\n\nBody');
    await cs.setAmend(false);
    expect(cs.getState().message).toBe('');
  });

  it('control_operation passes the detected operation; abort confirms first', async () => {
    call.mockImplementation((cmd: string) => (cmd === 'control_operation'
      ? Promise.resolve({ message: '', conflicts: true, operation: 'rebase' })
      : Promise.resolve(status({ operation: { operation: 'rebase', headName: 'f', ontoHash: null, stoppedAt: null, step: 1, total: 2, canContinue: true, canSkip: true } }))));
    const repo = fakeRepo();
    const cs = new CommitStore(repo as unknown as RepoStore, noSleep);
    await cs.refreshStatus();
    cs.controlOperation('continue');
    await flush(); await flush();
    expect(call.mock.calls.find((c) => c[0] === 'control_operation')![1]).toEqual({ repoPath: '/repo', operation: 'rebase', action: 'continue' });
    expect(repo.selectWorking).toHaveBeenCalled(); // conflicts outcome
    cs.controlOperation('abort');
    expect(repo.openDialog).toHaveBeenCalledTimes(1);
    expect(call.mock.calls.filter((c) => c[0] === 'control_operation')).toHaveLength(1);
  });
});
