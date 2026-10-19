// Repo action buttons in the repo bar (Fork / GitHub Desktop style): Fetch, Pull ↓n, Push ↑n, Commit (n), Stash.
// Counts come from the working-tree status (porcelain v2 --branch), which refreshes on watcher events.
import { useRepoStore, useRepo } from '../state/repoContext';
import { useStoreState } from '../state/createStore';
import { Icon } from '../common/Icons';
import { Tooltip } from '../common/Tooltip';
import { t } from '../../i18n';
import './toolbar.css';

const PushIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10V3M4.8 5.8L8 2.6l3.2 3.2M3 13h10" /></svg>
);
const CommitIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="2.6" /><path d="M1.5 8h3.9M10.6 8h3.9" /></svg>
);
const StashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 6.5h11v6.5h-11zM3.5 3.5h9l1 3h-11z" /><path d="M6.5 9.2h3" strokeLinecap="round" /></svg>
);

export function RepoActions() {
  const store = useRepoStore();
  const status = useStoreState(store.commit, (s) => s.status);
  const head = useRepo((s) => s.snapshot?.refs.head);
  const onBranch = !!head && !head.detached && !head.unborn;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const changed = status?.files.length ?? 0;
  const noUpstream = onBranch && status != null && status.upstream == null;

  return (
    <div className="repo-actions">
      <Tooltip side="bottom" label={t('branches.fetchAll')}>
        <button className="ra-btn" onClick={() => void store.fetchAll()}>
          <Icon name="download" size={14} /><span>{t('actions.fetch')}</span>
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={behind ? t('actions.pullTip', { n: behind }) : t('branches.pull')}>
        <button className={'ra-btn' + (behind ? ' hot' : '')} disabled={!onBranch || noUpstream} onClick={() => void store.pull('ffOnly')}>
          <Icon name="pull" size={14} /><span>{t('actions.pull')}</span>{behind > 0 && <span className="ra-count">↓{behind}</span>}
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={noUpstream ? t('actions.pushNoUpstream') : ahead ? t('actions.pushTip', { n: ahead }) : t('actions.push')}>
        <button className={'ra-btn' + (ahead || noUpstream ? ' hot' : '')} disabled={!onBranch} onClick={() => store.ops.open({ kind: 'push', localBranch: null })}>
          <PushIcon /><span>{t('actions.push')}</span>{ahead > 0 && <span className="ra-count">↑{ahead}</span>}
        </button>
      </Tooltip>
      <span className="ra-sep" />
      <Tooltip side="bottom" label={t('actions.commitTip')}>
        <button className={'ra-btn' + (changed ? ' hot' : '')} disabled={changed === 0} onClick={() => store.selectWorking()}>
          <CommitIcon /><span>{t('actions.commit')}</span>{changed > 0 && <span className="ra-count">{changed}</span>}
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={t('actions.stashTip')}>
        <button className="ra-btn" disabled={changed === 0} onClick={() => store.commit.openStashSave()}>
          <StashIcon /><span>{t('actions.stash')}</span>
        </button>
      </Tooltip>
    </div>
  );
}
