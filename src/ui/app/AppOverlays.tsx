// App-level overlays owned by ui-app: Settings dialog, update dialog + launch check, menu-action handling.
// Mounted once at the App root.
import { useEffect, useRef, useState } from 'react';
import { onEvent, toAppError } from '../../api';
import { t } from '../../i18n';
import { EVENT_MENU_ACTION, type MenuActionEvent } from '../../types';
import { Toast } from '../dialogs/Toast';
import { hasMod } from '../platform';
import type { ToastState } from '../state/repoStore';
import { appUi, useAppUi } from './appUi';
import { openReportIssue } from './openReport';
import { getSettings, loadSettings, settingsLoaded } from './settingsStore';
import { SettingsDialog } from './SettingsDialog';
import { UpdateDialog } from './UpdateDialog';

let launchChecked = false; // once per app run, even if the root remounts (language switch)
let toastId = 1;

export function AppOverlays() {
  const settingsOpen = useAppUi((s) => s.settingsOpen);
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const showToast = (kind: 'error' | 'info', text: string) => {
    clearTimeout(timer.current);
    const id = toastId++;
    setToast({ id, kind, text });
    timer.current = setTimeout(() => setToast((x) => (x?.id === id ? null : x)), kind === 'error' ? 8000 : 4000);
  };
  const toastRef = useRef(showToast);
  toastRef.current = showToast;

  // menu-action from the native menu / tray
  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    onEvent<MenuActionEvent>(EVENT_MENU_ACTION, (e) => {
      if (e.action === 'settings') appUi.openSettings();
      else if (e.action === 'checkForUpdates') void appUi.check(false);
      else if (e.action === 'reportIssue') {
        openReportIssue().catch((err) => toastRef.current('error', t('report.openFail', { msg: toAppError(err).message })));
      }
    })
      .then((u) => (dead ? u() : (un = u)))
      .catch(() => {});
    return () => { dead = true; un?.(); };
  }, []);

  // ⌘,
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (hasMod(e) && !e.shiftKey && !e.altKey && e.key === ',') { e.preventDefault(); appUi.openSettings(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // silent launch check
  useEffect(() => {
    if (launchChecked) return;
    launchChecked = true;
    void (async () => {
      if (!settingsLoaded()) await loadSettings();
      if (getSettings().checkForUpdates) await appUi.check(true);
    })();
  }, []);

  return (
    <>
      {settingsOpen && <SettingsDialog onToast={showToast} />}
      <UpdateDialog />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
