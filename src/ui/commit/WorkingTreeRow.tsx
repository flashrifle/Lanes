// "Uncommitted changes (N)" row rendered above the virtualized log rows (LogTable owns placement, height = rowH).
// Phase 0 stub, owned by ui-commit.
import { useRepoStore, useRepo } from '../state/repoContext';
import { useStoreState } from '../state/createStore';

export function WorkingTreeRow({ height }: { height: number }) {
  const store = useRepoStore();
  const count = useStoreState(store.commit, (s) => s.status?.files.length ?? 0);
  const selected = useRepo((s) => s.workingSelected);
  if (count === 0) return null;
  return (
    <div className={'working-row' + (selected ? ' selected' : '')} style={{ height }} onClick={() => store.selectWorking()}>
      Uncommitted changes ({count})
    </div>
  );
}
