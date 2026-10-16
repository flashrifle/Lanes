import { chooseAndOpenRepo, openRepo, removeRecent, useStore } from '../state/store';
import { formatCommitDate } from '../format/date';

export function WelcomeScreen() {
  const recents = useStore((s) => s.recents);
  const booting = useStore((s) => s.booting);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Git Log</h1>
        <p className="muted">Git 저장소를 열어 커밋 로그를 확인하세요.</p>
        <button className="btn primary" onClick={() => void chooseAndOpenRepo()} disabled={booting}>
          저장소 열기…
        </button>
        {recents.length > 0 && (
          <>
            <h2>최근 항목</h2>
            <ul className="recent-list">
              {recents.map((r) => (
                <li key={r.path} className={r.exists ? '' : 'missing'}>
                  <button className="recent-open" disabled={!r.exists} onClick={() => void openRepo(r.path)}>
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.path}</span>
                  </button>
                  <span className="recent-date">{r.exists ? formatCommitDate(r.lastOpened) : '없음'}</span>
                  <button className="icon-btn" title="목록에서 제거" onClick={() => void removeRecent(r.path)}>×</button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
