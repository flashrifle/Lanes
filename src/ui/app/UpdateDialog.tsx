// Update dialog: available (version + notes) -> installing (progress) -> restart; also up-to-date / offline / failed.
import { useRef } from 'react';
import { useLayer } from '../common/layers';
import './app.css';
import { t } from '../../i18n';
import { appUi, useAppUi } from './appUi';

const mb = (b: number): string => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function UpdateDialog() {
  const u = useAppUi((s) => s.update);
  const ref = useRef<HTMLDivElement>(null);
  // Escape layer only while shown; ignored while installing.
  useLayer(() => { if (u.kind !== 'installing') appUi.dismissUpdate(); }, { modal: true, enabled: u.kind !== 'idle' });
  if (u.kind === 'idle') return null;

  const info = u.kind === 'available' || u.kind === 'installing' ? u.info : u.kind === 'error' ? u.info : null;
  const busy = u.kind === 'installing';
  let body;
  let actions;
  if (u.kind === 'checking') {
    body = <p className="st-status"><span className="spinner" /> {t('update.checking')}</p>;
    actions = null;
  } else if (u.kind === 'upToDate') {
    body = <p>{t('update.upToDate', { version: '' })}</p>;
    actions = <button className="btn primary" autoFocus onClick={appUi.dismissUpdate}>{t('update.close')}</button>;
  } else if (u.kind === 'error') {
    body = (
      <>
        <p>{u.reason === 'offline' ? t('update.offline') : t('update.failed')}</p>
        {u.reason === 'failed' && <pre className="up-error">{u.message}</pre>}
      </>
    );
    actions = (
      <>
        <button className="btn" onClick={appUi.dismissUpdate}>{t('update.close')}</button>
        <button className="btn primary" autoFocus onClick={() => (u.info ? void appUi.install() : void appUi.check(false))}>{t('update.retry')}</button>
      </>
    );
  } else {
    const pct = u.kind === 'installing' && u.total ? Math.min(100, Math.round((u.downloaded / u.total) * 100)) : null;
    body = (
      <>
        <p><b>{t('update.available', { version: info!.version })}</b><br /><span className="muted">{t('update.current', { version: info!.currentVersion })}</span></p>
        {u.kind === 'available' && (
          <>
            <div className="st-label">{t('update.notes')}</div>
            <pre className="up-notes">{info!.notes?.trim() || t('update.noNotes')}</pre>
          </>
        )}
        {u.kind === 'installing' && (
          <div className="up-progress" role="status">
            <div className="up-bar"><div className={'up-fill' + (pct === null ? ' indeterminate' : '')} style={pct === null ? undefined : { width: pct + '%' }} /></div>
            <div className="muted">
              {u.finished ? t('update.restarting') : u.downloaded > 0 ? t('update.downloading', { done: mb(u.downloaded), total: u.total ? mb(u.total) : '' }) : t('update.installing')}
            </div>
          </div>
        )}
      </>
    );
    actions = busy ? null : (
      <>
        <button className="btn" onClick={appUi.dismissUpdate}>{t('update.later')}</button>
        <button className="btn primary" autoFocus onClick={() => void appUi.install()}>{t('update.install')}</button>
      </>
    );
  }
  return (
    <div className="modal-backdrop" onMouseDown={busy ? undefined : appUi.dismissUpdate}>
      <div ref={ref} className="modal st-modal narrow" role="dialog" aria-modal="true" aria-label={t('update.title')} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{t('update.title')}</h3>
        {body}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}
