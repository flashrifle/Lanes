// Repo-bar banner for an in-progress merge / rebase / cherry-pick / revert: step N/M, conflict count,
// Continue / Skip / Abort (control_operation). The operation name itself is shown by RepoBar.
import { t } from '../../i18n';
import { useStoreState } from '../state/createStore';
import { useRepoStore } from '../state/repoContext';
import { workingCounts } from './workingFiles';
import './commit.css';

export function OperationBanner() {
  const store = useRepoStore();
  const cs = store.commit;
  const status = useStoreState(cs, (s) => s.status);
  const pending = useStoreState(cs, (s) => s.pending);
  const op = status?.operation;
  if (!op || op.operation === 'bisect') return null;
  const conflicts = workingCounts(status).conflicts;
  const parts: string[] = [];
  if (op.operation === 'rebase' && op.headName) parts.push(t('conflict.banner.rebasing', { branch: op.headName, onto: op.ontoHash?.slice(0, 8) ?? '?' }));
  if (op.step != null && op.total != null) parts.push(t('conflict.banner.step', { i: op.step, n: op.total }));
  else if (op.stoppedAt) parts.push(t('conflict.banner.at', { hash: op.stoppedAt.slice(0, 8) }));
  const canContinue = op.canContinue && conflicts === 0;
  return (
    <span className="op-banner" role="status">
      {parts.length > 0 && <span className="op-banner-info">{parts.join(' · ')}</span>}
      {conflicts > 0 && (
        <button className="op-banner-conflicts" onClick={() => store.selectWorking()} title={t('conflict.banner.showTip')}>
          {t('conflict.banner.conflicts', { n: conflicts })}
        </button>
      )}
      <button
        className="btn small primary"
        disabled={!canContinue || pending > 0}
        title={canContinue ? undefined : t('conflict.banner.continueBlocked')}
        onClick={() => cs.controlOperation('continue')}
      >
        {t('conflict.action.continue')}
      </button>
      {op.canSkip && (
        <button className="btn small" disabled={pending > 0} onClick={() => cs.controlOperation('skip')}>{t('conflict.action.skip')}</button>
      )}
      <button className="btn small" disabled={pending > 0} onClick={() => cs.controlOperation('abort')}>{t('conflict.action.abort')}</button>
    </span>
  );
}
