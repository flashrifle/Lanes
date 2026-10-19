import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './assets/fonts/fonts.css';
import { initI18n } from './i18n';

// The same bundle serves the main window, the separate diff window (index.html?diffSession=<id>)
// and the file history window (index.html?historySession=<id>).
const App = lazy(() => import('./App'));
const DiffWindowApp = lazy(() => import('./diffwindow/DiffWindowApp'));
const HistoryWindowApp = lazy(() => import('./historywindow/HistoryWindowApp'));
const query = new URLSearchParams(window.location.search);
const isDiffWindow = query.has('diffSession');
const isHistoryWindow = query.has('historySession');

// Resolve the UI language once, before first render (short timeout: startup never blocks on it).
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>{isDiffWindow ? <DiffWindowApp /> : isHistoryWindow ? <HistoryWindowApp /> : <App />}</Suspense>
    </React.StrictMode>,
  );
});
