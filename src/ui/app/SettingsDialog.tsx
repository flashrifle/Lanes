// Settings dialog (⌘, / menu-action 'settings'). Simple controls save immediately; text fields commit on blur/Enter,
// the git path only after validate_git_path succeeds. Owned by ui-app.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useModal } from '../common/layers';
import './app.css';
import { call, toAppError } from '../../api';
import { t } from '../../i18n';
import type { AppSettings, Diagnostics, GitPathCheck } from '../../types';
import { densityLabel } from '../log/density';
import { appUi } from './appUi';
import { recordError } from './lastError';
import { openReportIssue } from './openReport';
import { saveSettings, useSettings } from './settingsStore';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-label">
        {label}
        {hint && <div className="st-hint">{hint}</div>}
      </div>
      <div className="st-ctl">{children}</div>
    </div>
  );
}

const FETCH_OPTIONS: (number | null)[] = [null, 15, 30, 60];

export function SettingsDialog({ onToast }: { onToast: (kind: 'error' | 'info', text: string) => void }) {
  const s = useSettings();
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [gitMode, setGitMode] = useState<'auto' | 'custom'>(s.gitPath ? 'custom' : 'auto');
  const [gitInput, setGitInput] = useState(s.gitPath ?? '');
  const [gitCheck, setGitCheck] = useState<{ busy: boolean; result: GitPathCheck | null; applied: boolean }>({ busy: false, result: null, applied: false });
  const [editor, setEditor] = useState(s.externalEditor ?? '');

  const patch = (p: Partial<AppSettings>) => {
    saveSettings(p).catch((e) => {
      const err = toAppError(e);
      recordError(err);
      onToast('error', t('settings.saveFail', { msg: err.message }));
    });
  };


  useEffect(() => {
    call('get_diagnostics', {}).then(setDiag).catch(() => {});
  }, []);

  // what auto-detect would pick
  useEffect(() => {
    if (gitMode !== 'auto') return;
    let cancelled = false;
    setGitCheck({ busy: true, result: null, applied: false });
    call('validate_git_path', { path: null })
      .then((r) => { if (!cancelled) setGitCheck({ busy: false, result: r, applied: false }); })
      .catch(() => { if (!cancelled) setGitCheck({ busy: false, result: null, applied: false }); });
    return () => { cancelled = true; };
  }, [gitMode, s.gitPath]);

  const chooseGitMode = (m: 'auto' | 'custom') => {
    setGitMode(m);
    if (m === 'auto' && s.gitPath !== null) patch({ gitPath: null });
  };

  const applyCustomGit = async () => {
    const path = gitInput.trim();
    if (!path) return;
    setGitCheck({ busy: true, result: null, applied: false });
    try {
      const r = await call('validate_git_path', { path });
      if (r.ok) {
        await saveSettings({ gitPath: r.path ?? path });
        setGitCheck({ busy: false, result: r, applied: true });
      } else setGitCheck({ busy: false, result: r, applied: false });
    } catch (e) {
      const err = toAppError(e);
      setGitCheck({ busy: false, result: { ok: false, path: null, version: null, message: err.message }, applied: false });
    }
  };

  const commitEditor = () => {
    const v = editor.trim() || null;
    if (v !== s.externalEditor) patch({ externalEditor: v });
  };
  const editorDirty = (editor.trim() || null) !== s.externalEditor;
  // Close (button, Escape, backdrop) commits a pending editor edit first, so it is never silently dropped.
  const close = () => { commitEditor(); appUi.closeSettings(); };
  const ref = useRef<HTMLDivElement>(null);
  useModal(ref, close);

  const gr = gitCheck.result;
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div ref={ref} className="modal st-modal" role="dialog" aria-modal="true" tabIndex={-1} aria-label={t('settings.title')} onMouseDown={(e) => e.stopPropagation()}>
        <div className="st-head">
          <h3>{t('settings.title')}</h3>
          <button className="icon-btn" aria-label={t('settings.close')} onClick={close}>×</button>
        </div>
        <div className="st-body">
          <Row label={t('settings.language')}>
            <select value={s.language} onChange={(e) => patch({ language: e.target.value as AppSettings['language'] })}>
              <option value="system">{t('settings.language.system')}</option>
              <option value="ko">{t('settings.language.ko')}</option>
              <option value="en">{t('settings.language.en')}</option>
            </select>
          </Row>
          <Row label={t('settings.density')}>
            <select value={s.density} onChange={(e) => patch({ density: e.target.value as AppSettings['density'] })}>
              <option value="comfortable">{densityLabel('comfortable')}</option>
              <option value="compact">{densityLabel('compact')}</option>
            </select>
          </Row>
          <Row label={t('settings.dateFormat')}>
            <select value={s.dateFormat} onChange={(e) => patch({ dateFormat: e.target.value as AppSettings['dateFormat'] })}>
              <option value="relative">{t('settings.date.relative')}</option>
              <option value="absolute">{t('settings.date.absolute')}</option>
            </select>
          </Row>

          <div className="st-sep" />
          <Row label={t('settings.git')}>
            <div className="st-stack">
              <label className="st-check"><input type="radio" name="st-git" checked={gitMode === 'auto'} onChange={() => chooseGitMode('auto')} />{t('settings.git.auto')}</label>
              <label className="st-check"><input type="radio" name="st-git" checked={gitMode === 'custom'} onChange={() => chooseGitMode('custom')} />{t('settings.git.custom')}</label>
              {gitMode === 'custom' && (
                <div className="st-inline">
                  <input
                    className="st-input mono"
                    value={gitInput}
                    placeholder={t('settings.git.pathPh')}
                    spellCheck={false}
                    onChange={(e) => { setGitInput(e.target.value); setGitCheck({ busy: false, result: null, applied: false }); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void applyCustomGit(); }}
                  />
                  <button className="btn small" disabled={!gitInput.trim() || gitCheck.busy} onClick={() => void applyCustomGit()}>{t('settings.git.check')}</button>
                </div>
              )}
              <div className={'st-status' + (gr && !gr.ok ? ' err' : '')} aria-live="polite">
                {gitCheck.busy ? t('settings.git.checking')
                  : gr?.ok ? <>{t('settings.git.found', { version: gr.version ?? '?', path: gr.path ?? '' })}{gitCheck.applied && <span className="st-ok"> · {t('settings.git.applied')}</span>}{gr.message && <div className="st-warn">{gr.message}</div>}</>
                  : gr ? (gr.message || t('settings.git.notFound'))
                  : null}
              </div>
            </div>
          </Row>
          <Row label={t('settings.editor')} hint={t('settings.editor.hint')}>
            <input
              className="st-input"
              value={editor}
              placeholder={t('settings.editor.ph')}
              spellCheck={false}
              onChange={(e) => setEditor(e.target.value)}
              onBlur={commitEditor}
              onKeyDown={(e) => { if (e.key === 'Enter') { commitEditor(); (e.target as HTMLInputElement).blur(); } }}
            />
            {editorDirty && <div className="st-hint" aria-live="polite">{t('settings.editor.unsaved')}</div>}
          </Row>

          <div className="st-sep" />
          <Row label={t('settings.updates')}>
            <div className="st-inline">
              <label className="st-check"><input type="checkbox" checked={s.checkForUpdates} onChange={(e) => patch({ checkForUpdates: e.target.checked })} />{t('settings.updates.auto')}</label>
              <button className="btn small" onClick={() => { close(); void appUi.check(false); }}>{t('settings.updates.now')}</button>
            </div>
          </Row>
          <Row label={t('settings.menuBar')}>
            <div className="st-stack">
              <label className="st-check"><input type="checkbox" checked={s.menuBarIcon} onChange={(e) => patch({ menuBarIcon: e.target.checked })} />{t('settings.menuBar.icon')}</label>
              <label className="st-check" title={s.menuBarIcon ? undefined : t('settings.menuBar.needsIcon')}>
                <input type="checkbox" disabled={!s.menuBarIcon} checked={s.menuBarIcon && s.keepRunningInMenuBar} onChange={(e) => patch({ keepRunningInMenuBar: e.target.checked })} />
                {t('settings.menuBar.keep')}
              </label>
            </div>
          </Row>
          <Row label={t('settings.fetch')}>
            <select value={s.backgroundFetchMinutes ?? ''} onChange={(e) => patch({ backgroundFetchMinutes: e.target.value === '' ? null : Number(e.target.value) })}>
              {FETCH_OPTIONS.map((m) => (
                <option key={m ?? 'off'} value={m ?? ''}>{m === null ? t('settings.fetch.off') : t('settings.fetch.min', { n: m })}</option>
              ))}
            </select>
          </Row>
        </div>
        <div className="st-foot">
          <span className="muted">{diag ? t('settings.version', { version: diag.appVersion }) : ''}</span>
          <span className="grow" />
          <button
            className="btn small"
            onClick={() => { openReportIssue().catch((e) => onToast('error', t('report.openFail', { msg: toAppError(e).message }))); }}
          >{t('settings.reportIssue')}</button>
          <button className="btn primary" onClick={close}>{t('settings.close')}</button>
        </div>
      </div>
    </div>
  );
}
