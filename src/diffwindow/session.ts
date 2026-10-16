// Diff window session hand-off. Windows share the app origin, so localStorage carries the payload
// and a Tauri event tells an already-open diff window to switch to a new session.
import { emitTo } from '@tauri-apps/api/event';
import { getAllWebviewWindows, WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { ChangedFile } from '../types';

export interface DiffSession {
  repoPath: string;
  repoName: string;
  files: ChangedFile[];
  index: number;
  title: string; // e.g. commit subject
}

export const DIFF_WINDOW_LABEL_PREFIX = 'diff-';
export const EVENT_DIFF_SESSION_UPDATE = 'diff-session-update';
export interface DiffSessionUpdateEvent {
  id: string;
}

const KEY_PREFIX = 'diff-session:';
const LATEST_KEY = 'diff-session-latest';
const KEEP = 8;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function saveDiffSession(id: string, session: DiffSession): void {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(KEY_PREFIX + id, JSON.stringify(session));
    ls.setItem(LATEST_KEY, id);
    // prune old sessions (ids are time-ordered base36)
    const keys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    keys.sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) ls.removeItem(k);
  } catch {
    /* quota / private mode: the event payload still carries the id */
  }
}

export function loadDiffSession(id: string): DiffSession | null {
  const ls = storage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(KEY_PREFIX + id);
    if (!raw) return null;
    const s = JSON.parse(raw) as DiffSession;
    if (!s || !Array.isArray(s.files) || typeof s.repoPath !== 'string') return null;
    return { ...s, index: Math.min(Math.max(0, s.index | 0), Math.max(0, s.files.length - 1)) };
  } catch {
    return null;
  }
}

export function latestDiffSessionId(): string | null {
  try {
    return storage()?.getItem(LATEST_KEY) ?? null;
  } catch {
    return null;
  }
}

export function fileName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function diffWindowTitle(repoName: string, file: ChangedFile | undefined): string {
  return file ? `${repoName} — Diff: ${fileName(file.path)}` : `${repoName} — Diff`;
}

/**
 * Opens the diff window for `session`, or re-targets the existing one (single shared diff window,
 * like IntelliJ) and brings it to front.
 */
export async function openDiffWindow(session: DiffSession): Promise<void> {
  const id = newSessionId();
  saveDiffSession(id, session);
  const title = diffWindowTitle(session.repoName, session.files[session.index]);

  let existing: WebviewWindow | undefined;
  try {
    existing = (await getAllWebviewWindows()).find((w) => w.label.startsWith(DIFF_WINDOW_LABEL_PREFIX));
  } catch {
    existing = undefined;
  }

  if (existing) {
    await emitTo<DiffSessionUpdateEvent>(existing.label, EVENT_DIFF_SESSION_UPDATE, { id });
    await existing.setTitle(title).catch(() => {});
    await existing.unminimize().catch(() => {});
    await existing.show().catch(() => {});
    await existing.setFocus().catch(() => {});
    return;
  }

  const w = new WebviewWindow(DIFF_WINDOW_LABEL_PREFIX + id, {
    url: 'index.html?diffSession=' + encodeURIComponent(id),
    title,
    width: 1300,
    height: 850,
    minWidth: 700,
    minHeight: 400,
    focus: true,
  });
  await new Promise<void>((resolve, reject) => {
    void w.once('tauri://created', () => resolve());
    void w.once('tauri://error', (e) => reject(new Error(typeof e.payload === 'string' ? e.payload : 'Failed to open diff window')));
  });
}
