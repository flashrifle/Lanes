// Per-tab state for write-op dialogs (push, merge/rebase, cherry-pick/revert, reset, tags, reflog, compare).
// Owned by ui-ops (docs/PLAN-v0.1.md). Phase 0 stub.
import { Store } from '../state/createStore';
import type { RepoStore } from '../state/repoStore';

export type OpsDialog = { kind: 'none' };

export interface OpsState {
  dialog: OpsDialog;
}

export class OpsStore extends Store<OpsState> {
  constructor(readonly repo: RepoStore) {
    super({ dialog: { kind: 'none' } });
  }

  dispose(): void {}
}
