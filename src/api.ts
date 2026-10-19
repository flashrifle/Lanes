import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import {
  EVENT_GIT_PROGRESS,
  EVENT_REPO_CHANGED,
  type AppError,
  type CommandMap,
  type CommandName,
  type GitProgressEvent,
  type RepoChangedEvent,
} from './types';

/** Normalize anything thrown by invoke() into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.code === 'string' && typeof o.message === 'string') {
      return {
        code: o.code as AppError['code'],
        message: o.message,
        stderr: typeof o.stderr === 'string' ? o.stderr : null,
      };
    }
    if (e instanceof Error) return { code: 'internal', message: e.message, stderr: null };
  }
  if (typeof e === 'string') return { code: 'internal', message: e, stderr: null };
  return { code: 'internal', message: 'Unknown error', stderr: null };
}

export async function call<K extends CommandName>(
  cmd: K,
  args: CommandMap[K][0],
): Promise<CommandMap[K][1]> {
  try {
    return await invoke<CommandMap[K][1]>(cmd, args as Record<string, unknown>);
  } catch (e) {
    throw toAppError(e);
  }
}

/** Generic typed event subscription; all v0.1 events (settings-changed, update-progress, menu-action, ...) go through it. */
export function onEvent<T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(name, (ev) => cb(ev.payload));
}

export function onRepoChanged(cb: (e: RepoChangedEvent) => void): Promise<UnlistenFn> {
  return listen<RepoChangedEvent>(EVENT_REPO_CHANGED, (ev) => cb(ev.payload));
}

export function onGitProgress(cb: (e: GitProgressEvent) => void): Promise<UnlistenFn> {
  return listen<GitProgressEvent>(EVENT_GIT_PROGRESS, (ev) => cb(ev.payload));
}

export async function pickFolder(): Promise<string | null> {
  const r = await open({ directory: true, multiple: false });
  return typeof r === 'string' ? r : null;
}
