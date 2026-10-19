// Per-tab state + actions for write-op dialogs (push, merge/rebase, cherry-pick/revert, reset, tags, reflog, compare).
// Owned by ui-ops (docs/PLAN-v0.1.md).
import { call } from '../../api';
import { t } from '../../i18n';
import type {
  AppError, MergeRequest, OpOutcome, Ref, ResetRequest, RevRange,
} from '../../types';
import { Store } from '../state/createStore';
import type { RepoStore } from '../state/repoStore';
import { compareToRevRange, currentRev, explainErrorKey, headCtxOf, pickOrder, revertOrder, shortHash } from './logic';

export type OpsDialog =
  | { kind: 'none' }
  | { kind: 'push'; localBranch: string | null }
  | { kind: 'merge'; ref: Ref }
  | { kind: 'mainline'; op: 'cherryPick' | 'revert'; hashes: string[]; maxParents: number }
  | { kind: 'reset'; hash: string }
  | { kind: 'tag'; hash: string }
  | { kind: 'tagPush'; name: string }
  | { kind: 'reflog'; ref: string | null };

export interface OpsState {
  dialog: OpsDialog;
}

export class OpsStore extends Store<OpsState> {
  constructor(readonly repo: RepoStore) {
    super({ dialog: { kind: 'none' } });
  }

  dispose(): void {}

  // ───────────── dialogs ─────────────
  open = (dialog: OpsDialog): void => { this.set({ dialog }); };
  close = (): void => { this.set({ dialog: { kind: 'none' } }); };

  // ───────────── outcome / error plumbing ─────────────
  /** Toast for a failed op, with a plain explanation for the well-known codes. */
  fail(o: { ok: boolean; error?: AppError }): void {
    if (o.ok || !o.error) return;
    const key = explainErrorKey(o.error.code);
    if (key) { this.repo.showToast('error', t(key)); return; }
    this.repo.failToast(o);
  }

  /** runOp for ops that may stop half-way: conflicts → toast pointing at Local Changes. */
  async runOutcome(label: string, fn: (repoPath: string) => Promise<OpOutcome>): Promise<boolean> {
    let out: OpOutcome | null = null;
    const r = await this.repo.runOp(label, async (p) => { out = await fn(p); return out; });
    if (!r.ok) { this.fail(r); return false; }
    if ((out as OpOutcome | null)?.conflicts) {
      this.repo.showToast('error', t('ops.conflicts'));
      this.repo.selectWorking();
    }
    return true;
  }

  // ───────────── cherry-pick / revert ─────────────
  /** hashes: row order (newest first). Asks for the mainline parent when any commit is a merge. */
  startSequence = async (op: 'cherryPick' | 'revert', hashes: string[]): Promise<void> => {
    if (!hashes.length) return;
    let max = 1;
    try {
      const details = await Promise.all(hashes.map((hash) => call('get_commit_details', { repoPath: this.repo.path, hash })));
      max = details.reduce((m, d) => Math.max(m, d.parents.length), 1);
    } catch (e) { this.repo.showError(e); return; }
    if (max > 1) this.open({ kind: 'mainline', op, hashes, maxParents: max });
    else await this.runSequence(op, hashes, null, false);
  };

  runSequence = async (op: 'cherryPick' | 'revert', hashes: string[], mainline: number | null, recordOrigin: boolean): Promise<boolean> => {
    if (op === 'cherryPick') {
      return this.runOutcome(t('ops.cherryPicking'), (repoPath) =>
        call('cherry_pick', { repoPath, request: { hashes: pickOrder(hashes), recordOrigin, mainline } }));
    }
    return this.runOutcome(t('ops.reverting'), (repoPath) =>
      call('revert', { repoPath, request: { hashes: revertOrder(hashes), mainline } }));
  };

  // ───────────── merge / rebase ─────────────
  merge = (request: MergeRequest, label: string): Promise<boolean> =>
    this.runOutcome(t('ops.merging', { name: label }), (repoPath) => call('merge', { repoPath, request }));

  /** Confirm, then rebase the current branch onto `ref`. */
  askRebase = (ref: Ref): void => {
    const head = headCtxOf(this.repo.getState().snapshot?.refs);
    this.repo.openDialog({
      kind: 'confirm',
      title: t('merge.rebaseTitle'),
      message: t('merge.rebaseMsg', { branch: head.branch ?? 'HEAD', onto: ref.name }),
      confirmLabel: t('common.rebase'),
      onConfirm: () => {
        this.repo.closeDialog();
        void this.runOutcome(t('ops.rebasing', { name: ref.name }), (repoPath) => call('rebase', { repoPath, onto: ref.fullName }));
      },
    });
  };

  // ───────────── reset / tags ─────────────
  reset = async (request: ResetRequest): Promise<AppError | null> => {
    const o = await this.repo.runOp(t('reset.running'), (repoPath) => call('reset', { repoPath, request }));
    return o.ok ? null : o.error;
  };

  createTag = async (name: string, target: string, message: string | null): Promise<AppError | null> => {
    const o = await this.repo.runOp(t('tag.creating', { name }), (repoPath) => call('create_tag', { repoPath, request: { name, target, message } }));
    return o.ok ? null : o.error;
  };

  askDeleteTag = (name: string): void => {
    this.repo.openDialog({
      kind: 'confirm', danger: true,
      title: t('tag.deleteTitle'), message: t('tag.deleteMsg', { name }), confirmLabel: t('common.delete'),
      onConfirm: () => {
        this.repo.closeDialog();
        void this.repo.runOp(t('tag.deleting', { name }), (repoPath) => call('delete_tag', { repoPath, name })).then((o) => this.fail(o));
      },
    });
  };

  pushTag = async (remote: string, name: string): Promise<AppError | null> => {
    const o = await this.repo.runOp(t('tag.pushing', { name }), (repoPath) => call('push_tag', { repoPath, remote, name }));
    return o.ok ? null : o.error;
  };

  /** Single remote → confirm; several → remote picker dialog. */
  startPushTag = (name: string): void => {
    const remotes = this.repo.getState().repo.remotes;
    if (remotes.length === 0) { this.repo.showToast('error', t('push.noRemote')); return; }
    if (remotes.length === 1) {
      this.repo.openDialog({
        kind: 'confirm', title: t('tag.pushTitle'), message: t('tag.pushMsg', { name, remote: remotes[0] }), confirmLabel: t('push.push'),
        onConfirm: () => { this.repo.closeDialog(); void this.pushTag(remotes[0], name).then((e) => this.fail({ ok: !e, error: e ?? undefined })); },
      });
    } else this.open({ kind: 'tagPush', name });
  };

  // ───────────── compare ─────────────
  /** Compare `a` with `b` (commits in a not in b). Switches the log scope to all refs. */
  compare = (a: string, b: string): void => { setRevRange(this.repo, compareToRevRange(a, b)); };
  compareWithCurrent = (a: string): void => {
    const head = headCtxOf(this.repo.getState().snapshot?.refs);
    this.compare(a, currentRev(head));
  };
  clearCompare = (): void => { setRevRange(this.repo, null); };

  copyHash = async (hash: string): Promise<void> => {
    try { await navigator.clipboard.writeText(hash); this.repo.showToast('info', t('reflog.copied', { hash: shortHash(hash) })); }
    catch (e) { this.repo.showError(e); }
  };
}

/** Set / clear the branch-compare range (RepoStore widens the scope to all refs while compare is active). */
export function setRevRange(store: RepoStore, rr: RevRange | null): void {
  store.setRevRange(rr);
}
