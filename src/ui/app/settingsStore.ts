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
/** Last value the backend confirmed (load, save response, settings-changed). Failed saves revert to it. */
let confirmed: AppSettings = DEFAULT_SETTINGS;
let loaded = false;
/** Fields with an optimistic value not confirmed yet → seq of the latest save that set them. */
const pendingFields = new Map<keyof AppSettings, number>();
let saveSeq = 0;
let saveChain: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function publish(next: AppSettings): void {
  if (JSON.stringify(next) === JSON.stringify(current) && loaded) return;
  current = next;
  loaded = true;
  listeners.forEach((l) => l());
}

/** Adopt a backend value, keeping fields that a queued / running save has not confirmed yet. */
function adoptConfirmed(value: AppSettings): void {
  confirmed = value;
  const next = { ...value } as Record<keyof AppSettings, unknown>;
  for (const k of pendingFields.keys()) next[k] = current[k];
  publish(normalizeSettings(next));
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
    adoptConfirmed(normalizeSettings(await call('get_settings', {})));
  } catch { /* keep defaults / last known */ }
  return current;
}

/**
 * Optimistically apply `patch`, then persist. Saves are serialized (one set_settings at a time, each sending the
 * value current at its turn). A response never overwrites fields that a later save changed optimistically, and a
 * failed save reverts only its own fields (unless a later save set them again), then rethrows.
 */
export function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const seq = ++saveSeq;
  const keys = Object.keys(patch) as (keyof AppSettings)[];
  for (const k of keys) pendingFields.set(k, seq);
  publish(normalizeSettings({ ...current, ...patch }));
  const mine = () => keys.filter((k) => pendingFields.get(k) === seq);
  const run = async (): Promise<AppSettings> => {
    try {
      const stored = normalizeSettings(await call('set_settings', { settings: current }));
      for (const k of mine()) pendingFields.delete(k);
      adoptConfirmed(stored);
      return current;
    } catch (e) {
      const revert = {} as Record<keyof AppSettings, unknown>;
      for (const k of mine()) { revert[k] = confirmed[k]; pendingFields.delete(k); }
      publish(normalizeSettings({ ...current, ...revert }));
      throw e;
    }
  };
  const p = saveChain.then(run, run);
  saveChain = p.catch(() => {});
  return p;
}

let syncStarted = false;
/** Subscribe to `settings-changed` (idempotent). Call once per window. */
export function startSettingsSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  onEvent<unknown>(EVENT_SETTINGS_CHANGED, (p) => adoptConfirmed(normalizeSettings(p))).catch(() => { syncStarted = false; });
}

/** Test hook. */
export function __resetSettingsForTests(): void {
  current = DEFAULT_SETTINGS;
  confirmed = DEFAULT_SETTINGS;
  pendingFields.clear();
  saveSeq = 0;
  saveChain = Promise.resolve();
  loaded = false;
  syncStarted = false;
  listeners.clear();
}
