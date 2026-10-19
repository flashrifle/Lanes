import { useEffect, useState } from 'react';
import { call } from '../../api';
import { appUi } from '../app/appUi';
import { appStore, useApp } from '../state/appStore';
import { Tooltip } from '../common/Tooltip';
import { formatCommitDate } from '../format/date';
import { t } from '../../i18n';

export function WelcomeScreen() {
  const recents = useApp((s) => s.recents);
  const booting = useApp((s) => s.booting);
  const [gitMissing, setGitMissing] = useState(false);
  useEffect(() => {
    call('get_diagnostics', {}).then((d) => setGitMissing(d.gitVersion === null)).catch(() => {});
  }, []);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Git Log</h1>
        <p className="muted">{t('welcome.subtitle')}</p>
        {gitMissing && (
          <p className="welcome-git" role="alert">
            {t('settings.gitMissing')}{' '}
            <button className="link-btn" onClick={appUi.openSettings}>{t('settings.openSettings')}</button>
          </p>
        )}
        <button className="btn primary" onClick={() => void appStore.chooseAndOpenRepo()} disabled={booting}>
          {t('common.openRepo')}
        </button>
        {recents.length > 0 && (
          <>
            <h2>{t('welcome.recent')}</h2>
            <ul className="recent-list">
              {recents.map((r) => (
                <li key={r.path} className={r.exists ? '' : 'missing'}>
                  <button className="recent-open" disabled={!r.exists} onClick={() => void appStore.openRepo(r.path)}>
                    <span className="recent-name">{r.name}</span>
                    <span className="recent-path">{r.path}</span>
                  </button>
                  <span className="recent-date">{r.exists ? formatCommitDate(r.lastOpened) : t('welcome.missing')}</span>
                  <Tooltip label={t('welcome.removeRecent')} side="left"><button className="icon-btn" onClick={() => void appStore.removeRecent(r.path)}>×</button></Tooltip>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
