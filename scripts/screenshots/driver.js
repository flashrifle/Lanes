// Drives the app into the state for one shot. Loaded as a module after src/main.tsx; it imports the app's own
// store modules from the Vite dev server (same URLs as the app, so the same module instances).
const VITE = 'http://localhost:1420';
const S = window.__SHOT__;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { const v = fn(); if (v) return v; } catch (e) { /* not yet */ }
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + what);
}

/** Set a React-controlled textarea / input value the way typing would. */
function typeInto(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function mainWindow() {
  const { appStore } = await import(VITE + '/src/ui/state/appStore.ts');
  const store = await until(() => appStore.activeStore(), 'repo tab');
  const st = await until(() => { const s = store.getState(); return s.layout && s.snapshot ? s : null; }, 'log');
  await until(() => store.commit.getState().status, 'status');
  const rowOfHash = (h) => st.layout.rowOf(st.snapshot.hashes.indexOf(h));
  if (S.shot === 'changes') {
    store.selectWorking();
    store.commit.setMessage(S.text.message);
  } else {
    const row = rowOfHash(S.commit);
    if (row < 0) throw new Error('commit not in log: ' + S.commit);
    store.selectRowAt(row, { shift: false, toggle: false });
  }
  if (S.shot === 'highlight') {
    const ci = st.snapshot.hashes.indexOf(S.highlight);
    store.setHighlightKey(st.layout.lineKey(st.layout.lineOf(ci)));
  }
}

async function quickCommit() {
  await until(() => window.__listenerCount('quick-commit-target') > 0, 'quick-commit listener');
  window.__emit('quick-commit-target', { repoPath: S.repo.path });
  const ta = await until(() => { const t = document.querySelector('.qc-msg'); return t && document.querySelector('.qc-file') ? t : null; }, 'quick commit files');
  typeInto(ta, S.text.quickMessage);
  ta.blur();
}

(async () => {
  try {
    if (S.shot === 'quick') await quickCommit();
    else if (S.shot === 'main' || S.shot === 'highlight' || S.shot === 'changes') await mainWindow();
    await sleep(400);
    document.documentElement.dataset.shotReady = '1';
    window.__log('ready: ' + S.shot + '/' + S.lang);
  } catch (e) {
    window.__log('driver failed: ' + (e && e.stack || e));
  }
})();
