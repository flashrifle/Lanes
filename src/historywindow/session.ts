// File History window session hand-off (same scheme as src/diffwindow/session.ts): localStorage carries the
// payload, a Tauri event re-targets the single shared history window.
import { emitTo } from '@tauri-apps/api/event';
import { getAllWebviewWindows, WebviewWindow } from '@tauri-apps/api/webviewWindow';

export interface HistorySession {
  repoPath: string;
  repoName: string;
  path: string;          // repo-relative file path
  rev: string | null;    // history start revision; null = HEAD
  selectHash?: string;   // commit to select once the history is loaded
}

export const HISTORY_WINDOW_LABEL_PREFIX = 'history-';
export const EVENT_HISTORY_SESSION_UPDATE = 'history-session-update';
export interface HistorySessionUpdateEvent {
  id: string;
}

const KEY_PREFIX = 'history-session:';
const LATEST_KEY = 'history-session-latest';
const KEEP = 8;

/** Minimal Storage surface (so tests can pass a fake). */
export type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function defaultStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Validates an untrusted (parsed JSON) payload. */
export function parseHistorySession(v: unknown): HistorySession | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.repoPath !== 'string' || o.repoPath === '') return null;
  if (typeof o.path !== 'string' || o.path === '') return null;
  const rev = typeof o.rev === 'string' && o.rev !== '' ? o.rev : null;
  const s: HistorySession = {
    repoPath: o.repoPath,
    repoName: typeof o.repoName === 'string' && o.repoName ? o.repoName : basename(o.repoPath),
    path: o.path,
    rev,
  };
  if (typeof o.selectHash === 'string' && /^[0-9a-f]{4,64}$/i.test(o.selectHash)) s.selectHash = o.selectHash;
  return s;
}

export function saveHistorySession(id: string, session: HistorySession, ls: KV | null = defaultStorage()): void {
  if (!ls) return;
  try {
    ls.setItem(KEY_PREFIX + id, JSON.stringify(session));
    ls.setItem(LATEST_KEY, id);
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    // ids are time-ordered base36: shorter first, then lexicographic
    keys.sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) ls.removeItem(k);
  } catch {
    /* quota / private mode */
  }
}

export function loadHistorySession(id: string, ls: KV | null = defaultStorage()): HistorySession | null {
  if (!ls) return null;
  try {
    const raw = ls.getItem(KEY_PREFIX + id);
    return raw ? parseHistorySession(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function latestHistorySessionId(ls: KV | null = defaultStorage()): string | null {
  try {
    return ls?.getItem(LATEST_KEY) ?? null;
  } catch {
    return null;
  }
}

export function basename(path: string): string {
  const p = path.replace(/[\\/]+$/, '');
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

export function historyWindowTitle(repoName: string, path: string): string {
  return `${repoName} — History: ${basename(path)}`;
}

/** Opens the history window for `session`, or re-targets the existing one and brings it to front. */
export async function openHistoryWindow(session: HistorySession): Promise<void> {
  const id = newSessionId();
  saveHistorySession(id, session);
  const title = historyWindowTitle(session.repoName, session.path);

  let existing: WebviewWindow | undefined;
  try {
    existing = (await getAllWebviewWindows()).find((w) => w.label.startsWith(HISTORY_WINDOW_LABEL_PREFIX));
  } catch {
    existing = undefined;
  }

  if (existing) {
    await emitTo<HistorySessionUpdateEvent>(existing.label, EVENT_HISTORY_SESSION_UPDATE, { id });
    await existing.setTitle(title).catch(() => {});
    await existing.unminimize().catch(() => {});
    await existing.show().catch(() => {});
    await existing.setFocus().catch(() => {});
    return;
  }

  const w = new WebviewWindow(HISTORY_WINDOW_LABEL_PREFIX + id, {
    url: 'index.html?historySession=' + encodeURIComponent(id),
    title,
    width: 1400,
    height: 880,
    minWidth: 760,
    minHeight: 420,
    focus: true,
  });
  await new Promise<void>((resolve, reject) => {
    void w.once('tauri://created', () => resolve());
    void w.once('tauri://error', (e) => reject(new Error(typeof e.payload === 'string' ? e.payload : 'Failed to open history window')));
  });
}
