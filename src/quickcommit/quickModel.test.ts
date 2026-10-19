import { describe, expect, it, vi } from 'vitest';
import type { PushPreview, StatusFile, WorkingTreeStatus } from '../types';
import { QuickCommitModel, type Call } from './quickModel';

vi.mock('../api', () => ({
  call: vi.fn(),
  toAppError: (e: unknown) => (e && typeof e === 'object' && 'code' in e ? e : { code: 'internal', message: String(e), stderr: null }),
}));

const file = (path: string, o: Partial<StatusFile> = {}): StatusFile => ({
  path, oldPath: null, staged: null, unstaged: 'modified', untracked: false, conflict: null, submodule: false, ...o,
});
const status = (files: StatusFile[]): WorkingTreeStatus => ({
  headHash: 'abc', branch: 'main', upstream: 'refs/remotes/origin/main', ahead: 0, behind: 0, files, truncated: false, operation: null,
});
const preview = (o: Partial<PushPreview> = {}): PushPreview => ({
  localBranch: 'main', remotes: ['origin'], remote: 'origin', remoteBranch: 'main', upstream: 'refs/remotes/origin/main',
  remoteHash: 'h', outgoing: [], behind: 0, ...o,
});

interface Harness {
  model: QuickCommitModel;
  calls: { cmd: string; args: any }[];
  files: Record<string, StatusFile[]>;
  preview: PushPreview;
  fail: Record<string, unknown>;
  delay: Record<string, number>;
  maxConcurrent: () => number;
}

function harness(initial: StatusFile[] = [file('a.ts'), file('b.ts'), file('c.ts', { untracked: true, unstaged: null })]): Harness {
  let running = 0;
  let max = 0;
  const h: Harness = {
    model: null as never, calls: [], files: { '/r1': initial, '/r2': [file('z.ts')] }, preview: preview(), fail: {}, delay: {}, maxConcurrent: () => max,
  };
  const call = (async (cmd: string, args: any) => {
    h.calls.push({ cmd, args });
    running++;
    max = Math.max(max, running);
    try {
      await new Promise((r) => setTimeout(r, h.delay[cmd] ?? 0));
      if (h.fail[cmd]) throw h.fail[cmd];
      switch (cmd) {
        case 'get_status': return status(h.files[args.repoPath] ?? []);
        case 'stage_files':
          h.files[args.repoPath] = h.files[args.repoPath].map((f) => (args.paths.includes(f.path) ? { ...f, staged: f.staged ?? 'added', unstaged: null, untracked: false } : f));
          return { message: '' };
        case 'unstage_files':
          h.files[args.repoPath] = h.files[args.repoPath].map((f) => (args.paths.includes(f.path) ? { ...f, staged: null, unstaged: 'modified' } : f));
          return { message: '' };
        case 'commit':
          h.files[args.repoPath] = h.files[args.repoPath].filter((f) => !(f.staged && !f.unstaged));
          return { hash: 'new', message: 'ok' };
        case 'get_push_preview': return h.preview;
        case 'push': return { message: 'pushed' };
      }
      throw new Error('unexpected ' + cmd);
    } finally {
      running--;
    }
  }) as Call;
  h.model = new QuickCommitModel(call);
  return h;
}

const names = (h: Harness) => h.calls.map((c) => c.cmd);

describe('stage queue', () => {
  it('serializes calls in click order, never overlapping, with one refresh per burst', async () => {
    const h = harness();
    await h.model.retarget('/r1');
    h.calls.length = 0;
    h.delay.stage_files = 10;
    h.delay.unstage_files = 2;
    const ps = [h.model.toggle('a.ts'), h.model.toggle('a.ts'), h.model.toggle('b.ts')];
    // the optimistic overlay already reflects the clicks
    expect(h.model.getState().overlay).toEqual({ 'a.ts': 'unstage', 'b.ts': 'stage' });
    await Promise.all(ps);
    expect(names(h)).toEqual(['stage_files', 'unstage_files', 'stage_files', 'get_status']);
    expect(h.calls.map((c) => c.args.paths?.[0])).toEqual(['a.ts', 'a.ts', 'b.ts', undefined]);
    expect(h.maxConcurrent()).toBe(1);
    expect(h.model.getState().overlay).toEqual({});
    expect(h.model.getState().status?.files.find((f) => f.path === 'b.ts')?.staged).toBe('added');
  });

  it('toggleAll stages everything, then unstages everything', async () => {
    const h = harness();
    await h.model.retarget('/r1');
    await h.model.toggleAll();
    expect(h.calls.find((c) => c.cmd === 'stage_files')!.args.paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    await h.model.toggleAll();
    expect(h.calls.filter((c) => c.cmd === 'unstage_files')).toHaveLength(1);
  });

  it('a failing stage call surfaces the error and still refreshes', async () => {
    const h = harness();
    await h.model.retarget('/r1');
    h.fail.stage_files = { code: 'io', message: 'locked', stderr: null };
    await h.model.toggle('a.ts');
    expect(h.model.getState().commitError).toBe('locked');
    expect(h.model.getState().overlay).toEqual({});
  });
});

describe('commit / push sequencing', () => {
  async function ready(h: Harness) {
    await h.model.retarget('/r1');
    await h.model.toggle('a.ts');
    h.model.setMessage('feat: x');
    h.calls.length = 0;
  }

  it('is disabled without message, without staged files, and during conflicts', async () => {
    const h = harness();
    await h.model.retarget('/r1');
    h.model.setMessage('msg');
    expect(h.model.canCommit()).toBe(false); // nothing staged
    await h.model.toggle('a.ts');
    expect(h.model.canCommit()).toBe(true);
    h.model.setMessage('   ');
    expect(h.model.canCommit()).toBe(false);
    const c = harness([file('u.ts', { conflict: 'bothModified', unstaged: null }), file('a.ts', { staged: 'modified', unstaged: null })]);
    await c.model.retarget('/r1');
    c.model.setMessage('m');
    expect(c.model.canCommit()).toBe(false);
  });

  it('commit only: commits, clears the message, does not push', async () => {
    const h = harness();
    await ready(h);
    await h.model.commit(false);
    expect(names(h)).toEqual(['commit', 'get_status']);
    expect(h.calls[0].args.request).toEqual({ message: 'feat: x', amend: false, signOff: false, allowEmpty: false });
    expect(h.model.getState().message).toBe('');
    expect(h.model.getState().done).toEqual({ pushed: false });
  });

  it('commit & push: commit -> get_push_preview -> push, never force, no -u with an upstream', async () => {
    const h = harness();
    await ready(h);
    await h.model.commit(true);
    expect(names(h).slice(0, 3)).toEqual(['commit', 'get_push_preview', 'push']);
    expect(h.calls[2].args.request).toEqual({ remote: 'origin', localBranch: 'main', remoteBranch: 'main', setUpstream: false, forceWithLease: null, followTags: false });
    expect(h.model.getState().done).toEqual({ pushed: true });
  });

  it('sets the upstream when there is none', async () => {
    const h = harness();
    h.preview = preview({ upstream: null, remoteHash: null });
    await ready(h);
    await h.model.commit(true);
    expect(h.calls.find((c) => c.cmd === 'push')!.args.request).toMatchObject({ setUpstream: true, forceWithLease: null });
  });

  it('keeps the message when the commit fails and does not push', async () => {
    const h = harness();
    await ready(h);
    h.fail.commit = { code: 'hookRejected', message: 'pre-commit failed', stderr: 'x' };
    await h.model.commit(true);
    expect(names(h)).toEqual(['commit']);
    expect(h.model.getState().message).toBe('feat: x');
    expect(h.model.getState().commitError).toBe('pre-commit failed');
    expect(h.model.getState().busy).toBeNull();
  });

  it('push failure: message already cleared, error shown, retry pushes again without re-committing', async () => {
    const h = harness();
    await ready(h);
    h.fail.push = { code: 'pushRejected', message: 'rejected', stderr: 'non-fast-forward' };
    await h.model.commit(true);
    const s = h.model.getState();
    expect(s.message).toBe('');
    expect(s.pushFailure).toMatchObject({ kind: 'error', error: { code: 'pushRejected' } });
    delete h.fail.push;
    await h.model.retryPush();
    expect(h.model.getState().pushFailure).toBeNull();
    expect(h.model.getState().done).toEqual({ pushed: true });
    expect(names(h).filter((n) => n === 'commit')).toHaveLength(1);
  });

  it('no remote: reports noRemote without calling push', async () => {
    const h = harness();
    h.preview = preview({ remote: null, remotes: [] });
    await ready(h);
    await h.model.commit(true);
    expect(names(h)).not.toContain('push');
    expect(h.model.getState().pushFailure).toEqual({ kind: 'noRemote' });
  });

  it('waits for queued stage calls before committing', async () => {
    const h = harness();
    await h.model.retarget('/r1');
    h.model.setMessage('m');
    h.calls.length = 0;
    h.delay.stage_files = 15;
    const p = h.model.toggle('a.ts');
    const c = h.model.commit(false);
    await Promise.all([p, c]);
    const n = names(h);
    expect(n.indexOf('stage_files')).toBeGreaterThan(-1);
    expect(n.indexOf('commit')).toBeGreaterThan(n.indexOf('stage_files'));
  });
});

describe('re-targeting', () => {
  it('a different repo resets message, errors and status', async () => {
    const h = harness();
    await h.model.retarget('/r1');
    await h.model.toggle('a.ts');
    h.model.setMessage('draft');
    h.fail.commit = { code: 'internal', message: 'boom', stderr: null };
    await h.model.commit(false);
    expect(h.model.getState().commitError).toBe('boom');
    await h.model.retarget('/r2');
    const s = h.model.getState();
    expect(s.repoPath).toBe('/r2');
    expect(s.message).toBe('');
    expect(s.commitError).toBeNull();
    expect(s.overlay).toEqual({});
    expect(s.status?.files.map((f) => f.path)).toEqual(['z.ts']);
  });

  it('the same repo (window re-shown) keeps the typed message', async () => {
    const h = harness();
    await h.model.retarget('/r1');
    h.model.setMessage('draft');
    await h.model.retarget('/r1');
    expect(h.model.getState().message).toBe('draft');
  });

  it('late results of the old repo are ignored', async () => {
    const h = harness();
    h.delay.get_status = 20;
    const first = h.model.retarget('/r1');
    const second = h.model.retarget('/r2');
    await Promise.all([first, second]);
    expect(h.model.getState().status?.files.map((f) => f.path)).toEqual(['z.ts']);
  });

  it('a retarget during Commit & Push is ignored: the push finishes for the original repo', async () => {
    const h = harness();
    await h.model.retarget('/r1');
    await h.model.toggle('a.ts');
    h.model.setMessage('msg');
    h.delay.push = 20;
    const p = h.model.commit(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.model.getState().busy).not.toBeNull();
    await h.model.retarget('/r2');
    expect(h.model.getState().repoPath).toBe('/r1');
    await p;
    expect(h.calls.find((c) => c.cmd === 'push')?.args.repoPath).toBe('/r1');
    expect(h.model.getState().done).toEqual({ pushed: true });
    // once idle, retargeting works again
    await h.model.retarget('/r2');
    expect(h.model.getState().repoPath).toBe('/r2');
  });
});

