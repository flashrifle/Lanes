import { useEffect, useState } from 'react';
import { call, toAppError } from '../../api';
import type { FileDiff } from '../../types';
import { Icon } from '../common/Icons';
import { closeDiff, useStore } from '../state/store';

export function DiffView() {
  const file = useStore((s) => s.diff);
  const repo = useStore((s) => s.repo);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null); setError(null);
    if (!file || !repo) return;
    let cancelled = false;
    call('get_file_diff', {
      repoPath: repo.path,
      request: { path: file.path, oldPath: file.oldPath, fromHash: file.fromHash, toHash: file.toHash, contextLines: null },
    })
      .then((d) => { if (!cancelled) setDiff(d); })
      .catch((e) => { if (!cancelled) setError(toAppError(e).message); });
    return () => { cancelled = true; };
  }, [file, repo]);

  useEffect(() => {
    if (!file) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeDiff(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [file]);

  if (!file) return null;
  return (
    <div className="diff-overlay" role="dialog" aria-label="Diff">
      <div className="diff-header">
        <span className="diff-title">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        {diff?.oldMode && diff.newMode && diff.oldMode !== diff.newMode && <span className="muted">모드 {diff.oldMode} → {diff.newMode}</span>}
        <span className="grow" />
        <span className="muted">Esc로 닫기</span>
        <button className="icon-btn" onClick={closeDiff} title="닫기"><Icon name="close" size={14} /></button>
      </div>
      <div className="diff-body">
        {error && <div className="empty-note err">{error}</div>}
        {!diff && !error && <div className="empty-note">불러오는 중…</div>}
        {diff?.binary && <div className="empty-note">바이너리 파일</div>}
        {diff && !diff.binary && diff.hunks.length === 0 && <div className="empty-note">표시할 변경 내용이 없습니다</div>}
        {diff && !diff.binary && (
          <table className="diff-table">
            <tbody>
              {diff.hunks.map((h, hi) => (
                <HunkRows key={hi} header={h.header} lines={h.lines} />
              ))}
            </tbody>
          </table>
        )}
        {diff?.truncated && <div className="trunc-banner">diff가 너무 커서 일부만 표시됩니다</div>}
      </div>
    </div>
  );
}

function HunkRows({ header, lines }: { header: string; lines: FileDiff['hunks'][number]['lines'] }) {
  return (
    <>
      <tr className="hunk"><td colSpan={4}>{header}</td></tr>
      {lines.map((l, i) => (
        <tr key={i} className={'dl ' + l.kind}>
          <td className="ln">{l.oldLine ?? ''}</td>
          <td className="ln">{l.newLine ?? ''}</td>
          <td className="sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}</td>
          <td className="code">{l.kind === 'noNewline' ? '\\ 파일 끝에 줄바꿈 없음' : l.text}</td>
        </tr>
      ))}
    </>
  );
}
