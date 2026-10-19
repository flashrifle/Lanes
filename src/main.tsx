import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './assets/fonts/fonts.css';
import { initI18n, LangRoot } from './i18n';

// The same bundle serves the main window, the separate diff window (index.html?diffSession=<id>)
// the file history window (index.html?historySession=<id>) and the menu bar quick-commit popover (?quickCommit=1).
const App = lazy(() => import('./App'));
const DiffWindowApp = lazy(() => import('./diffwindow/DiffWindowApp'));
const HistoryWindowApp = lazy(() => import('./historywindow/HistoryWindowApp'));
const QuickCommitApp = lazy(() => import('./quickcommit/QuickCommitApp'));
const query = new URLSearchParams(window.location.search);
const isDiffWindow = query.has('diffSession');
const isHistoryWindow = query.has('historySession');
const isQuickCommit = query.has('quickCommit');

// Resolve the UI language once, before first render (short timeout: startup never blocks on it).
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      {/* Remounts on language / date-format change so every t() call re-renders. */}
      <LangRoot>
        <Suspense fallback={null}>{isDiffWindow ? <DiffWindowApp /> : isHistoryWindow ? <HistoryWindowApp /> : isQuickCommit ? <QuickCommitApp /> : <App />}</Suspense>
      </LangRoot>
    </React.StrictMode>,
  );
});
