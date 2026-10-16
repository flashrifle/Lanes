// Pure tab-list logic (no DOM / Tauri). Generic over the tab entry so the app store can attach a RepoStore.
export interface TabLike { id: number; path: string }

export interface TabsModel<T extends TabLike> { tabs: T[]; activeId: number | null }

export function findTabByPath<T extends TabLike>(tabs: readonly T[], path: string): T | undefined {
  return tabs.find((t) => t.path === path);
}

/** Append a tab and make it active. If the path is already open, just activate the existing tab. */
export function addTab<T extends TabLike>(m: TabsModel<T>, tab: T): TabsModel<T> {
  const existing = findTabByPath(m.tabs, tab.path);
  if (existing) return { tabs: m.tabs, activeId: existing.id };
  return { tabs: [...m.tabs, tab], activeId: tab.id };
}

/** Close a tab. Closing the active tab activates its right neighbour (else the left one). */
export function closeTabModel<T extends TabLike>(m: TabsModel<T>, id: number): TabsModel<T> {
  const idx = m.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return m;
  const tabs = m.tabs.filter((t) => t.id !== id);
  if (m.activeId !== id) return { tabs, activeId: m.activeId };
  const next = tabs[idx] ?? tabs[idx - 1] ?? null;
  return { tabs, activeId: next ? next.id : null };
}

/** dir=+1 next / -1 previous, wrapping. */
export function cycleTab<T extends TabLike>(m: TabsModel<T>, dir: 1 | -1): number | null {
  if (m.tabs.length === 0) return null;
  const idx = m.tabs.findIndex((t) => t.id === m.activeId);
  const next = idx < 0 ? 0 : (idx + dir + m.tabs.length) % m.tabs.length;
  return m.tabs[next].id;
}

/** Cmd+1..8 → n-th tab; Cmd+9 → last tab (browser convention). `n` is 1-based. */
export function tabForShortcut<T extends TabLike>(tabs: readonly T[], n: number): T | undefined {
  if (n < 1 || tabs.length === 0) return undefined;
  if (n === 9) return tabs[tabs.length - 1];
  return tabs[n - 1];
}

/** Labels = repo name; when two tabs share a name, append the parent directory. */
export function tabLabels(tabs: readonly { id: number; name: string; path: string }[]): Map<number, string> {
  const count = new Map<string, number>();
  tabs.forEach((t) => count.set(t.name, (count.get(t.name) ?? 0) + 1));
  const out = new Map<number, string>();
  for (const t of tabs) {
    if ((count.get(t.name) ?? 0) > 1) {
      const parts = t.path.split(/[\\/]/).filter(Boolean);
      const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
      out.set(t.id, parent ? `${t.name} — ${parent}` : t.name);
    } else out.set(t.id, t.name);
  }
  return out;
}

// ───────────── persistence ─────────────
export interface PersistedTabs { paths: string[]; active: string | null }
export const TABS_STORAGE_KEY = 'tabs:v1';

export function serializeTabs(tabs: readonly TabLike[], activeId: number | null): string {
  const active = tabs.find((t) => t.id === activeId)?.path ?? null;
  return JSON.stringify({ paths: tabs.map((t) => t.path), active } satisfies PersistedTabs);
}

export function parseTabs(raw: string | null): PersistedTabs {
  const empty: PersistedTabs = { paths: [], active: null };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return empty;
    const o = v as Record<string, unknown>;
    const paths = Array.isArray(o.paths) ? [...new Set(o.paths.filter((p): p is string => typeof p === 'string' && p !== ''))] : [];
    const active = typeof o.active === 'string' && paths.includes(o.active) ? o.active : null;
    return { paths, active };
  } catch { return empty; }
}
