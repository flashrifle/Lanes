// Context-menu items contributed by ui-ops. LogTable / BranchPanel append these to their own items.
import { t } from '../../i18n';
import type { Ref } from '../../types';
import type { MenuItem } from '../common/ContextMenu';
import type { RepoStore } from '../state/repoStore';
import { branchMenuState, commitMenuState, headCtxOf } from './logic';

/** Commit row menu: cherry-pick, revert, reset, tag, compare. `hashes` in row order (newest first). */
export function commitMenuItems({ store, hashes, focusHash }: { store: RepoStore; hashes: string[]; focusHash: string }): MenuItem[] {
  const head = headCtxOf(store.getState().snapshot?.refs);
  const s = commitMenuState(head, hashes, focusHash);
  const ops = store.ops;
  const n = hashes.length;
  return [
    { label: n > 1 ? t('ops.cherryPickN', { n }) : t('ops.cherryPick'), disabled: !s.cherryPick, onClick: () => void ops.startSequence('cherryPick', hashes) },
    { label: n > 1 ? t('ops.revertN', { n }) : t('ops.revert'), disabled: !s.revert, onClick: () => void ops.startSequence('revert', hashes) },
    { separator: true },
    { label: t('undo.menu'), disabled: !ops.canUndo(hashes), onClick: () => void ops.askUndoCommit(focusHash) },
    { label: t('reset.menu'), disabled: !s.reset, onClick: () => ops.open({ kind: 'reset', hash: focusHash }) },
    { label: t('tag.menu'), disabled: !s.tag, onClick: () => ops.open({ kind: 'tag', hash: focusHash }) },
    { separator: true },
    { label: t('compare.withCurrent'), disabled: !s.compare, onClick: () => ops.compareWithCurrent(focusHash) },
  ];
}

/** Branch / tag menu: merge into current, rebase current onto, compare with current, push, reflog, tag ops. */
export function branchMenuItems(ref: Ref, store: RepoStore): MenuItem[] {
  const head = headCtxOf(store.getState().snapshot?.refs);
  const s = branchMenuState(head, ref);
  const ops = store.ops;
  const cur = head.branch ?? 'HEAD';
  const items: MenuItem[] = [];
  if (ref.type === 'localBranch' || ref.type === 'remoteBranch') {
    items.push(
      { label: t('merge.menuMerge', { name: ref.name, cur }), disabled: !s.merge, onClick: () => ops.open({ kind: 'merge', ref }) },
      { label: t('merge.menuRebase', { cur, name: ref.name }), disabled: !s.rebase, onClick: () => ops.askRebase(ref) },
    );
  }
  if (ref.type !== 'head') items.push({ label: t('compare.withCurrentBranch', { name: ref.name, cur }), disabled: !s.compare, onClick: () => ops.compareWithCurrent(ref.fullName) });
  if (ref.type === 'localBranch') items.push({ label: t('push.menu'), onClick: () => ops.open({ kind: 'push', localBranch: ref.name }) });
  if (ref.type === 'tag') {
    items.push(
      { label: t('tag.menuPush'), onClick: () => ops.startPushTag(ref.name) },
      { label: t('tag.menuDelete'), onClick: () => ops.askDeleteTag(ref.name) },
    );
  }
  if (s.reflog) items.push({ label: t('reflog.menu'), onClick: () => ops.open({ kind: 'reflog', ref: ref.type === 'head' ? null : ref.fullName }) });
  return items;
}
