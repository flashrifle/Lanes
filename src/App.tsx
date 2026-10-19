import { useEffect } from 'react';
import './App.css';
import { BranchPanel } from './ui/branches/BranchPanel';
import { Icon } from './ui/common/Icons';
import { TooltipHost } from './ui/common/Tooltip';
import { ChangesTree } from './ui/details/ChangesTree';
import { CommitDetailsPanel } from './ui/details/CommitDetailsPanel';
import { ConfirmDialog } from './ui/dialogs/ConfirmDialog';
import { CreateBranchDialog } from './ui/dialogs/CreateBranchDialog';
import { Toast } from './ui/dialogs/Toast';
import { SplitPane } from './ui/layout/SplitPane';
import { FilterBar } from './ui/log/FilterBar';
import { LogTable } from './ui/log/LogTable';
import { IS_MAC } from './ui/platform';
import { FilePickerHost, filePicker } from './historywindow/FilePicker';
import { appStore, useApp, type TabEntry } from './ui/state/appStore';
import { RepoCtx, useRepo, useRepoStore } from './ui/state/repoContext';
import { TabBar } from './ui/tabs/TabBar';
import { WelcomeScreen } from './ui/welcome/WelcomeScreen';
import { AppOverlays } from './ui/app/AppOverlays';
import { CommitOverlays } from './ui/commit/CommitOverlays';
import { LocalChangesPanel } from './ui/commit/LocalChangesPanel';
import { OperationBanner } from './ui/commit/OperationBanner';
import { OpsOverlays } from './ui/ops/OpsOverlays';
import { t } from './i18n';

const OP_KEY = { merge: 'op.merge', rebase: 'op.rebase', cherryPick: 'op.cherryPick', revert: 'op.revert', bisect: 'op.bisect' } as const;

function RepoBar() {
  const repo = useRepo((s) => s.repo);
  const snapshot = useRepo((s) => s.snapshot);
  const head = snapshot?.refs.head;
  const op = snapshot?.refs.operation;
  return (
    <div className="repo-bar">
      <span className="repo-name" title={repo.path}>{repo.name}</span>
      {head && (
        <span className="repo-branch">
          <Icon name="branch" size={12} />
          {head.unborn ? t('repo.noCommits') : head.detached ? t('repo.detached', { hash: head.hash?.slice(0, 8) ?? '' }) : head.branch}
        </span>
      )}
      {op && <span className="repo-op">{t(OP_KEY[op])}</span>}
      <OperationBanner />
      <span className="grow" />
      {snapshot && <span className="muted">{t('repo.commitCount', { n: snapshot.commitCount })} · {snapshot.loadMillis}ms</span>}
    </div>
  );
}

function RepoView() {
  return (
    <div className="repo-view">
      <RepoBar />
      <div className="repo-main">
        <SplitPane dir="h" fixed="start" defaultSize={240} min={160} storageKey="branches">
          <BranchPanel />
          <SplitPane dir="h" fixed="end" defaultSize={420} min={260} storageKey="right">
            <div className="center-col">
              <FilterBar />
              <LogTable />
            </div>
            <RightColumn />
          </SplitPane>
        </SplitPane>
      </div>
    </div>
  );
}

/** Right column: local changes while the "Uncommitted changes" row is selected, else the commit's files + details. */
function RightColumn() {
  const working = useRepo((s) => s.workingSelected);
  if (working) return <LocalChangesPanel />;
  return (
    <SplitPane dir="v" fixed="start" defaultSize={260} min={80} storageKey="changes">
      <ChangesTree />
      <CommitDetailsPanel />
    </SplitPane>
  );
}

/** Overlays that belong to the active tab only (their key handlers must not fire for hidden tabs). */
function TabOverlays() {
  const store = useRepoStore();
  const dialog = useRepo((s) => s.dialog);
  const toast = useRepo((s) => s.toast);
  return (
    <>
      {dialog?.kind === 'createBranch' && <CreateBranchDialog startPoint={dialog.startPoint} startLabel={dialog.startLabel} />}
      {dialog?.kind === 'confirm' && <ConfirmDialog dialog={dialog} />}
      <CommitOverlays />
      <OpsOverlays />
      <Toast toast={toast} onDismiss={store.dismissToast} />
    </>
  );
}

function TabPane({ tab, active }: { tab: TabEntry; active: boolean }) {
  return (
    <RepoCtx.Provider value={tab.store}>
      {/* Inactive tabs stay mounted (hidden but laid out) so scroll position and component state survive switching. */}
      <div className={'tab-pane' + (active ? ' active' : '')} aria-hidden={!active} inert={!active}>
        <RepoView />
        {active && <TabOverlays />}
      </div>
    </RepoCtx.Provider>
  );
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        appStore.cycle(e.shiftKey ? -1 : 1);
        return;
      }
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'h' && e.shiftKey) {
        // ⌘⇧H / Ctrl+Shift+H: file picker → File History window
        e.preventDefault();
        const repo = appStore.activeStore()?.getState().repo;
        if (repo) filePicker.open({ repoPath: repo.path, repoName: repo.name });
        return;
      }
      if (k === 't' && !e.shiftKey) { e.preventDefault(); void appStore.chooseAndOpenRepo(); }
      else if (k === 'w' && !e.shiftKey) { e.preventDefault(); appStore.closeActive(); }
      else if (k === 'r' && !e.shiftKey) { e.preventDefault(); appStore.reloadActive(); }
      else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); appStore.activateByShortcut(Number(e.key)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeId);
  const appToast = useApp((s) => s.toast);
  useEffect(() => { void appStore.init(); }, []);
  useGlobalShortcuts();
  return (
    <div className="app">
      {tabs.length > 0 && <TabBar />}
      <div className="app-body">
        {tabs.length === 0 && <WelcomeScreen />}
        {tabs.map((t) => <TabPane key={t.id} tab={t} active={t.id === activeId} />)}
      </div>
      {/* App-level messages (e.g. a failed open) when no tab shows its own toast */}
      <Toast toast={appToast} onDismiss={appStore.dismissToast} />
      <FilePickerHost />
      <AppOverlays />
      <TooltipHost />
    </div>
  );
}
