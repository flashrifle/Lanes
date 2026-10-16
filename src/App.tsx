import { useEffect } from 'react';
import './App.css';
import { BranchPanel } from './ui/branches/BranchPanel';
import { Icon } from './ui/common/Icons';
import { ChangesTree } from './ui/details/ChangesTree';
import { CommitDetailsPanel } from './ui/details/CommitDetailsPanel';
import { ConfirmDialog } from './ui/dialogs/ConfirmDialog';
import { CreateBranchDialog } from './ui/dialogs/CreateBranchDialog';
import { Toast } from './ui/dialogs/Toast';
import { DiffView } from './ui/diff/DiffView';
import { SplitPane } from './ui/layout/SplitPane';
import { FilterBar } from './ui/log/FilterBar';
import { LogTable } from './ui/log/LogTable';
import { closeRepo, initApp, useStore } from './ui/state/store';
import { WelcomeScreen } from './ui/welcome/WelcomeScreen';

const OP_LABEL = { merge: '병합 진행 중', rebase: '리베이스 진행 중', cherryPick: '체리픽 진행 중', revert: '되돌리기 진행 중', bisect: '이분 탐색 중' } as const;

function RepoBar() {
  const repo = useStore((s) => s.repo);
  const snapshot = useStore((s) => s.snapshot);
  const head = snapshot?.refs.head;
  const op = snapshot?.refs.operation;
  return (
    <div className="repo-bar">
      <span className="repo-name" title={repo?.path}>{repo?.name}</span>
      {head && (
        <span className="repo-branch">
          <Icon name="branch" size={12} />
          {head.unborn ? '(커밋 없음)' : head.detached ? `HEAD 분리됨 ${head.hash?.slice(0, 8) ?? ''}` : head.branch}
        </span>
      )}
      {op && <span className="repo-op">{OP_LABEL[op]}</span>}
      <span className="grow" />
      {snapshot && <span className="muted">{snapshot.commitCount.toLocaleString('ko-KR')}개 커밋 · {snapshot.loadMillis}ms</span>}
      <button className="btn small" onClick={() => void closeRepo()}>저장소 닫기</button>
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
            <SplitPane dir="v" fixed="start" defaultSize={260} min={80} storageKey="changes">
              <ChangesTree />
              <CommitDetailsPanel />
            </SplitPane>
          </SplitPane>
        </SplitPane>
      </div>
    </div>
  );
}

export default function App() {
  const repo = useStore((s) => s.repo);
  const dialog = useStore((s) => s.dialog);
  useEffect(() => { void initApp(); }, []);
  return (
    <div className="app">
      {repo ? <RepoView /> : <WelcomeScreen />}
      <DiffView />
      {dialog?.kind === 'createBranch' && <CreateBranchDialog startPoint={dialog.startPoint} startLabel={dialog.startLabel} />}
      {dialog?.kind === 'confirm' && <ConfirmDialog dialog={dialog} />}
      <Toast />
    </div>
  );
}
