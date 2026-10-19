// Per-tab dialogs owned by ui-ops (push, merge/rebase, cherry-pick/revert, reset, tags, reflog). Mounted in TabOverlays.
import './ops.css';
import { useRepoStore } from '../state/repoContext';
import { useStoreState } from '../state/createStore';
import { PushDialog } from './PushDialog';
import { ReflogDialog } from './ReflogDialog';
import { MainlineDialog, MergeDialog, ResetDialog, TagDialog, TagPushDialog } from './SmallDialogs';

export function OpsOverlays() {
  const store = useRepoStore();
  const dialog = useStoreState(store.ops, (s) => s.dialog);
  switch (dialog.kind) {
    case 'push': return <PushDialog localBranch={dialog.localBranch} />;
    case 'merge': return <MergeDialog refToMerge={dialog.ref} />;
    case 'mainline': return <MainlineDialog op={dialog.op} hashes={dialog.hashes} maxParents={dialog.maxParents} />;
    case 'reset': return <ResetDialog hash={dialog.hash} />;
    case 'tag': return <TagDialog hash={dialog.hash} />;
    case 'tagPush': return <TagPushDialog name={dialog.name} />;
    case 'reflog': return <ReflogDialog refName={dialog.ref} />;
    default: return null;
  }
}
