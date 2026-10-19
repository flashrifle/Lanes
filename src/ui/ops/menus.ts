// Context-menu items contributed by ui-ops. LogTable / BranchPanel append these to their own items.
// Phase 0 stubs (return []), owned by ui-ops.
import type { Ref } from '../../types';
import type { MenuItem } from '../common/ContextMenu';
import type { RepoStore } from '../state/repoStore';

/** Commit row menu: cherry-pick, revert, reset, tag, compare... `hashes` in row order (newest first). */
export function commitMenuItems(_args: { store: RepoStore; hashes: string[]; focusHash: string }): MenuItem[] {
  return [];
}

/** Branch / tag menu: merge into current, rebase current onto, compare with current, push, tag ops... */
export function branchMenuItems(_ref: Ref, _store: RepoStore): MenuItem[] {
  return [];
}
