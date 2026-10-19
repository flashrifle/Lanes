import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('../../api', async (orig) => ({ ...(await orig<typeof import('../../api')>()), call: (...a: unknown[]) => call(...a) }));

const { OpsStore } = await import('./opsStore');
const { toAppError } = await import('../../api');
type RepoStore = import('../state/repoStore').RepoStore;

const HEAD = 'a'.repeat(40);
const P1 = 'b'.repeat(40);
const P2 = 'c'.repeat(40);

function fakeRepo(o: { parents?: number[]; message?: string; ahead?: number | null; upstream?: string | null; detached?: boolean } = {}) {
  let message = o.message ?? '';
  const repo = {
    path: '/repo',
    getState: () => ({
      snapshot: {
        headIndex: 0, hashes: [HEAD, P1, P2], parents: [o.parents ?? [1], [], []],
        refs: { head: { detached: !!o.detached, unborn: false, branch: o.detached ? null : 'main', fullName: o.detached ? null : 'refs/heads/main', hash: HEAD }, refs: [], operation: null },
      },
      repo: { remotes: ['origin'] },
    }),
    commit: {
      getState: () => ({ status: { upstream: o.upstream === undefined ? 'refs/remotes/origin/main' : o.upstream, ahead: o.ahead === undefined ? 1 : o.ahead, operation: null }, message }),
      restoreDraft: vi.fn((m: string) => { if (message.trim()) return false; message = m; return true; }),
    },
    runOp: vi.fn(async (_l: string, fn: (p: string) => Promise<{ message: string }>) => {
      try { await fn('/repo'); return { ok: true as const }; } catch (e) { return { ok: false as const, error: toAppError(e) }; }
    }),
    openDialog: vi.fn(),
    closeDialog: vi.fn(),
    showToast: vi.fn(),
    showError: vi.fn(),
    failToast: vi.fn(),
    selectWorking: vi.fn(),
    draft: () => message,
  };
  return repo;
}

const details = (parents: string[]) => ({ hash: HEAD, parents, subject: 'Subj', body: 'Body line', authorName: 'a', authorEmail: 'e', authorTime: 0, committerName: 'a', committerEmail: 'e', committerTime: 0 });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => call.mockReset());

describe('Undo Commit', () => {
  it('confirms (not danger) with the subject, then soft-resets to the first parent, restores the message and selects the working row', async () => {
    call.mockImplementation((cmd: string) => Promise.resolve(cmd === 'get_commit_details' ? details([P1]) : { message: 'ok' }));
    const repo = fakeRepo();
    const ops = new OpsStore(repo as unknown as RepoStore);
    await ops.askUndoCommit(HEAD);
    const d = repo.openDialog.mock.calls[0][0];
    expect(d.danger).toBeFalsy();
    expect(d.message).toContain('Subj');
    expect(d.warning).toBeUndefined(); // ahead 1: not pushed, not a merge
    expect(call.mock.calls.some((c) => c[0] === 'reset')).toBe(false);
    d.onConfirm();
    await flush(); await flush();
    expect(call.mock.calls.find((c) => c[0] === 'reset')![1]).toEqual({ repoPath: '/repo', request: { hash: P1, mode: 'soft', discardLocalChanges: false } });
    expect(repo.draft()).toBe('Subj\n\nBody line');
    expect(repo.selectWorking).toHaveBeenCalled();
    expect(repo.showToast).not.toHaveBeenCalled();
  });

  it('keeps a typed draft and says so', async () => {
    call.mockImplementation((cmd: string) => Promise.resolve(cmd === 'get_commit_details' ? details([P1]) : { message: 'ok' }));
    const repo = fakeRepo({ message: 'my draft' });
    const ops = new OpsStore(repo as unknown as RepoStore);
    await ops.askUndoCommit(HEAD);
    repo.openDialog.mock.calls[0][0].onConfirm();
    await flush(); await flush();
    expect(repo.draft()).toBe('my draft');
    expect(repo.showToast).toHaveBeenCalledWith('info', expect.any(String));
    expect(repo.selectWorking).toHaveBeenCalled();
  });

  it('warns about pushed commits and merges; merge resets to the first parent', async () => {
    call.mockImplementation((cmd: string) => Promise.resolve(cmd === 'get_commit_details' ? details([P1, P2]) : { message: 'ok' }));
    const repo = fakeRepo({ ahead: 0, parents: [1, 2] });
    const ops = new OpsStore(repo as unknown as RepoStore);
    await ops.askUndoCommit(HEAD);
    const d = repo.openDialog.mock.calls[0][0];
    expect(d.warning.split('\n')).toHaveLength(2);
    expect(d.noAutoFocus).toBe(true);
    d.onConfirm();
    await flush(); await flush();
    expect(call.mock.calls.find((c) => c[0] === 'reset')![1].request.hash).toBe(P1);
  });

  it('is disabled for a detached HEAD, a root commit and non-HEAD commits', () => {
    expect(new OpsStore(fakeRepo({ detached: true }) as unknown as RepoStore).canUndo([HEAD])).toBe(false);
    expect(new OpsStore(fakeRepo({ parents: [] }) as unknown as RepoStore).canUndo([HEAD])).toBe(false);
    const ops = new OpsStore(fakeRepo() as unknown as RepoStore);
    expect(ops.canUndo([P1])).toBe(false);
    expect(ops.canUndo([HEAD])).toBe(true);
  });

  it('a failed reset toasts and leaves the draft alone', async () => {
    call.mockImplementation(() => Promise.resolve(details([P1])));
    const repo = fakeRepo();
    repo.runOp.mockResolvedValueOnce({ ok: false, error: { code: 'gitFailed', message: 'x', stderr: 'boom' } } as never);
    const ops = new OpsStore(repo as unknown as RepoStore);
    await ops.askUndoCommit(HEAD);
    repo.openDialog.mock.calls[0][0].onConfirm();
    await flush(); await flush();
    expect(repo.failToast).toHaveBeenCalled();
    expect(repo.draft()).toBe('');
    expect(repo.selectWorking).not.toHaveBeenCalled();
  });
});
