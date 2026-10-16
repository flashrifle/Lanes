import { useEffect, useMemo, useState } from 'react';
import { call, toAppError } from '../../api';
import type { CommitDetails } from '../../types';
import { formatFullDate } from '../format/date';
import { buildRefLabels, refsByIndex } from '../log/refLabels';
import { jumpToHash, showToast, useStore } from '../state/store';

export function CommitDetailsPanel() {
  const repo = useStore((s) => s.repo);
  const snapshot = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const layout = useStore((s) => s.layout);

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
    const t = setTimeout(() => {
      call('get_commit_details', { repoPath: repo.path, hash })
        .then((d) => { if (!cancelled) setDetails(d); })
        .catch((e) => { if (!cancelled) setError(toAppError(e).message); });
      call('get_containing_refs', { repoPath: repo.path, hash })
        .then((c) => { if (!cancelled) setContaining(c); })
        .catch(() => {});
    }, 80);
    return () => { cancelled = true; clearTimeout(t); };
  }, [repo, hash]);

  const labels = useMemo(() => {
    if (single == null || !snapshot) return [];
    return buildRefLabels(refsByIndex(snapshot.refs.refs).get(single) ?? []);
  }, [single, snapshot]);

  if (visibleSelected.length === 0) return <div className="details"><div className="empty-note">커밋을 선택하면 상세 정보가 표시됩니다</div></div>;
  if (visibleSelected.length > 1) return <div className="details"><div className="empty-note">{visibleSelected.length}개의 커밋이 선택됨</div></div>;
  if (error) return <div className="details"><div className="empty-note err">{error}</div></div>;
  if (!details) return <div className="details"><div className="empty-note">…</div></div>;

  const d = details;
  const containingNames = (containing ?? []).map((f) => f.replace(/^refs\/(heads|remotes|tags)\//, ''));
  const sameCommitter = d.committerEmail === d.authorEmail && d.committerTime === d.authorTime;

  return (
    <div className="details">
      <div className="details-scroll">
        <div className="d-subject">{d.subject}</div>
        {d.body && <pre className="d-body">{d.body}</pre>}
        <div className="d-meta">
          <button className="hash-link" title="해시 복사" onClick={() => { void navigator.clipboard?.writeText(d.hash); showToast('info', '해시를 복사했습니다'); }}>
            {d.hash.slice(0, 10)}
          </button>
          <span> {d.authorName} </span>
          <span className="muted">&lt;{d.authorEmail}&gt;</span>
          <span className="muted"> · {formatFullDate(d.authorTime)}</span>
        </div>
        {!sameCommitter && (
          <div className="d-meta muted">커밋: {d.committerName} &lt;{d.committerEmail}&gt; · {formatFullDate(d.committerTime)}</div>
        )}
        {d.parents.length > 0 && (
          <div className="d-meta">
            <span className="muted">부모: </span>
            {d.parents.map((p) => (
              <button key={p} className="hash-link" onClick={() => jumpToHash(p)}>{p.slice(0, 10)}</button>
            ))}
          </div>
        )}
        {labels.length > 0 && (
          <div className="d-meta">
            <span className="muted">참조: </span>
            {labels.map((l) => <span key={l.text} className={`chip static ${l.kind}`}>{l.text}</span>)}
          </div>
        )}
        <div className="d-meta">
          <span className="muted">포함된 브랜치: </span>
          {containing === null ? <span className="muted">…</span> : containingNames.length ? containingNames.join(', ') : <span className="muted">없음</span>}
        </div>
      </div>
    </div>
  );
}
