import { call, toAppError } from '../../api';
import { buildGraph } from '../../graph';
import type {
  AppError, AuthorInfo, ChangedFile, CheckoutTarget, CommitMeta, GraphLayout, GraphSortType, LogScope,
  LogSnapshot, PullMode, Ref, RepoInfo, SignatureInfo,
} from '../../types';
import { Store } from './createStore';
import {
  EMPTY_FILTER_UI, EMPTY_SELECTION, buildVisibleMask, captureSelection, isFilterEmpty, moveFocusTo, restoreSelection,
  selectAll, selectRow, toLogFilter, type FilterUi, type RowMap, type Selection, type TextFilterUi,
} from './logic';
import { t } from '../../i18n';

export const LOG_LIMIT = 200_000;
const META_BATCH = 500;
const META_MAX_RETRIES = 3;

export type DialogState =
  | { kind: 'createBranch'; startPoint: string; startLabel: string }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
      alt?: { label: string; onClick: () => void };
    };

export interface ToastState { id: number; kind: 'progress' | 'info' | 'error'; text: string }

/** Everything a single repo tab owns. */
export interface RepoState {
  repo: RepoInfo;
  snapshot: LogSnapshot | null;
  layout: GraphLayout | null;
  loading: boolean;
  filterUi: FilterUi;
  filterError: boolean;
  scopeRefs: string[] | null;
  sort: GraphSortType;
  matches: number[] | null;
  authors: AuthorInfo[];
  selection: Selection;
  metaVersion: number;
  sigVersion: number;
  scrollRequest: { row: number; nonce: number } | null;
  toast: ToastState | null;
  dialog: DialogState | null;
  diff: ChangedFile | null;
}

export function rowMapOf(layout: GraphLayout | null): RowMap {
  return layout ?? { rowCount: 0, commitIndexAt: () => -1, rowOf: () => -1 };
}

let nonce = 1;

function layoutFor(snapshot: LogSnapshot, matches: number[] | null, sort: GraphSortType): GraphLayout {
  return buildGraph(snapshot, { sortType: sort, visible: buildVisibleMask(snapshot.commitCount, matches), collapseLongEdges: true });
}

const filterKeyOf = (ui: FilterUi): string => JSON.stringify(toLogFilter(ui));

export class RepoStore extends Store<RepoState> {
  readonly path: string;
  /** Tab generation (from the app store): distinguishes close/reopen of the same path. */
  readonly gen: number;
  /** Bumped by dispose(); every async continuation compares against the value captured at its start. */
  private epoch = 0;
  private disposed = false;

  private metaCache = new Map<number, CommitMeta>();
  private metaInflight = new Set<number>();
  private metaRetries = 0;
  private metaRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private metaErrorShown = false;
  private sigCache = new Map<string, SignatureInfo>();
  private sigRequested = new Set<string>();
  private topCommitIndex: number | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  private reloading = false;
  private dirty = false;
  private filterToken = 0;

  constructor(repo: RepoInfo, gen: number) {
    super({
      repo, snapshot: null, layout: null, loading: false, filterUi: EMPTY_FILTER_UI, filterError: false,
      scopeRefs: null, sort: 'bek', matches: null, authors: [], selection: EMPTY_SELECTION,
      metaVersion: 0, sigVersion: 0, scrollRequest: null, toast: null, dialog: null, diff: null,
    });
    this.path = repo.path;
    this.gen = gen;
  }

  get isDisposed(): boolean { return this.disposed; }
  private stale(epoch: number): boolean { return this.disposed || epoch !== this.epoch; }

  getMeta = (i: number): CommitMeta | undefined => this.metaCache.get(i);
  getSignature = (h: string): SignatureInfo | undefined => this.sigCache.get(h);
  setTopCommitIndex = (i: number | null): void => { this.topCommitIndex = i; };

  /** Stop all async work and release the backend snapshot. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    clearTimeout(this.toastTimer);
    clearTimeout(this.metaRetryTimer);
    const snap = this.state.snapshot;
    if (snap) void call('release_snapshot', { snapshotId: snap.snapshotId }).catch(() => {});
    this.state = { ...this.state, snapshot: null, layout: null, selection: EMPTY_SELECTION, dialog: null, diff: null, scrollRequest: null, toast: null, loading: false };
    this.metaCache.clear(); this.metaInflight.clear(); this.sigCache.clear(); this.sigRequested.clear();
  }

  // ───────────── toast / dialog ─────────────
  showToast = (kind: ToastState['kind'], text: string): void => {
    if (this.disposed) return;
    clearTimeout(this.toastTimer);
    const id = nonce++;
    this.set({ toast: { id, kind, text } });
    if (kind !== 'progress') {
      this.toastTimer = setTimeout(() => { if (this.state.toast?.id === id) this.set({ toast: null }); }, kind === 'error' ? 10000 : 4000);
    }
  };
  dismissToast = (): void => { clearTimeout(this.toastTimer); this.set({ toast: null }); };
  showError = (e: unknown): void => { this.showToast('error', toAppError(e).message); };
  openDialog = (d: DialogState): void => { this.set({ dialog: d }); };
  closeDialog = (): void => { this.set({ dialog: null }); };
  openDiff = (file: ChangedFile): void => { this.set({ diff: file }); };
  closeDiff = (): void => { this.set({ diff: null }); };

  onProgress(line: string): void {
    const t = this.state.toast;
    if (t?.kind === 'progress' && line.trim()) this.set({ toast: { ...t, text: line.trim() } });
  }

  // ───────────── loading ─────────────
  private anchorHash(): string | null {
    const { snapshot, selection, layout } = this.state;
    if (!snapshot || !layout) return null;
    if (selection.focus != null && layout.rowOf(selection.focus) >= 0) return snapshot.hashes[selection.focus] ?? null;
    return this.topCommitIndex != null ? snapshot.hashes[this.topCommitIndex] ?? null : null;
  }

  /** Single-flight full reload (refs + log + filter + layout). Calls arriving mid-flight coalesce into one re-run. */
  reload = async (): Promise<void> => {
    if (this.disposed) return;
    if (this.reloading) { this.dirty = true; return; }
    const epoch = this.epoch;
    this.reloading = true;
    this.set({ loading: true });
    try {
      do {
        this.dirty = false;
        await this.loadOnce(epoch);
      } while (this.dirty && !this.stale(epoch));
    } catch (e) {
      if (!this.stale(epoch)) this.showError(e);
    } finally {
      if (!this.stale(epoch)) { this.reloading = false; this.set({ loading: false }); }
    }
  };

  private async loadOnce(epoch: number): Promise<void> {
    const repoPath = this.path;
    const requestedScope = this.state.scopeRefs;
    let scopeRefs = requestedScope;
    const scope = (refs: string[] | null): LogScope => ({ refs, limit: LOG_LIMIT });
    let snapshot: LogSnapshot;
    try {
      snapshot = await call('load_log', { repoPath, scope: scope(scopeRefs) });
    } catch (e) {
      if (scopeRefs && (e as AppError).code === 'invalidArgument') {
        scopeRefs = null;
        snapshot = await call('load_log', { repoPath, scope: scope(null) });
      } else throw e;
    }
    const releaseNew = () => void call('release_snapshot', { snapshotId: snapshot.snapshotId }).catch(() => {});
    // Anything that goes wrong (or is superseded) from here on must release the freshly created snapshot.
    let applied = false;
    try {
      if (this.stale(epoch)) return;
      if (this.state.scopeRefs !== requestedScope) { this.dirty = true; return; }

      const filterKey = filterKeyOf(this.state.filterUi);
      const filter = toLogFilter(this.state.filterUi);
      let matches: number[] | null = null;
      let filterError = false;
      if (!isFilterEmpty(filter)) {
        try {
          matches = (await call('filter_commits', { snapshotId: snapshot.snapshotId, filter })).matches;
        } catch (e) {
          filterError = (e as AppError).code === 'invalidArgument';
          if (!filterError) throw e;
        }
      }
      if (this.stale(epoch)) return;
      if (this.state.scopeRefs !== requestedScope) { this.dirty = true; return; }

      // Selection/anchor are captured now (after every await) so user changes made while loading are preserved.
      const old = this.state.snapshot;
      const savedSel = old ? captureSelection(this.state.selection, old.hashes) : null;
      const savedAnchor = this.anchorHash();
      const layout = layoutFor(snapshot, matches, this.state.sort);
      const h2i = new Map<string, number>();
      snapshot.hashes.forEach((h, i) => h2i.set(h, i));
      const selection = savedSel ? restoreSelection(savedSel, h2i) : EMPTY_SELECTION;
      this.metaCache.clear(); this.metaInflight.clear(); this.metaRetries = 0; this.metaErrorShown = false;
      this.topCommitIndex = null;
      let scrollRequest = this.state.scrollRequest;
      const ai = savedAnchor ? h2i.get(savedAnchor) : undefined;
      if (ai !== undefined && layout.rowOf(ai) >= 0) scrollRequest = { row: layout.rowOf(ai), nonce: nonce++ };
      this.set({
        snapshot, layout, matches, filterError, scopeRefs: scopeRefs, selection, scrollRequest,
        metaVersion: this.state.metaVersion + 1,
      });
      applied = true;
      // Only now is the old snapshot unreferenced.
      if (old) void call('release_snapshot', { snapshotId: old.snapshotId }).catch(() => {});
      void call('get_authors', { snapshotId: snapshot.snapshotId })
        .then((authors) => { if (!this.stale(epoch) && this.state.snapshot?.snapshotId === snapshot.snapshotId) this.set({ authors }); })
        .catch(() => {});
      // A filter edit made while we were loading was applied to the old snapshot; redo it on the new one.
      if (filterKeyOf(this.state.filterUi) !== filterKey) void this.applyFilter();
    } finally {
      if (!applied) releaseNew();
    }
  }

  /** Re-run filter_commits + layout for the current snapshot (cheap path, no log reload). */
  private async applyFilter(): Promise<void> {
    const snapshot = this.state.snapshot;
    if (!snapshot || this.disposed) return;
    const epoch = this.epoch;
    const token = ++this.filterToken;
    const filter = toLogFilter(this.state.filterUi);
    const anchor = this.anchorHash();
    let matches: number[] | null = null;
    let filterError = false;
    if (!isFilterEmpty(filter)) {
      try {
        matches = (await call('filter_commits', { snapshotId: snapshot.snapshotId, filter })).matches;
      } catch (e) {
        if (this.stale(epoch)) return;
        const err = e as AppError;
        if (err.code === 'snapshotExpired') { void this.reload(); return; }
        if (err.code !== 'invalidArgument') { this.showError(e); return; }
        filterError = true;
      }
    }
    if (this.stale(epoch) || token !== this.filterToken || this.state.snapshot !== snapshot) return;
    if (filterError) { this.set({ filterError: true }); return; }
    this.relayout(matches, this.state.sort, anchor, false);
  }

  private relayout(matches: number[] | null, sort: GraphSortType, anchor: string | null, keepMatches: boolean): void {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const m = keepMatches ? this.state.matches : matches;
    const layout = layoutFor(snapshot, m, sort);
    let scrollRequest = this.state.scrollRequest;
    if (anchor) {
      const idx = snapshot.hashes.indexOf(anchor);
      if (idx >= 0 && layout.rowOf(idx) >= 0) scrollRequest = { row: layout.rowOf(idx), nonce: nonce++ };
    }
    this.topCommitIndex = null;
    this.set({ layout, matches: m, filterError: false, sort, scrollRequest, metaVersion: this.state.metaVersion + 1 });
  }

  // ───────────── filter actions ─────────────
  setTextFilter = (text: TextFilterUi): void => { this.set({ filterUi: { ...this.state.filterUi, text } }); void this.applyFilter(); };
  setUsers = (users: string[] | null): void => { this.set({ filterUi: { ...this.state.filterUi, users } }); void this.applyFilter(); };
  setDateRange = (date: FilterUi['date']): void => { this.set({ filterUi: { ...this.state.filterUi, date } }); void this.applyFilter(); };
  setPaths = (paths: string[] | null): void => { this.set({ filterUi: { ...this.state.filterUi, paths } }); void this.applyFilter(); };
  setSort = (sort: GraphSortType): void => {
    if (sort === this.state.sort) return;
    this.relayout(this.state.matches, sort, this.anchorHash(), true);
  };
  setScopeRefs = (refs: string[] | null): void => {
    this.set({ scopeRefs: refs && refs.length ? refs : null });
    void this.reload();
  };

  // ───────────── selection actions ─────────────
  selectRowAt = (row: number, mods: { shift: boolean; toggle: boolean }): void => {
    this.set({ selection: selectRow(this.state.selection, row, mods, rowMapOf(this.state.layout)) });
  };
  moveFocus = (row: number, extend: boolean): void => {
    const layout = this.state.layout;
    if (!layout) return;
    const sel = moveFocusTo(this.state.selection, row, extend, layout);
    this.set({ selection: sel, scrollRequest: sel.focus != null ? { row: layout.rowOf(sel.focus), nonce: nonce++ } : this.state.scrollRequest });
  };
  selectAllRows = (): void => { this.set({ selection: selectAll(rowMapOf(this.state.layout)) }); };

  /** Select a commit by snapshot index and scroll to it. Returns false if hidden / not loaded. */
  jumpToCommitIndex = (ci: number | null): boolean => {
    const layout = this.state.layout;
    if (ci == null || !layout) return false;
    const row = layout.rowOf(ci);
    if (row < 0) { this.showToast('info', t('store.hiddenByFilter')); return false; }
    this.set({ selection: selectRow(EMPTY_SELECTION, row, { shift: false, toggle: false }, layout), scrollRequest: { row, nonce: nonce++ } });
    return true;
  };
  jumpToHash = (hash: string): boolean => {
    const i = this.state.snapshot?.hashes.indexOf(hash) ?? -1;
    if (i < 0) { this.showToast('info', t('store.notLoaded')); return false; }
    return this.jumpToCommitIndex(i);
  };

  // ───────────── lazy data ─────────────
  ensureMeta = async (indices: number[]): Promise<void> => {
    const snapshot = this.state.snapshot;
    if (!snapshot) return;
    const epoch = this.epoch;
    const need = indices.filter((i) => i >= 0 && i < snapshot.commitCount && !this.metaCache.has(i) && !this.metaInflight.has(i));
    for (let s = 0; s < need.length; s += META_BATCH) {
      const batch = need.slice(s, s + META_BATCH);
      batch.forEach((i) => this.metaInflight.add(i));
      try {
        const rows = await call('get_commit_rows', { snapshotId: snapshot.snapshotId, indices: batch });
        if (this.stale(epoch) || this.state.snapshot !== snapshot) return;
        rows.forEach((m) => this.metaCache.set(m.index, m));
        batch.forEach((i) => this.metaInflight.delete(i));
        this.metaRetries = 0;
        this.set({ metaVersion: this.state.metaVersion + 1 });
      } catch (e) {
        batch.forEach((i) => this.metaInflight.delete(i));
        if (this.stale(epoch) || this.state.snapshot !== snapshot) return;
        if ((e as AppError).code === 'snapshotExpired') { void this.reload(); return; }
        // Transient failure: toast once, then retry a few times (a version bump re-triggers the visible-range fetch).
        if (!this.metaErrorShown) { this.metaErrorShown = true; this.showError(e); }
        if (this.metaRetries < META_MAX_RETRIES) {
          this.metaRetries++;
          clearTimeout(this.metaRetryTimer);
          this.metaRetryTimer = setTimeout(() => {
            if (!this.stale(epoch) && this.state.snapshot === snapshot) this.set({ metaVersion: this.state.metaVersion + 1 });
          }, 1500 * this.metaRetries);
        }
        return;
      }
    }
  };

  ensureSignatures = async (hashes: string[]): Promise<void> => {
    if (this.disposed) return;
    const epoch = this.epoch;
    const need = hashes.filter((h) => !this.sigRequested.has(h));
    if (!need.length) return;
    need.forEach((h) => this.sigRequested.add(h));
    try {
      const res = await call('get_signatures', { repoPath: this.path, hashes: need });
      if (this.stale(epoch)) return;
      res.forEach((s) => this.sigCache.set(s.hash, s));
      this.set({ sigVersion: this.state.sigVersion + 1 });
    } catch {
      need.forEach((h) => this.sigRequested.delete(h));
    }
  };

  // ───────────── git operations ─────────────
  private async runOp(label: string, fn: (repoPath: string) => Promise<{ message: string }>): Promise<{ ok: true } | { ok: false; error: AppError }> {
    const epoch = this.epoch;
    this.showToast('progress', label);
    try {
      const r = await fn(this.path);
      if (this.stale(epoch)) return { ok: true };
      const msg = r.message.trim().split('\n').pop()?.slice(0, 200) || t('store.done');
      this.showToast('info', msg);
      void this.reload();
      return { ok: true };
    } catch (e) {
      const error = toAppError(e);
      if (!this.stale(epoch)) this.dismissToast();
      return { ok: false, error };
    }
  }

  private failToast(o: { ok: boolean; error?: AppError }): void {
    if (!o.ok && o.error) this.showToast('error', o.error.stderr?.trim().split('\n').slice(-2).join(' ') || o.error.message);
  }

  checkoutRef = (ref: Ref): void => {
    let target: CheckoutTarget;
    if (ref.type === 'localBranch') target = { kind: 'localBranch', name: ref.name };
    else if (ref.type === 'remoteBranch') target = { kind: 'remoteBranch', name: ref.name, localName: null };
    else if (ref.type === 'tag') target = { kind: 'tag', name: ref.name };
    else return;
    void this.runOp(t('store.checkout', { name: ref.name }), (repoPath) => call('checkout', { repoPath, target })).then((o) => this.failToast(o));
  };

  checkoutCommit = (hash: string): void => {
    this.openDialog({
      kind: 'confirm',
      title: t('store.checkoutRev.title'),
      message: t('store.checkoutRev.msg', { hash: hash.slice(0, 10) }),
      confirmLabel: t('common.checkout'),
      onConfirm: () => {
        this.closeDialog();
        void this.runOp(t('store.checkingOut'), (repoPath) => call('checkout', { repoPath, target: { kind: 'commit', hash } })).then((o) => this.failToast(o));
      },
    });
  };

  fetchAll = async (): Promise<void> => {
    this.failToast(await this.runOp(t('store.fetching'), (repoPath) => call('fetch', { repoPath, remote: null })));
  };

  pull = async (mode: PullMode = 'ffOnly'): Promise<void> => {
    const o = await this.runOp(t('store.pulling'), (repoPath) => call('pull', { repoPath, mode }));
    if (o.ok) return;
    if (o.error.code === 'nonFastForward') {
      this.openDialog({
        kind: 'confirm',
        title: t('store.ff.title'),
        message: t('store.ff.msg'),
        confirmLabel: t('common.rebase'),
        onConfirm: () => { this.closeDialog(); void this.pull('rebase'); },
        alt: { label: t('common.merge'), onClick: () => { this.closeDialog(); void this.pull('merge'); } },
      });
    } else this.failToast(o);
  };

  createBranch = async (name: string, startPoint: string, checkout: boolean): Promise<AppError | null> => {
    const o = await this.runOp(t('store.createBranch', { name }), (repoPath) => call('create_branch', { repoPath, name, startPoint, checkout }));
    return o.ok ? null : o.error;
  };

  deleteBranch = (name: string, force = false): void => {
    const run = (f: boolean) =>
      void this.runOp(t('store.deleteBranch', { name }), (repoPath) => call('delete_branch', { repoPath, name, force: f })).then((o) => {
        if (o.ok) return;
        if (o.error.code === 'notFullyMerged' && !f) {
          this.openDialog({
            kind: 'confirm', title: t('store.unmerged.title'), danger: true, confirmLabel: t('store.unmerged.confirm'),
            message: t('store.unmerged.msg', { name }),
            onConfirm: () => { this.closeDialog(); run(true); },
          });
        } else this.failToast(o);
      });
    if (force) { run(true); return; }
    this.openDialog({
      kind: 'confirm', title: t('store.delete.title'), danger: true, confirmLabel: t('common.delete'),
      message: t('store.delete.msg', { name }),
      onConfirm: () => { this.closeDialog(); run(false); },
    });
  };

  toggleFavorite = async (ref: Ref): Promise<void> => {
    const epoch = this.epoch;
    try {
      await call('set_favorite', { repoPath: this.path, fullName: ref.fullName, favorite: !ref.isFavorite });
      if (!this.stale(epoch)) await this.reload();
    } catch (e) { if (!this.stale(epoch)) this.showError(e); }
  };
}
