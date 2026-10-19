// "Uncommitted changes (N)" row rendered above the virtualized log rows (LogTable owns placement, height = rowH).
// Selecting it shows LocalChangesPanel in the right column (IntelliJ "Local Changes").
import { useRepoStore, useRepo } from '../state/repoContext';
import { useStoreState } from '../state/createStore';
import { ContextMenu, useContextMenu } from '../common/ContextMenu';
import { t } from '../../i18n';
import { workingCounts } from './workingFiles';
import './commit.css';

export function WorkingTreeRow({ height }: { height: number }) {
  const store = useRepoStore();
  const status = useStoreState(store.commit, (s) => s.status);
  const selected = useRepo((s) => s.workingSelected);
  const ctx = useContextMenu();
  const c = workingCounts(status);
  if (c.total === 0) return null;
  const hints: string[] = [];
  if (c.staged) hints.push(t('commit.row.staged', { n: c.staged }));
  if (c.conflicts) hints.push(t('commit.row.conflicts', { n: c.conflicts }));
  return (
    <div
      className={'working-row' + (selected ? ' selected' : '') + (c.conflicts ? ' has-conflicts' : '')}
      style={{ height }}
      role="row"
      aria-selected={selected}
      title={t('commit.row.tip')}
      onMouseDown={(e) => { if (e.button === 0) store.selectWorking(); }}
      onContextMenu={(e) => {
        store.selectWorking();
        ctx.open(e, [
          { label: t('stash.saveMenu'), onClick: () => store.commit.openStashSave(null) },
          { label: t('commit.refresh'), onClick: () => void store.commit.refreshStatus() },
        ]);
      }}
    >
      <span className="working-node" aria-hidden />
      <span className="working-label">{t('commit.row.label', { n: c.total })}{status?.truncated ? '+' : ''}</span>
      {hints.length > 0 && <span className="working-hints">{hints.join(' · ')}</span>}
      {ctx.menu && <ContextMenu menu={ctx.menu} onClose={ctx.close} />}
    </div>
  );
}
