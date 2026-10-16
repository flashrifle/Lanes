import { call } from '../api';
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

export function setLang(l: Lang): void {
  lang = l;
  locale = l === 'ko' ? 'ko-KR' : 'en-US';
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

/** Look up a message; entries may be plain strings or functions of `params`. */
export function t(key: Key, params: Params = {}): string {
  const e = dicts[lang][key];
  return typeof e === 'function' ? e(params) : e;
}

/** Format a number for the current language. */
export const fmtNum = (v: number): string => v.toLocaleString(locale);

/**
 * Resolve the language once before first render: system locale from the backend, then
 * `navigator.language`, then English. Never blocks startup longer than `timeoutMs`.
 */
export async function initI18n(timeoutMs = 300): Promise<Lang> {
  let loc: string | null = null;
  try {
    loc = await Promise.race([
      call('get_system_locale', {}),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch { /* fall through to navigator */ }
  if (!loc && typeof navigator !== 'undefined') loc = navigator.language || null;
  setLang(resolveLang(loc));
  return lang;
}
