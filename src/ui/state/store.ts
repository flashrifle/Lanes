import { useSyncExternalStore } from 'react';
import { call, onGitProgress, onRepoChanged, pickFolder, toAppError } from '../../api';
import { buildGraph } from '../../graph';
import type {
  AppError, AuthorInfo, ChangedFile, CheckoutTarget, CommitMeta, GraphLayout, GraphSortType, LogScope,
  LogSnapshot, PullMode, RecentRepo, Ref, RepoInfo, SignatureInfo,
} from '../../types';
import {
  EMPTY_FILTER_UI, EMPTY_SELECTION, buildVisibleMask, captureSelection, isFilterEmpty, moveFocusTo, restoreSelection,
  selectAll, selectRow, toLogFilter, type FilterUi, type RowMap, type Selection, type TextFilterUi,
} from './logic';

export const LOG_LIMIT = 200_000;

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

export interface UiState {
  booting: boolean;
  recents: RecentRepo[];
  repo: RepoInfo | null;
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

let state: UiState = {
  booting: true, recents: [], repo: null, snapshot: null, layout: null, loading: false,
  filterUi: EMPTY_FILTER_UI, filterError: false, scopeRefs: null, sort: 'bek', matches: null, authors: [],
  selection: EMPTY_SELECTION, metaVersion: 0, sigVersion: 0, scrollRequest: null, toast: null, dialog: null, diff: null,
};
const listeners = new Set<() => void>();
function set(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getState(): UiState { return state; }
export function useStore<T>(selector: (s: UiState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ───────────── non-reactive caches ─────────────
const metaCache = new Map<number, CommitMeta>();
const metaInflight = new Set<number>();
const sigCache = new Map<string, SignatureInfo>();
const sigRequested = new Set<string>();
let topCommitIndex: number | null = null;
let nonce = 1;
export const getMeta = (i: number): CommitMeta | undefined => metaCache.get(i);
export const getSignature = (h: string): SignatureInfo | undefined => sigCache.get(h);
export function setTopCommitIndex(i: number | null): void { topCommitIndex = i; }

export function rowMapOf(layout: GraphLayout | null): RowMap {
  return layout ?? { rowCount: 0, commitIndexAt: () => -1, rowOf: () => -1 };
}

// ───────────── toast / dialog ─────────────
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(kind: ToastState['kind'], text: string): void {
  clearTimeout(toastTimer);
  const id = nonce++;
  set({ toast: { id, kind, text } });
  if (kind !== 'progress') {
    toastTimer = setTimeout(() => { if (state.toast?.id === id) set({ toast: null }); }, kind === 'error' ? 10000 : 4000);
  }
}
export function dismissToast(): void { clearTimeout(toastTimer); set({ toast: null }); }
export function showError(e: unknown): void { showToast('error', toAppError(e).message); }
export function openDialog(d: DialogState): void { set({ dialog: d }); }
export function closeDialog(): void { set({ dialog: null }); }
export function openDiff(file: ChangedFile): void { set({ diff: file }); }
export function closeDiff(): void { set({ diff: null }); }

// ───────────── app lifecycle ─────────────
let initialized = false;
export async function initApp(): Promise<void> {
  if (initialized) return;
  initialized = true;
  void onRepoChanged((e) => {
    if (state.repo && e.repoPath === state.repo.path) void reload();
  }).catch(() => {});
  void onGitProgress((e) => {
    if (state.repo && e.repoPath === state.repo.path && state.toast?.kind === 'progress') {
      const line = e.line.trim();
      if (line) set({ toast: { ...state.toast, text: line } });
    }
  }).catch(() => {});
  let recents: RecentRepo[] = [];
  try { recents = await call('get_recent_repos', {}); } catch { /* not running in Tauri */ }
  set({ recents });
  const first = recents.find((r) => r.exists);
  if (first) await openRepo(first.path, true);
  set({ booting: false });
}

export async function refreshRecents(): Promise<void> {
  try { set({ recents: await call('get_recent_repos', {}) }); } catch { /* ignore */ }
}
export async function removeRecent(path: string): Promise<void> {
  try { await call('remove_recent_repo', { path }); } catch (e) { showError(e); }
  await refreshRecents();
}
export async function chooseAndOpenRepo(): Promise<void> {
  try {
    const p = await pickFolder();
    if (p) await openRepo(p);
  } catch (e) { showError(e); }
}

export async function openRepo(path: string, silent = false): Promise<void> {
  try {
    const info = await call('open_repo', { path });
    if (state.repo && state.repo.path !== info.path) await closeRepo();
    metaCache.clear(); metaInflight.clear(); sigCache.clear(); sigRequested.clear();
    set({
      repo: info, snapshot: null, layout: null, filterUi: EMPTY_FILTER_UI, filterError: false, scopeRefs: null,
      matches: null, authors: [], selection: EMPTY_SELECTION, diff: null, dialog: null,
    });
    await reload();
  } catch (e) {
    if (!silent) showError(e);
  }
}

export async function closeRepo(): Promise<void> {
  const { repo, snapshot } = state;
  if (snapshot) void call('release_snapshot', { snapshotId: snapshot.snapshotId }).catch(() => {});
  if (repo) void call('close_repo', { repoPath: repo.path }).catch(() => {});
  set({ repo: null, snapshot: null, layout: null, matches: null, selection: EMPTY_SELECTION, diff: null, dialog: null });
  await refreshRecents();
}

// ───────────── loading ─────────────
let reloading = false;
let dirty = false;
let filterToken = 0;

function layoutFor(snapshot: LogSnapshot, matches: number[] | null, sort: GraphSortType): GraphLayout {
  return buildGraph(snapshot, { sortType: sort, visible: buildVisibleMask(snapshot.commitCount, matches), collapseLongEdges: true });
}

function anchorHash(): string | null {
  const { snapshot, selection, layout } = state;
  if (!snapshot || !layout) return null;
  if (selection.focus != null && layout.rowOf(selection.focus) >= 0) return snapshot.hashes[selection.focus] ?? null;
  return topCommitIndex != null ? snapshot.hashes[topCommitIndex] ?? null : null;
}

/** Single-flight full reload (refs + log + filter + layout). Events arriving mid-flight set a dirty flag. */
export async function reload(): Promise<void> {
  const repo = state.repo;
  if (!repo) return;
  if (reloading) { dirty = true; return; }
  reloading = true;
  set({ loading: true });
  try {
    do {
      dirty = false;
      await loadOnce(repo.path);
    } while (dirty && state.repo?.path === repo.path);
  } catch (e) {
    showError(e);
  } finally {
    reloading = false;
    set({ loading: false });
  }
}

async function loadOnce(repoPath: string): Promise<void> {
  const savedSel = state.snapshot ? captureSelection(state.selection, state.snapshot.hashes) : null;
  const savedAnchor = anchorHash();
  const old = state.snapshot;
  const scope = (refs: string[] | null): LogScope => ({ refs, limit: LOG_LIMIT });
  let snapshot: LogSnapshot;
  let scopeRefs = state.scopeRefs;
  try {
    snapshot = await call('load_log', { repoPath, scope: scope(scopeRefs) });
  } catch (e) {
    if (scopeRefs && (e as AppError).code === 'invalidArgument') {
      scopeRefs = null;
      snapshot = await call('load_log', { repoPath, scope: scope(null) });
    } else throw e;
  }
  if (state.repo?.path !== repoPath) {
    void call('release_snapshot', { snapshotId: snapshot.snapshotId }).catch(() => {});
    return;
  }
  if (old) void call('release_snapshot', { snapshotId: old.snapshotId }).catch(() => {});

  const filter = toLogFilter(state.filterUi);
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
  const layout = layoutFor(snapshot, matches, state.sort);
  const h2i = new Map<string, number>();
  snapshot.hashes.forEach((h, i) => h2i.set(h, i));
  const selection = savedSel ? restoreSelection(savedSel, h2i) : EMPTY_SELECTION;
  metaCache.clear(); metaInflight.clear();
  topCommitIndex = null;
  let scrollRequest = state.scrollRequest;
  const ai = savedAnchor ? h2i.get(savedAnchor) : undefined;
  if (ai !== undefined && layout.rowOf(ai) >= 0) scrollRequest = { row: layout.rowOf(ai), nonce: nonce++ };
  set({ snapshot, layout, matches, filterError, scopeRefs, selection, scrollRequest, metaVersion: state.metaVersion + 1 });
  void call('get_authors', { snapshotId: snapshot.snapshotId })
    .then((authors) => { if (state.snapshot?.snapshotId === snapshot.snapshotId) set({ authors }); })
    .catch(() => {});
}

/** Re-run filter_commits + layout for the current snapshot (cheap path, no log reload). */
async function applyFilter(): Promise<void> {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const token = ++filterToken;
  const filter = toLogFilter(state.filterUi);
  const anchor = anchorHash();
  let matches: number[] | null = null;
  let filterError = false;
  if (!isFilterEmpty(filter)) {
    try {
      matches = (await call('filter_commits', { snapshotId: snapshot.snapshotId, filter })).matches;
    } catch (e) {
      const err = e as AppError;
      if (err.code === 'snapshotExpired') { void reload(); return; }
      if (err.code !== 'invalidArgument') { showError(e); return; }
      filterError = true;
    }
  }
  if (token !== filterToken || state.snapshot !== snapshot) return;
  if (filterError) { set({ filterError: true }); return; }
  relayout(matches, state.sort, anchor, false);
}

function relayout(matches: number[] | null, sort: GraphSortType, anchor: string | null, keepMatches: boolean): void {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const m = keepMatches ? state.matches : matches;
  const layout = layoutFor(snapshot, m, sort);
  let scrollRequest = state.scrollRequest;
  if (anchor) {
    const idx = snapshot.hashes.indexOf(anchor);
    if (idx >= 0 && layout.rowOf(idx) >= 0) scrollRequest = { row: layout.rowOf(idx), nonce: nonce++ };
  }
  topCommitIndex = null;
  set({ layout, matches: m, filterError: false, sort, scrollRequest, metaVersion: state.metaVersion + 1 });
}

// ───────────── filter actions ─────────────
export function setTextFilter(text: TextFilterUi): void {
  set({ filterUi: { ...state.filterUi, text } });
  void applyFilter();
}
export function setUsers(users: string[] | null): void {
  set({ filterUi: { ...state.filterUi, users } });
  void applyFilter();
}
export function setDateRange(date: FilterUi['date']): void {
  set({ filterUi: { ...state.filterUi, date } });
  void applyFilter();
}
export function setPaths(paths: string[] | null): void {
  set({ filterUi: { ...state.filterUi, paths } });
  void applyFilter();
}
export function setSort(sort: GraphSortType): void {
  if (sort === state.sort) return;
  relayout(state.matches, sort, anchorHash(), true);
}
export function setScopeRefs(refs: string[] | null): void {
  set({ scopeRefs: refs && refs.length ? refs : null });
  void reload();
}

// ───────────── selection actions ─────────────
export function selectRowAt(row: number, mods: { shift: boolean; toggle: boolean }): void {
  set({ selection: selectRow(state.selection, row, mods, rowMapOf(state.layout)) });
}
export function moveFocus(row: number, extend: boolean): void {
  const layout = state.layout;
  if (!layout) return;
  const sel = moveFocusTo(state.selection, row, extend, layout);
  set({ selection: sel, scrollRequest: sel.focus != null ? { row: layout.rowOf(sel.focus), nonce: nonce++ } : state.scrollRequest });
}
export function selectAllRows(): void { set({ selection: selectAll(rowMapOf(state.layout)) }); }

/** Select a commit by snapshot index and scroll to it. Returns false if hidden / not loaded. */
export function jumpToCommitIndex(ci: number | null): boolean {
  const layout = state.layout;
  if (ci == null || !layout) return false;
  const row = layout.rowOf(ci);
  if (row < 0) { showToast('info', '현재 필터에서 보이지 않는 커밋입니다'); return false; }
  set({ selection: selectRow(EMPTY_SELECTION, row, { shift: false, toggle: false }, layout), scrollRequest: { row, nonce: nonce++ } });
  return true;
}
export function jumpToHash(hash: string): boolean {
  const i = state.snapshot?.hashes.indexOf(hash) ?? -1;
  if (i < 0) { showToast('info', '로드된 로그에 없는 커밋입니다'); return false; }
  return jumpToCommitIndex(i);
}

// ───────────── lazy data ─────────────
export async function ensureMeta(indices: number[]): Promise<void> {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const need = indices.filter((i) => i >= 0 && i < snapshot.commitCount && !metaCache.has(i) && !metaInflight.has(i));
  for (let s = 0; s < need.length; s += 500) {
    const batch = need.slice(s, s + 500);
    batch.forEach((i) => metaInflight.add(i));
    try {
      const rows = await call('get_commit_rows', { snapshotId: snapshot.snapshotId, indices: batch });
      if (state.snapshot !== snapshot) return;
      rows.forEach((m) => metaCache.set(m.index, m));
      batch.forEach((i) => metaInflight.delete(i));
      set({ metaVersion: state.metaVersion + 1 });
    } catch (e) {
      batch.forEach((i) => metaInflight.delete(i));
      if ((e as AppError).code === 'snapshotExpired' && state.snapshot === snapshot) void reload();
      return;
    }
  }
}

export async function ensureSignatures(hashes: string[]): Promise<void> {
  const repo = state.repo;
  if (!repo) return;
  const need = hashes.filter((h) => !sigRequested.has(h));
  if (!need.length) return;
  need.forEach((h) => sigRequested.add(h));
  try {
    const res = await call('get_signatures', { repoPath: repo.path, hashes: need });
    res.forEach((s) => sigCache.set(s.hash, s));
    set({ sigVersion: state.sigVersion + 1 });
  } catch {
    need.forEach((h) => sigRequested.delete(h));
  }
}

// ───────────── git operations ─────────────
type OpOutcome = { ok: true } | { ok: false; error: AppError };

async function runOp(label: string, fn: (repoPath: string) => Promise<{ message: string }>): Promise<OpOutcome> {
  const repo = state.repo;
  if (!repo) return { ok: false, error: { code: 'internal', message: 'no repo', stderr: null } };
  showToast('progress', label);
  try {
    const r = await fn(repo.path);
    const msg = r.message.trim().split('\n').pop()?.slice(0, 200) || '완료';
    showToast('info', msg);
    void reload();
    return { ok: true };
  } catch (e) {
    const error = toAppError(e);
    dismissToast();
    return { ok: false, error };
  }
}

function failToast(o: OpOutcome): void {
  if (!o.ok) showToast('error', o.error.stderr?.trim().split('\n').slice(-2).join(' ') || o.error.message);
}

export function checkoutRef(ref: Ref): void {
  let target: CheckoutTarget;
  if (ref.type === 'localBranch') target = { kind: 'localBranch', name: ref.name };
  else if (ref.type === 'remoteBranch') target = { kind: 'remoteBranch', name: ref.name, localName: null };
  else if (ref.type === 'tag') target = { kind: 'tag', name: ref.name };
  else return;
  void runOp(`체크아웃: ${ref.name}`, (repoPath) => call('checkout', { repoPath, target })).then(failToast);
}

export function checkoutCommit(hash: string): void {
  openDialog({
    kind: 'confirm',
    title: '리비전 체크아웃',
    message: `${hash.slice(0, 10)} 커밋을 체크아웃하면 HEAD가 분리(detached)됩니다. 계속하시겠습니까?`,
    confirmLabel: '체크아웃',
    onConfirm: () => {
      closeDialog();
      void runOp('체크아웃…', (repoPath) => call('checkout', { repoPath, target: { kind: 'commit', hash } })).then(failToast);
    },
  });
}

export async function fetchAll(): Promise<void> {
  failToast(await runOp('가져오는 중…', (repoPath) => call('fetch', { repoPath, remote: null })));
}

export async function pull(mode: PullMode = 'ffOnly'): Promise<void> {
  const o = await runOp('풀 중…', (repoPath) => call('pull', { repoPath, mode }));
  if (o.ok) return;
  if (o.error.code === 'nonFastForward') {
    openDialog({
      kind: 'confirm',
      title: '빨리 감기 불가',
      message: '로컬 브랜치와 리모트가 갈라졌습니다. 어떻게 통합하시겠습니까?',
      confirmLabel: '리베이스',
      onConfirm: () => { closeDialog(); void pull('rebase'); },
      alt: { label: '병합', onClick: () => { closeDialog(); void pull('merge'); } },
    });
  } else failToast(o);
}

export async function createBranch(name: string, startPoint: string, checkout: boolean): Promise<AppError | null> {
  const o = await runOp(`브랜치 생성: ${name}`, (repoPath) => call('create_branch', { repoPath, name, startPoint, checkout }));
  return o.ok ? null : o.error;
}

export function deleteBranch(name: string, force = false): void {
  const run = (f: boolean) =>
    void runOp(`브랜치 삭제: ${name}`, (repoPath) => call('delete_branch', { repoPath, name, force: f })).then((o) => {
      if (o.ok) return;
      if (o.error.code === 'notFullyMerged' && !f) {
        openDialog({
          kind: 'confirm', title: '병합되지 않은 브랜치', danger: true, confirmLabel: '강제 삭제',
          message: `'${name}' 브랜치에 병합되지 않은 커밋이 있습니다. 강제로 삭제하시겠습니까?`,
          onConfirm: () => { closeDialog(); run(true); },
        });
      } else failToast(o);
    });
  if (force) { run(true); return; }
  openDialog({
    kind: 'confirm', title: '브랜치 삭제', danger: true, confirmLabel: '삭제',
    message: `'${name}' 브랜치를 삭제하시겠습니까?`,
    onConfirm: () => { closeDialog(); run(false); },
  });
}

export async function toggleFavorite(ref: Ref): Promise<void> {
  const repo = state.repo;
  if (!repo) return;
  try {
    await call('set_favorite', { repoPath: repo.path, fullName: ref.fullName, favorite: !ref.isFavorite });
    await reload();
  } catch (e) { showError(e); }
}
