import { call, onGitProgress, onRepoChanged, pickFolder, toAppError } from '../../api';
import type { RecentRepo } from '../../types';
import {
  TABS_STORAGE_KEY, addTab, closeTabModel, cycleTab, findTabByPath, parseTabs, serializeTabs, tabForShortcut,
  type TabLike,
} from '../tabs/tabs';
import { Store, useStoreState } from './createStore';
import { RepoStore, type ToastState } from './repoStore';

export interface TabEntry extends TabLike {
  name: string;
  /** Monotonic generation: a closed-and-reopened path gets a new gen, so late results for the old tab are detectable. */
  gen: number;
  store: RepoStore;
}

export interface AppState {
  booting: boolean;
  recents: RecentRepo[];
  tabs: TabEntry[];
  activeId: number | null;
  toast: ToastState | null;
}

let nextTabId = 1;
let nextGen = 1;
let toastId = 1;

class AppStore extends Store<AppState> {
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** Opens in flight, keyed by the requested path (dedupes double clicks / restore + recent). */
  private opening = new Map<string, Promise<void>>();
  /** close_repo calls in flight, keyed by repo path; a reopen waits for them so open can't be overtaken by close. */
  private closing = new Map<string, Promise<void>>();
  private initialized = false;

  constructor() {
    super({ booting: true, recents: [], tabs: [], activeId: null, toast: null });
    this.subscribe(() => this.persist());
  }

  private persistReady = false;
  private persist(): void {
    if (!this.persistReady) return;
    try { localStorage.setItem(TABS_STORAGE_KEY, serializeTabs(this.state.tabs, this.state.activeId)); } catch { /* ignore */ }
  }

  // ───────────── toast ─────────────
  showToast = (kind: ToastState['kind'], text: string): void => {
    clearTimeout(this.toastTimer);
    const id = toastId++;
    this.set({ toast: { id, kind, text } });
    if (kind !== 'progress') this.toastTimer = setTimeout(() => { if (this.state.toast?.id === id) this.set({ toast: null }); }, kind === 'error' ? 10000 : 4000);
  };
  dismissToast = (): void => { clearTimeout(this.toastTimer); this.set({ toast: null }); };

  activeStore(): RepoStore | null {
    const { tabs, activeId } = this.state;
    return tabs.find((t) => t.id === activeId)?.store ?? null;
  }

  // ───────────── lifecycle ─────────────
  init = async (): Promise<void> => {
    if (this.initialized) return;
    this.initialized = true;
    void onRepoChanged((e) => {
      const tab = findTabByPath(this.state.tabs, e.repoPath);
      if (tab) void tab.store.reload();
    }).catch(() => {});
    void onGitProgress((e) => {
      const tab = findTabByPath(this.state.tabs, e.repoPath);
      if (tab) tab.store.onProgress(e.line);
    }).catch(() => {});

    let recents: RecentRepo[] = [];
    try { recents = await call('get_recent_repos', {}); } catch { /* not running in Tauri */ }
    this.set({ recents });

    let saved = { paths: [] as string[], active: null as string | null };
    try { saved = parseTabs(localStorage.getItem(TABS_STORAGE_KEY)); } catch { /* ignore */ }

    if (saved.paths.length === 0) {
      const first = recents.find((r) => r.exists);
      if (first) await this.openRepo(first.path, { silent: true });
    } else {
      await this.restore(saved.paths, saved.active);
    }
    this.persistReady = true;
    this.persist();
    this.set({ booting: false });
  };

  /** Re-open persisted tabs in order. Missing / invalid paths are skipped. Active tab loads first; others in the background. */
  private async restore(paths: string[], active: string | null): Promise<void> {
    const order = active && paths.includes(active) ? [active, ...paths.filter((p) => p !== active)] : paths;
    const infos = await Promise.all(order.map((p) => call('open_repo', { path: p }).catch(() => null)));
    // Build tabs in persisted order (not open order) without loading yet.
    const byPath = new Map<string, NonNullable<(typeof infos)[number]>>();
    order.forEach((p, i) => { const info = infos[i]; if (info) byPath.set(p, info); });
    const seen = new Set<string>();
    const ordered: TabEntry[] = [];
    for (const p of paths) {
      const info = byPath.get(p);
      if (!info || seen.has(info.path)) continue;
      seen.add(info.path);
      const gen = nextGen++;
      ordered.push({ id: nextTabId++, path: info.path, name: info.name, gen, store: new RepoStore(info, gen) });
    }
    if (ordered.length === 0) return;
    const activeTab = (active && ordered.find((t) => t.path === byPath.get(active)?.path)) || ordered[0];
    this.set({ tabs: ordered, activeId: activeTab.id });
    await activeTab.store.reload();
    void (async () => {
      for (const t of ordered) if (t !== activeTab && !t.store.isDisposed) await t.store.reload();
    })();
  }

  refreshRecents = async (): Promise<void> => {
    try { this.set({ recents: await call('get_recent_repos', {}) }); } catch { /* ignore */ }
  };
  removeRecent = async (path: string): Promise<void> => {
    try { await call('remove_recent_repo', { path }); } catch (e) { this.showToast('error', toAppError(e).message); }
    await this.refreshRecents();
  };

  chooseAndOpenRepo = async (): Promise<void> => {
    try {
      const p = await pickFolder();
      if (p) await this.openRepo(p);
    } catch (e) { this.showToast('error', toAppError(e).message); }
  };

  /** Open `path` in a new tab, or switch to its tab when already open. */
  openRepo = (path: string, opts: { silent?: boolean } = {}): Promise<void> => {
    const existing = this.state.tabs.find((t) => t.path === path);
    if (existing) { this.activate(existing.id); return Promise.resolve(); }
    const inflight = this.opening.get(path);
    if (inflight) return inflight;
    const p = this.doOpen(path, !!opts.silent).finally(() => { this.opening.delete(path); });
    this.opening.set(path, p);
    return p;
  };

  private async doOpen(path: string, silent: boolean): Promise<void> {
    try {
      const pendingClose = this.closing.get(path);
      if (pendingClose) await pendingClose;
      const info = await call('open_repo', { path });
      // The picked folder may be a subfolder of an already-open repo.
      const dup = findTabByPath(this.state.tabs, info.path);
      if (dup) { this.activate(dup.id); return; }
      const pendingClose2 = this.closing.get(info.path);
      if (pendingClose2) await pendingClose2;
      const gen = nextGen++;
      const store = new RepoStore(info, gen);
      const tab: TabEntry = { id: nextTabId++, path: info.path, name: info.name, gen, store };
      const m = addTab({ tabs: this.state.tabs, activeId: this.state.activeId }, tab);
      this.set(m);
      void this.refreshRecents();
      await store.reload();
    } catch (e) {
      if (!silent) this.showToast('error', toAppError(e).message);
    }
  }

  activate = (id: number): void => {
    if (this.state.activeId === id || !this.state.tabs.some((t) => t.id === id)) return;
    this.set({ activeId: id });
  };

  activateByShortcut = (n: number): void => {
    const t = tabForShortcut(this.state.tabs, n);
    if (t) this.activate(t.id);
  };

  cycle = (dir: 1 | -1): void => {
    const id = cycleTab({ tabs: this.state.tabs, activeId: this.state.activeId }, dir);
    if (id != null) this.activate(id);
  };

  closeTab = (id: number): void => {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab) return;
    const m = closeTabModel({ tabs: this.state.tabs, activeId: this.state.activeId }, id);
    this.set(m);
    tab.store.dispose(); // releases the snapshot, invalidates in-flight async work
    const p = call('close_repo', { repoPath: tab.path }).then(() => {}, () => {}).finally(() => {
      if (this.closing.get(tab.path) === p) this.closing.delete(tab.path);
    });
    this.closing.set(tab.path, p);
    void this.refreshRecents();
  };

  closeActive = (): void => { if (this.state.activeId != null) this.closeTab(this.state.activeId); };
  reloadActive = (): void => { void this.activeStore()?.reload(); };
}

export const appStore = new AppStore();
export function useApp<T>(selector: (s: AppState) => T): T { return useStoreState(appStore, selector); }
