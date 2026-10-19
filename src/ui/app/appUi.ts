// Module store for ui-app overlays (settings dialog, update dialog). Not part of RepoStore/DialogState.
import { call, onEvent, toAppError } from '../../api';
import { EVENT_UPDATE_PROGRESS, type UpdateInfo, type UpdateProgressEvent } from '../../types';
import { Store, useStoreState } from '../state/createStore';
import { recordError } from './lastError';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'installing'; info: UpdateInfo; downloaded: number; total: number | null; finished: boolean }
  | { kind: 'error'; reason: 'offline' | 'failed'; message: string; info: UpdateInfo | null };

interface AppUiState {
  settingsOpen: boolean;
  update: UpdateState;
}

const OFFLINE_RE = /network|offline|dns|resolve|connect|connection|timed out|timeout|unreachable|tls|ssl/i;
export const classifyUpdateError = (message: string): 'offline' | 'failed' => (OFFLINE_RE.test(message) ? 'offline' : 'failed');

export class AppUiStore extends Store<AppUiState> {
  constructor() { super({ settingsOpen: false, update: { kind: 'idle' } }); }

  openSettings = (): void => this.set({ settingsOpen: true });
  closeSettings = (): void => this.set({ settingsOpen: false });
  dismissUpdate = (): void => {
    if (this.state.update.kind === 'installing' && !this.state.update.finished) return; // cannot cancel a running install
    this.set({ update: { kind: 'idle' } });
  };

  private checking = false;

  /**
   * `silent` (launch check): only an available update shows a dialog; "up to date", offline and failures stay
   * invisible. Manual checks show every outcome.
   */
  async check(silent: boolean): Promise<void> {
    if (this.checking || this.state.update.kind === 'installing') return;
    this.checking = true;
    if (!silent) this.set({ update: { kind: 'checking' } });
    try {
      const info = await call('check_for_update', {});
      if (info) this.set({ update: { kind: 'available', info } });
      else if (!silent) this.set({ update: { kind: 'upToDate' } });
      else this.set({ update: { kind: 'idle' } });
    } catch (e) {
      const err = toAppError(e);
      if (!silent) {
        recordError(err);
        this.set({ update: { kind: 'error', reason: classifyUpdateError(err.message), message: err.message, info: null } });
      }
    } finally {
      this.checking = false;
    }
  }

  async install(): Promise<void> {
    const cur = this.state.update;
    const info = cur.kind === 'available' ? cur.info : cur.kind === 'error' ? cur.info : null;
    if (!info) return;
    this.set({ update: { kind: 'installing', info, downloaded: 0, total: null, finished: false } });
    let un: (() => void) | undefined;
    try {
      un = await onEvent<UpdateProgressEvent>(EVENT_UPDATE_PROGRESS, (p) => {
        const u = this.state.update;
        if (u.kind === 'installing') this.set({ update: { ...u, downloaded: p.downloaded, total: p.total, finished: p.finished } });
      });
    } catch { /* progress is cosmetic */ }
    try {
      await call('install_update', {});
      await call('restart_app', {});
    } catch (e) {
      const err = toAppError(e);
      recordError(err);
      this.set({ update: { kind: 'error', reason: classifyUpdateError(err.message), message: err.message, info } });
    } finally {
      un?.();
    }
  }
}

export const appUi = new AppUiStore();
export const useAppUi = <T,>(selector: (s: AppUiState) => T): T => useStoreState(appUi, selector);
