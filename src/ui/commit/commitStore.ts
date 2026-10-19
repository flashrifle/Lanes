// Working tree / staging / commit / stash state for one repo tab. Owned by ui-commit (docs/PLAN-v0.1.md).
// Phase 0 stub: refreshStatus() loads get_status; everything else is ui-commit's to build.
import { call, toAppError } from '../../api';
import type { AppError, WorkingTreeStatus } from '../../types';
import { Store, useStoreState } from '../state/createStore';
import type { RepoStore } from '../state/repoStore';

export interface CommitState {
  status: WorkingTreeStatus | null;
  statusLoading: boolean;
  statusError: AppError | null;
}

export class CommitStore extends Store<CommitState> {
  private disposed = false;
  private inflight: Promise<void> | null = null;
  private again = false;

  constructor(readonly repo: RepoStore) {
    super({ status: null, statusLoading: false, statusError: null });
  }

  /** Single-flight get_status; calls arriving mid-flight coalesce into one re-run. */
  refreshStatus = (): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    if (this.inflight) { this.again = true; return this.inflight; }
    this.inflight = (async () => {
      do {
        this.again = false;
        this.set({ statusLoading: true });
        try {
          const status = await call('get_status', { repoPath: this.repo.path });
          if (!this.disposed) this.set({ status, statusError: null });
        } catch (e) {
          if (!this.disposed) this.set({ statusError: toAppError(e) });
        }
      } while (this.again && !this.disposed);
      if (!this.disposed) this.set({ statusLoading: false });
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  };

  dispose(): void { this.disposed = true; }
}

/** Whether the "Uncommitted changes (N)" row is shown at the top of the log. */
export function useWorkingRowVisible(store: CommitStore): boolean {
  return useStoreState(store, (s) => (s.status?.files.length ?? 0) > 0);
}
