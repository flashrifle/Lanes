// App settings mirror (backend owns state.json). One module store per window; every window keeps it fresh
// through the `settings-changed` event. Pure of React except the `useSettings` hook. Owned by ui-app.
import { useSyncExternalStore } from 'react';
import { call, onEvent } from '../../api';
import { EVENT_SETTINGS_CHANGED, type AppSettings } from '../../types';

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'system',
  density: 'comfortable',
  gitPath: null,
  dateFormat: 'relative',
  externalEditor: null,
  checkForUpdates: true,
  menuBarIcon: true,
  keepRunningInMenuBar: true,
  backgroundFetchMinutes: null,
};

const FETCH_MINUTES = [15, 30, 60];

/** Coerce an untrusted payload into a complete AppSettings (unknown/invalid fields fall back to defaults). */
export function normalizeSettings(v: unknown): AppSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' ? x : null);
  const bool = (x: unknown, def: boolean): boolean => (typeof x === 'boolean' ? x : def);
  return {
    language: o.language === 'ko' || o.language === 'en' || o.language === 'system' ? o.language : d.language,
    density: o.density === 'compact' || o.density === 'comfortable' ? o.density : d.density,
    gitPath: str(o.gitPath),
    dateFormat: o.dateFormat === 'absolute' || o.dateFormat === 'relative' ? o.dateFormat : d.dateFormat,
    externalEditor: str(o.externalEditor),
    checkForUpdates: bool(o.checkForUpdates, d.checkForUpdates),
    menuBarIcon: bool(o.menuBarIcon, d.menuBarIcon),
    keepRunningInMenuBar: bool(o.keepRunningInMenuBar, d.keepRunningInMenuBar),
    backgroundFetchMinutes:
      typeof o.backgroundFetchMinutes === 'number' && FETCH_MINUTES.includes(o.backgroundFetchMinutes) ? o.backgroundFetchMinutes : null,
  };
}

let current: AppSettings = DEFAULT_SETTINGS;
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: AppSettings): void {
  if (JSON.stringify(next) === JSON.stringify(current) && loaded) return;
  current = next;
  loaded = true;
  listeners.forEach((l) => l());
}

export const getSettings = (): AppSettings => current;
export const settingsLoaded = (): boolean => loaded;

export function subscribeSettings(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useSettings(): AppSettings {
  return useSyncExternalStore(subscribeSettings, getSettings);
}

/** Fetch from the backend; on failure the defaults stay in place. */
export async function loadSettings(): Promise<AppSettings> {
  try {
    publish(normalizeSettings(await call('get_settings', {})));
  } catch { /* keep defaults / last known */ }
  return current;
}

/**
 * Optimistically apply `patch`, persist the merged value, adopt what the backend stored.
 * On failure the previous value is restored and the error is rethrown.
 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const prev = current;
  const next = normalizeSettings({ ...prev, ...patch });
  publish(next);
  try {
    const stored = normalizeSettings(await call('set_settings', { settings: next }));
    publish(stored);
    return stored;
  } catch (e) {
    publish(prev);
    throw e;
  }
}

let syncStarted = false;
/** Subscribe to `settings-changed` (idempotent). Call once per window. */
export function startSettingsSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  onEvent<unknown>(EVENT_SETTINGS_CHANGED, (p) => publish(normalizeSettings(p))).catch(() => { syncStarted = false; });
}

/** Test hook. */
export function __resetSettingsForTests(): void {
  current = DEFAULT_SETTINGS;
  loaded = false;
  syncStarted = false;
  listeners.clear();
}
