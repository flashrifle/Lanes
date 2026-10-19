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
const ReflogIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4" /></svg>
);
const UndoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5.5 3.5L2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7" /></svg>
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
  // Double-click guard: each button is disabled while its op is queued or running (RepoStore.runOp key).
  const running = useRepo((s) => s.runningOps);
  const fetching = running.includes('fetch');
  const pulling = running.includes('pull');
  const pushing = running.includes('push');
  const pushOpen = useStoreState(store.ops, (s) => s.dialog.kind === 'push');
  const headHash = head?.hash ?? null;
  // canUndo reads snapshot + status, both of which re-render this component when they change.
  const canUndo = !!headHash && store.ops.canUndo([headHash]);

  return (
    <div className="repo-actions">
      <Tooltip side="bottom" label={t('branches.fetchAll')}>
        <button className="ra-btn" disabled={fetching} aria-busy={fetching || undefined} onClick={() => void store.fetchAll()}>
          <Icon name="download" size={14} /><span className="ra-label">{t('actions.fetch')}</span>
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={behind ? t('actions.pullTip', { n: behind }) : t('branches.pull')}>
        <button className={'ra-btn' + (behind ? ' hot' : '')} disabled={!onBranch || noUpstream || pulling} aria-busy={pulling || undefined} onClick={() => void store.pull('ffOnly')}>
          <Icon name="pull" size={14} /><span className="ra-label">{t('actions.pull')}</span>{behind > 0 && <span className="ra-count">↓{behind}</span>}
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={noUpstream ? t('actions.pushNoUpstream') : ahead ? t('actions.pushTip', { n: ahead }) : t('actions.push')}>
        <button className={'ra-btn' + (ahead || noUpstream ? ' hot' : '')} disabled={!onBranch || pushing || pushOpen} aria-busy={pushing || undefined} onClick={() => store.ops.open({ kind: 'push', localBranch: null })}>
          <PushIcon /><span className="ra-label">{t('actions.push')}</span>{ahead > 0 && <span className="ra-count">↑{ahead}</span>}
        </button>
      </Tooltip>
      <span className="ra-sep" />
      <Tooltip side="bottom" label={t('actions.commitTip')}>
        <button className={'ra-btn' + (changed ? ' hot' : '')} disabled={changed === 0} onClick={() => store.selectWorking()}>
          <CommitIcon /><span className="ra-label">{t('actions.commit')}</span>{changed > 0 && <span className="ra-count">{changed}</span>}
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={t('actions.stashTip')}>
        <button className="ra-btn" disabled={changed === 0} onClick={() => store.commit.openStashSave()}>
          <StashIcon /><span className="ra-label">{t('actions.stash')}</span>
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={t('undo.tip')}>
        <button className="ra-btn" disabled={!headHash || !canUndo} onClick={() => { if (headHash) void store.ops.askUndoCommit(headHash); }}>
          <UndoIcon /><span className="ra-label">{t('undo.short')}</span>
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={t('reflog.menu')}>
        <button className="ra-btn" onClick={() => store.ops.open({ kind: 'reflog', ref: null })}>
          <ReflogIcon /><span className="ra-label">{t('actions.reflog')}</span>
        </button>
      </Tooltip>
    </div>
  );
}
