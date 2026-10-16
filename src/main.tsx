import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './assets/fonts/fonts.css';
import { initI18n } from './i18n';

// The same bundle serves the main window and the separate diff window (index.html?diffSession=<id>).
const App = lazy(() => import('./App'));
const DiffWindowApp = lazy(() => import('./diffwindow/DiffWindowApp'));
const isDiffWindow = new URLSearchParams(window.location.search).has('diffSession');

// Resolve the UI language once, before first render (short timeout: startup never blocks on it).
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <Suspense fallback={null}>{isDiffWindow ? <DiffWindowApp /> : <App />}</Suspense>
    </React.StrictMode>,
  );
});
