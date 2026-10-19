import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { call } from '../api';
import { getSettings, loadSettings, startSettingsSync, subscribeSettings } from '../ui/app/settingsStore';
import type { LanguageSetting } from '../types';
import { en } from './en';
import { ko, type Entry, type Key, type Params } from './ko';

export type Lang = 'ko' | 'en';
export type { Key, Params };

const dicts: Record<Lang, Record<Key, Entry>> = { ko, en };

/** Current UI language (live binding). Defaults to Korean until `initI18n()` resolves it. */
export let lang: Lang = 'ko';
/** BCP-47 tag matching `lang`, for Intl / toLocaleString. */
export let locale = 'ko-KR';

/** Same rule as the native menu (src-tauri/src/menu.rs): "ko*" -> Korean, anything else -> English. */
export function resolveLang(loc: string | null | undefined): Lang {
  return loc && /^ko/i.test(loc.trim()) ? 'ko' : 'en';
}

const langListeners = new Set<() => void>();

export function setLang(l: Lang): void {
  const changed = lang !== l;
  lang = l;
  locale = l === 'ko' ? 'ko-KR' : 'en-US';
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  if (changed) langListeners.forEach((f) => f());
}

/** Resolve the `settings.language` choice: explicit ko/en wins, "system" follows the OS locale. */
export function resolveLanguageSetting(setting: LanguageSetting | null | undefined, systemLocale: string | null | undefined): Lang {
  return setting === 'ko' || setting === 'en' ? setting : resolveLang(systemLocale);
}

export const subscribeLang = (l: () => void): (() => void) => {
  langListeners.add(l);
  return () => { langListeners.delete(l); };
};

/** Re-renders the calling component when the UI language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, () => lang);
}

/**
 * Root wrapper: remounts its subtree when the language changes, so every `t()` call in already-mounted
 * components picks up the new value. Module stores survive the remount. The date format does not remount:
 * date text follows it live (`CommitDate` / `useDateFormat` in src/ui/format/CommitDate.tsx).
 */
export function LangRoot({ children }: { children?: ReactNode }) {
  const l = useLang();
  return createElement(Fragment, { key: l }, children);
}

/** Look up a message; entries may be plain strings or functions of `params`. */
export function t(key: Key, params: Params = {}): string {
  const e = dicts[lang][key];
  return typeof e === 'function' ? e(params) : e;
}

/** Format a number for the current language. */
export const fmtNum = (v: number): string => v.toLocaleString(locale);

let systemLocale: string | null = null;

/**
 * Resolve the language once before first render: `settings.language` (ko/en) wins, otherwise the system
 * locale from the backend, then `navigator.language`, then English. Never blocks startup longer than
 * `timeoutMs`. Afterwards follows `settings-changed` live (see `LangRoot` / `useLang`).
 */
export async function initI18n(timeoutMs = 300): Promise<Lang> {
  const timeout = <T,>(v: T) => new Promise<T>((resolve) => setTimeout(() => resolve(v), timeoutMs));
  const [loc] = await Promise.all([
    Promise.race([call('get_system_locale', {}), timeout<null>(null)]).catch(() => null),
    Promise.race([loadSettings(), timeout(null)]).catch(() => null),
  ]);
  systemLocale = loc || (typeof navigator !== 'undefined' ? navigator.language || null : null);
  setLang(resolveLanguageSetting(getSettings().language, systemLocale));
  startSettingsSync();
  subscribeSettings(() => setLang(resolveLanguageSetting(getSettings().language, systemLocale)));
  return lang;
}
