import { useEffect, useMemo, useState } from 'react';
import { call, toAppError } from '../../api';
import type { CommitDetails } from '../../types';
import { formatFullDate } from '../format/date';
import { buildRefLabels, refsByIndex } from '../log/refLabels';
import { badgeOf, colorOf } from '../log/palette';
import { Tooltip } from '../common/Tooltip';
import { useRepo, useRepoStore } from '../state/repoContext';
import { t } from '../../i18n';

export function CommitDetailsPanel() {
  const store = useRepoStore();
  const { jumpToHash, showToast } = store;
  const repo = useRepo((s) => s.repo);
  const snapshot = useRepo((s) => s.snapshot);
  const selection = useRepo((s) => s.selection);
  const layout = useRepo((s) => s.layout);

  const visibleSelected = useMemo(
    () => [...selection.set].filter((i) => (layout ? layout.rowOf(i) >= 0 : false)),
    [selection, layout],
  );
  const single = visibleSelected.length === 1 ? visibleSelected[0] : null;
  const hash = single != null && snapshot ? snapshot.hashes[single] : null;

  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [containing, setContaining] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetails(null); setContaining(null); setError(null);
    if (!repo || !hash) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      call('get_commit_details', { repoPath: repo.path, hash })
        .then((d) => { if (!cancelled) setDetails(d); })
        .catch((e) => { if (!cancelled) setError(toAppError(e).message); });
      call('get_containing_refs', { repoPath: repo.path, hash })
        .then((c) => { if (!cancelled) setContaining(c); })
        .catch(() => {});
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [repo, hash]);

  const labels = useMemo(() => {
    if (single == null || !snapshot) return [];
    return buildRefLabels(refsByIndex(snapshot.refs.refs).get(single) ?? []);
  }, [single, snapshot]);

  const lineIdx = single != null && layout && layout.rowOf(single) >= 0 ? layout.getRow(layout.rowOf(single)).nodeColor : null;
  const lineColor = lineIdx != null ? colorOf(lineIdx) : 'var(--muted)';
  const badge = lineIdx != null ? badgeOf(lineIdx) : { bg: '#3A4157', ink: '#fff' };

  if (visibleSelected.length === 0) return <div className="details"><div className="empty-note">{t('details.empty')}</div></div>;
  if (visibleSelected.length > 1) return <div className="details"><div className="empty-note">{t('details.multi', { n: visibleSelected.length })}</div></div>;
  if (error) return <div className="details"><div className="empty-note err">{error}</div></div>;
  if (!details) return <div className="details"><div className="empty-note">…</div></div>;

  const d = details;
  const containingNames = (containing ?? []).map((f) => f.replace(/^refs\/(heads|remotes|tags)\//, ''));
  const lineLabel = labels.find((l) => l.kind === 'local' || l.kind === 'head');
  const lineName = lineLabel ? lineLabel.text.split(' & ').pop() : containingNames[0];
  const sameCommitter = d.committerEmail === d.authorEmail && d.committerTime === d.authorTime;

  return (
    <div className="details">
      <div className="details-scroll">
        <div className="d-card" style={{ borderLeftColor: lineColor }}>
          <div className="d-eyebrow">{lineName ? t('details.line', { name: lineName }) : ''}{d.hash.slice(0, 7)}</div>
          <div className="d-subject">{d.subject}</div>
        </div>
        {d.body && <pre className="d-body">{d.body}</pre>}
        <div className="d-meta">
          <Tooltip label={t('details.copyFull')}>
            <button className="hash-link" onClick={() => { void navigator.clipboard?.writeText(d.hash); showToast('info', t('details.hashCopied')); }}>
              {d.hash.slice(0, 10)}
            </button>
          </Tooltip>
          <span> {d.authorName} </span>
          <span className="muted">&lt;{d.authorEmail}&gt;</span>
          <span className="muted"> · {formatFullDate(d.authorTime)}</span>
        </div>
        {!sameCommitter && (
          <div className="d-meta muted">{t('details.committer')}{d.committerName} &lt;{d.committerEmail}&gt; · {formatFullDate(d.committerTime)}</div>
        )}
        {d.parents.length > 0 && (
          <div className="d-meta">
            <span className="muted">{t('details.parents')}</span>
            {d.parents.map((p) => (
              <Tooltip key={p} label={t('details.parentTip')}><button className="hash-link" onClick={() => jumpToHash(p)}>{p.slice(0, 10)}</button></Tooltip>
            ))}
          </div>
        )}
        {labels.length > 0 && (
          <div className="d-meta">
            <span className="muted">{t('details.refs')}</span>
            {labels.map((l) => <span key={l.text} className="badge" style={{ ['--c' as string]: badge.bg, ['--ink' as string]: badge.ink }}>{l.text}</span>)}
          </div>
        )}
        <div className="d-meta">
          <span className="muted">{t('details.containing')}</span>
          {containing === null ? <span className="muted">…</span> : containingNames.length ? containingNames.join(', ') : <span className="muted">{t('details.none')}</span>}
        </div>
      </div>
    </div>
  );
}
