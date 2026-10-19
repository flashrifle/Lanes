// Quick Commit popover model: status checklist with a serialized stage queue, commit -> push sequencing.
// No React here (tested with a fake `call`). Owned by ui-app.
import { call as realCall } from '../api';
import type { AppError, CommandMap, CommandName, PushRequest, StatusFile, WorkingTreeStatus } from '../types';
import { toAppError } from '../api';
import { Store } from '../ui/state/createStore';

export type Call = <K extends CommandName>(cmd: K, args: CommandMap[K][0]) => Promise<CommandMap[K][1]>;

export type PushFailure = { kind: 'noRemote' } | { kind: 'error'; error: AppError };

export interface QuickState {
  repoPath: string | null;
  status: WorkingTreeStatus | null;
  loading: boolean;
  statusError: string | null;
  /** path -> intended state while stage/unstage calls are queued or in flight (cleared after the next refresh). */
  overlay: Record<string, 'stage' | 'unstage'>;
  message: string;
  busy: null | 'commit' | 'push';
  commitError: string | null;
  pushFailure: PushFailure | null;
  /** Set after a successful commit (+ push when requested); cleared by the next edit. */
  done: null | { pushed: boolean };
}

const EMPTY: QuickState = {
  repoPath: null,
  status: null,
  loading: false,
  statusError: null,
  overlay: {},
  message: '',
  busy: null,
  commitError: null,
  pushFailure: null,
  done: null,
};

export const isConflicted = (f: StatusFile): boolean => f.conflict !== null;
/** Everything of this file is in the index (nothing left in the worktree to add). */
export const isFullyStaged = (f: StatusFile): boolean => f.staged !== null && f.unstaged === null && !f.untracked && f.conflict === null;
export const isPartiallyStaged = (f: StatusFile): boolean => f.staged !== null && (f.unstaged !== null || f.untracked);

export class QuickCommitModel extends Store<QuickState> {
  private gen = 0;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly call: Call;

  constructor(call: Call = realCall) {
    super(EMPTY);
    this.call = call;
  }

  // ───────────── targeting ─────────────
  /**
   * Called for every `quick-commit-target`. A different repo resets everything; the same repo (window shown
   * again) keeps the typed message and only refreshes the status. While a commit / push runs, a different repo is
   * ignored: the running Commit & Push must finish (and show its result) for the repo it started on.
   */
  retarget(repoPath: string): Promise<void> {
    if (this.state.repoPath === repoPath) return this.refresh();
    if (this.state.busy) return Promise.resolve();
    this.gen++;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.set({ ...EMPTY, repoPath, loading: true });
    return this.refresh();
  }

  async refresh(): Promise<void> {
    const repoPath = this.state.repoPath;
    if (!repoPath) return;
    const gen = this.gen;
    try {
      const status = await this.call('get_status', { repoPath });
      if (gen !== this.gen) return;
      this.set({ status, loading: false, statusError: null, ...(this.pending === 0 ? { overlay: {} } : {}) });
    } catch (e) {
      if (gen !== this.gen) return;
      this.set({ loading: false, statusError: toAppError(e).message });
    }
  }

  // ───────────── staging (serialized) ─────────────
  checked(f: StatusFile): boolean {
    const o = this.state.overlay[f.path];
    return o ? o === 'stage' : isFullyStaged(f);
  }

  toggle(path: string): Promise<void> {
    const f = this.state.status?.files.find((x) => x.path === path);
    if (!f) return Promise.resolve();
    return this.setStaged([path], !this.checked(f));
  }

  toggleAll(): Promise<void> {
    const files = this.state.status?.files ?? [];
    if (files.length === 0) return Promise.resolve();
    const all = files.every((f) => this.checked(f));
    return this.setStaged(files.map((f) => f.path), !all);
  }

  /** Queue a stage/unstage; calls never overlap and run in click order. Resolves when this op finished. */
  setStaged(paths: string[], stage: boolean): Promise<void> {
    const repoPath = this.state.repoPath;
    if (!repoPath || paths.length === 0) return Promise.resolve();
    const gen = this.gen;
    const overlay = { ...this.state.overlay };
    for (const p of paths) overlay[p] = stage ? 'stage' : 'unstage';
    this.set({ overlay, done: null });
    this.pending++;
    const run = async () => {
      try {
        if (gen === this.gen) await this.call(stage ? 'stage_files' : 'unstage_files', { repoPath, paths });
      } catch (e) {
        if (gen === this.gen) this.set({ commitError: toAppError(e).message });
      } finally {
        if (gen === this.gen) {
          this.pending--;
          if (this.pending === 0) await this.refresh(); // one refresh per burst
        }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p;
    return p;
  }

  /** Resolves when every queued stage op (and the refresh after it) is done. */
  drain(): Promise<void> {
    return this.queue;
  }

  // ───────────── message / commit / push ─────────────
  setMessage(message: string): void {
    this.set({ message, done: null, commitError: null });
  }

  stagedCount(): number {
    return (this.state.status?.files ?? []).filter((f) => this.checked(f)).length;
  }

  canCommit(): boolean {
    const s = this.state;
    if (!s.repoPath || !s.status || s.busy || s.message.trim() === '') return false;
    if (s.status.files.some(isConflicted)) return false;
    return this.stagedCount() > 0;
  }

  /** Commit the checked files; with `push`, push the current branch afterwards (never force). */
  async commit(push: boolean): Promise<void> {
    if (!this.canCommit()) return;
    const repoPath = this.state.repoPath!;
    const gen = this.gen;
    this.set({ busy: 'commit', commitError: null, pushFailure: null, done: null });
    await this.drain();
    if (gen !== this.gen) return;
    const message = this.state.message;
    try {
      await this.call('commit', { repoPath, request: { message, amend: false, signOff: false, allowEmpty: false } });
    } catch (e) {
      if (gen !== this.gen) return;
      this.set({ busy: null, commitError: toAppError(e).message }); // message is kept
      return;
    }
    if (gen !== this.gen) return;
    this.set({ message: '', busy: push ? 'push' : null, done: push ? null : { pushed: false } });
    if (push) await this.pushCurrent(gen);
    else await this.refresh();
  }

  /** Retry after a failed push (the commit already succeeded). */
  async retryPush(): Promise<void> {
    if (!this.state.repoPath || this.state.busy) return;
    const gen = this.gen;
    this.set({ busy: 'push', pushFailure: null, done: null });
    await this.pushCurrent(gen);
  }

  private async pushCurrent(gen: number): Promise<void> {
    const repoPath = this.state.repoPath!;
    try {
      const preview = await this.call('get_push_preview', { repoPath, localBranch: null });
      if (gen !== this.gen) return;
      if (!preview.remote) {
        this.set({ busy: null, pushFailure: { kind: 'noRemote' } });
      } else {
        const request: PushRequest = {
          remote: preview.remote,
          localBranch: preview.localBranch,
          remoteBranch: preview.remoteBranch,
          setUpstream: preview.upstream === null,
          forceWithLease: null,
          followTags: false,
        };
        await this.call('push', { repoPath, request });
        if (gen !== this.gen) return;
        this.set({ busy: null, done: { pushed: true } });
      }
    } catch (e) {
      if (gen !== this.gen) return;
      this.set({ busy: null, pushFailure: { kind: 'error', error: toAppError(e) } });
    }
    if (gen === this.gen) await this.refresh();
  }
}
