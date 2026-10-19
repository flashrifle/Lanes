// Working tree / staging / commit / stash state for one repo tab. Owned by ui-commit (docs/PLAN-v0.1.md).
// - get_status is single-flight (calls arriving mid-flight coalesce into one re-run).
// - Every write goes through one serialized queue per repo, and is retried once after 500 ms on `busy`.
// - Light ops (stage / unstage) refresh status only; ops that move refs go through RepoStore.runOp (toast + reload).
import { call, toAppError } from '../../api';
import type {
  AppError, CommitRequest, ConflictSide, OpOutcome, OperationAction, StashEntry, StashSaveRequest, WorkingTreeStatus,
} from '../../types';
import { Store, useStoreState } from '../state/createStore';
import type { RepoStore } from '../state/repoStore';
import { t } from '../../i18n';
import { createOpQueue, type OpQueue, type Sleep } from './opQueue';
import { discardRequestOf, type WorkingEntry } from './workingFiles';

export type CommitDialog =
  | { kind: 'none' }
  | { kind: 'stashSave'; paths: string[] | null };

export interface CommitState {
  status: WorkingTreeStatus | null;
  statusLoading: boolean;
  statusError: AppError | null;
  /** Commit message draft (first line = subject). Kept until a commit succeeds. */
  message: string;
  amend: boolean;
  signOff: boolean;
  /** A commit (or commit + push) is running. */
  committing: boolean;
  /** Write ops queued or running. */
  pending: number;
  stashes: StashEntry[] | null;
  stashLoading: boolean;
  dialog: CommitDialog;
}

type OpRes = { ok: true } | { ok: false; error: AppError };

/** User-facing text for error codes the commit flows know about; null = use the generic stderr toast. */
export function friendlyError(e: AppError): string | null {
  switch (e.code) {
    case 'nothingToCommit': return t('commit.err.nothing');
    case 'unmergedFiles': return t('commit.err.unmerged');
    case 'pushRejected': return t('commit.err.pushRejected');
    case 'authFailed': return t('commit.err.auth');
    case 'busy': return t('commit.err.busy');
    case 'wouldOverwrite': return t('stash.err.overwrite');
    case 'dirtyWorktree': return t('commit.err.dirty');
    default: return null;
  }
}

export class CommitStore extends Store<CommitState> {
  private disposed = false;
  private inflight: Promise<void> | null = null;
  private again = false;
  private stashWanted = false;
  /** Draft saved when "Amend" prefilled the message, restored when amend is turned off again. */
  private draftBeforeAmend: string | null = null;
  private amendPrefill: string | null = null;
  readonly queue: OpQueue;

  constructor(readonly repo: RepoStore, sleep?: Sleep) {
    super({
      status: null, statusLoading: false, statusError: null, message: '', amend: false, signOff: false,
      committing: false, pending: 0, stashes: null, stashLoading: false, dialog: { kind: 'none' },
    });
    this.queue = createOpQueue(sleep, (pending) => { if (!this.disposed) this.set({ pending }); });
  }

  protected override set(patch: Partial<CommitState>): void {
    if (!this.disposed) super.set(patch);
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
          this.set({ status, statusError: null });
        } catch (e) {
          this.set({ statusError: toAppError(e) });
        }
        if (this.stashWanted) await this.fetchStashes();
      } while (this.again && !this.disposed);
      this.set({ statusLoading: false });
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  };

  dispose(): void { this.disposed = true; }

  // ───────────── helpers ─────────────
  private toastError(error: AppError): void {
    const msg = friendlyError(error);
    this.repo.failToast({ ok: false, error: msg ? { ...error, message: msg, stderr: null } : error });
  }

  /** Queued light op (no reload): status refresh afterwards, error toast on failure. */
  private async light(fn: (repoPath: string) => Promise<unknown>): Promise<OpRes> {
    const repoPath = this.repo.path;
    try {
      await this.queue.run(() => fn(repoPath));
      return { ok: true };
    } catch (e) {
      const error = toAppError(e);
      this.toastError(error);
      return { ok: false, error };
    } finally {
      void this.refreshStatus();
    }
  }

  /** Queued op through RepoStore.runOp (progress toast → info toast + reload). Error toast on failure. */
  private async heavy(label: string, fn: (repoPath: string) => Promise<{ message: string }>, toast = true): Promise<OpRes> {
    const o = await this.repo.runOp(label, (repoPath) => this.queue.run(() => fn(repoPath)));
    if (!o.ok && toast) this.toastError(o.error);
    return o;
  }

  /** Conflicts after merge-like ops are an outcome, not an error: say so and show the Local Changes panel. */
  private afterOutcome(out: OpOutcome | null): void {
    if (out?.conflicts) {
      this.repo.showToast('error', t('conflict.after'));
      this.repo.selectWorking();
    }
  }

  // ───────────── staging ─────────────
  stage = (paths: string[]): Promise<OpRes> =>
    paths.length ? this.light((repoPath) => call('stage_files', { repoPath, paths })) : Promise.resolve({ ok: true });
  unstage = (paths: string[]): Promise<OpRes> =>
    paths.length ? this.light((repoPath) => call('unstage_files', { repoPath, paths })) : Promise.resolve({ ok: true });
  /** "Mark resolved" = git add. */
  markResolved = (paths: string[]): Promise<OpRes> => this.stage(paths);

  /** Confirm, then discard_files for the entries (staged rows also reset the index to HEAD; untracked rows are deleted). */
  confirmDiscard = (entries: readonly WorkingEntry[]): void => {
    const req = discardRequestOf(entries);
    const n = new Set([...req.paths, ...req.untrackedPaths]).size;
    if (n === 0) return;
    const names = entries.map((e) => e.file.path);
    const unique = [...new Set(names)];
    const list = unique.slice(0, 5).join(', ') + (unique.length > 5 ? ' ' + t('commit.discard.more', { n: unique.length - 5 }) : '');
    this.repo.openDialog({
      kind: 'confirm',
      title: t('commit.discard.title', { n }),
      message: (req.untrackedPaths.length ? t('commit.discard.msgUntracked') : req.includeStaged ? t('commit.discard.msgStaged') : t('commit.discard.msg')) + ' ' + list,
      confirmLabel: t('commit.discard.confirm'),
      danger: true,
      onConfirm: () => {
        this.repo.closeDialog();
        void this.heavy(t('commit.discard.progress'), (repoPath) => call('discard_files', { repoPath, request: req }));
      },
    });
  };

  resolveConflict = (paths: string[], side: ConflictSide): Promise<OpRes> =>
    this.heavy(t('conflict.resolving'), (repoPath) => call('resolve_conflict', { repoPath, paths, side }));

  openInEditor = (path: string): void => {
    call('open_in_editor', { repoPath: this.repo.path, path }).catch((e) => this.toastError(toAppError(e)));
  };
  revealInFinder = (path: string): void => {
    call('reveal_in_finder', { repoPath: this.repo.path, path }).catch((e) => this.toastError(toAppError(e)));
  };

  // ───────────── commit message ─────────────
  setMessage = (message: string): void => { this.set({ message }); };
  setSignOff = (signOff: boolean): void => { this.set({ signOff }); };

  /** Amend on: prefill HEAD's message when the box is empty (IntelliJ). Off: restore the previous draft if untouched. */
  setAmend = async (amend: boolean): Promise<void> => {
    this.set({ amend });
    if (!amend) {
      if (this.amendPrefill !== null && this.state.message === this.amendPrefill) this.set({ message: this.draftBeforeAmend ?? '' });
      this.amendPrefill = null;
      this.draftBeforeAmend = null;
      return;
    }
    const head = this.state.status?.headHash;
    if (!head || this.state.message.trim() !== '') return;
    try {
      const d = await call('get_commit_details', { repoPath: this.repo.path, hash: head });
      if (!this.state.amend || this.state.message.trim() !== '') return;
      const msg = d.body ? `${d.subject}\n\n${d.body}` : d.subject;
      this.draftBeforeAmend = this.state.message;
      this.amendPrefill = msg;
      this.set({ message: msg });
    } catch (e) {
      this.toastError(toAppError(e));
    }
  };

  /** Commit the index (optionally amend / sign-off), then push with the defaults when `push`. Message kept on failure. */
  commit = async (push: boolean): Promise<boolean> => {
    const { message, amend, signOff, committing } = this.state;
    if (committing) return false;
    if (!message.trim()) { this.repo.showToast('error', t('commit.err.empty')); return false; }
    const request: CommitRequest = { message, amend, signOff, allowEmpty: false };
    this.set({ committing: true });
    try {
      const o = await this.heavy(t(amend ? 'commit.amending' : 'commit.committing'), (repoPath) => call('commit', { repoPath, request }));
      if (!o.ok) return false;
      this.amendPrefill = null;
      this.draftBeforeAmend = null;
      this.set({ message: '', amend: false });
      if (push) return (await this.push()).ok;
      return true;
    } finally {
      this.set({ committing: false });
    }
  };

  /** Push the current branch with PushPreview defaults (set upstream when missing). Never forces. */
  push = async (): Promise<OpRes> => {
    let preview;
    try {
      preview = await call('get_push_preview', { repoPath: this.repo.path, localBranch: null });
    } catch (e) {
      const error = toAppError(e);
      this.toastError(error);
      return { ok: false, error };
    }
    if (!preview.remote) {
      const error: AppError = { code: 'invalidArgument', message: t('commit.err.noRemote'), stderr: null };
      this.toastError(error);
      return { ok: false, error };
    }
    const remote = preview.remote;
    return this.heavy(t('commit.pushing', { remote, branch: preview.remoteBranch }), (repoPath) =>
      call('push', {
        repoPath,
        request: {
          remote, localBranch: preview.localBranch, remoteBranch: preview.remoteBranch,
          setUpstream: preview.upstream == null, forceWithLease: null, followTags: false,
        },
      }));
  };

  // ───────────── operation in progress ─────────────
  /** Continue / skip run directly; abort confirms first. */
  controlOperation = (action: OperationAction): void => {
    const op = this.state.status?.operation?.operation;
    if (!op || op === 'bisect') return;
    const run = async () => {
      let out: OpOutcome | null = null;
      const o = await this.heavy(t(`conflict.action.${action}.progress`), async (repoPath) => {
        out = await call('control_operation', { repoPath, operation: op, action });
        return out;
      });
      if (o.ok) this.afterOutcome(out);
    };
    if (action !== 'abort') { void run(); return; }
    this.repo.openDialog({
      kind: 'confirm',
      title: t('conflict.abort.title', { op: t(`conflict.op.${op}`) }),
      message: t('conflict.abort.msg'),
      confirmLabel: t('conflict.action.abort'),
      danger: true,
      onConfirm: () => { this.repo.closeDialog(); void run(); },
    });
  };

  // ───────────── stash ─────────────
  openStashSave = (paths: string[] | null = null): void => { this.set({ dialog: { kind: 'stashSave', paths } }); };
  closeDialog = (): void => { this.set({ dialog: { kind: 'none' } }); };

  private async fetchStashes(): Promise<void> {
    try {
      const stashes = await call('list_stashes', { repoPath: this.repo.path });
      this.set({ stashes });
    } catch (e) {
      this.set({ stashes: this.state.stashes ?? [] });
      this.toastError(toAppError(e));
    }
  }

  /** Load the stash list now and keep it fresh on every status refresh. */
  loadStashes = async (): Promise<void> => {
    this.stashWanted = true;
    this.set({ stashLoading: true });
    await this.fetchStashes();
    this.set({ stashLoading: false });
  };

  saveStash = async (request: StashSaveRequest): Promise<boolean> => {
    const o = await this.heavy(t('stash.saving'), (repoPath) => call('stash_save', { repoPath, request }));
    void this.loadStashes();
    return o.ok;
  };

  applyStash = async (s: StashEntry, pop: boolean): Promise<void> => {
    let out: OpOutcome | null = null;
    const o = await this.heavy(t(pop ? 'stash.popping' : 'stash.applying', { name: `stash@{${s.index}}` }), async (repoPath) => {
      out = await call('stash_apply', { repoPath, stash: { index: s.index, hash: s.hash }, pop, restoreIndex: false });
      return out;
    });
    if (o.ok) this.afterOutcome(out);
    void this.loadStashes();
  };

  confirmDropStash = (s: StashEntry): void => {
    this.repo.openDialog({
      kind: 'confirm',
      title: t('stash.drop.title'),
      message: t('stash.drop.msg', { name: `stash@{${s.index}}`, msg: s.message }),
      confirmLabel: t('stash.drop'),
      danger: true,
      onConfirm: () => {
        this.repo.closeDialog();
        void this.heavy(t('stash.dropping'), (repoPath) => call('stash_drop', { repoPath, stash: { index: s.index, hash: s.hash } }))
          .then(() => this.loadStashes());
      },
    });
  };
}

/** Whether the "Uncommitted changes (N)" row is shown at the top of the log. */
export function useWorkingRowVisible(store: CommitStore): boolean {
  return useStoreState(store, (s) => (s.status?.files.length ?? 0) > 0);
}
