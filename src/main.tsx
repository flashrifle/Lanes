import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import './assets/fonts/fonts.css';

// The same bundle serves the main window and the separate diff window (index.html?diffSession=<id>).
const App = lazy(() => import('./App'));
const DiffWindowApp = lazy(() => import('./diffwindow/DiffWindowApp'));
const isDiffWindow = new URLSearchParams(window.location.search).has('diffSession');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>{isDiffWindow ? <DiffWindowApp /> : <App />}</Suspense>
  </React.StrictMode>,
);
