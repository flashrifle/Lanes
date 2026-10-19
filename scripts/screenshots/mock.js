// Fake Tauri runtime for the screenshot harness. Loaded as a classic script before the app.
// - window.__TAURI_INTERNALS__.invoke forwards app commands to server.py (POST /invoke), which runs git.
// - The event plugin (listen / emit) is emulated in-page; window.__emit(name, payload) fires an event.
// - Window / webview / dialog / opener plugin calls resolve to null.
// - Seeds localStorage for the requested shot (see SHOTS in driver.js for the scenario side).
(function () {
  const q = new URLSearchParams(location.search);
  const locale = q.get('lang') === 'en' ? 'en-US' : 'ko-KR';
  const label = q.has('historySession') ? 'history-shot' : q.has('diffSession') ? 'diff-shot' : q.has('quickCommit') ? 'quick-commit' : 'main';
  const seed = window.__SEED__ || {};

  try {
    localStorage.clear();
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  } catch (e) { /* ignore */ }

  const callbacks = new Map();
  const listeners = new Map(); // event -> Map(eventId -> callbackId)
  let nextCb = 1;
  let nextEvent = 1;

  window.__emit = (event, payload) => {
    const m = listeners.get(event);
    if (!m) return 0;
    for (const [id, cb] of m) {
      const f = callbacks.get(cb);
      if (f) f({ event, id, payload });
    }
    return m.size;
  };
  window.__listenerCount = (event) => listeners.get(event)?.size ?? 0;
  window.__log = (msg) => { try { fetch('/log?msg=' + encodeURIComponent(String(msg).slice(0, 2000))); } catch (e) { /* ignore */ } };

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
    transformCallback(f, once) {
      const id = nextCb++;
      callbacks.set(id, (x) => { if (once) callbacks.delete(id); return f && f(x); });
      return id;
    },
    unregisterCallback(id) { callbacks.delete(id); },
    convertFileSrc(p) { return p; },
    async invoke(cmd, args) {
      args = args || {};
      if (cmd === 'plugin:event|listen') {
        const id = nextEvent++;
        if (!listeners.has(args.event)) listeners.set(args.event, new Map());
        listeners.get(args.event).set(id, args.handler);
        return id;
      }
      if (cmd === 'plugin:event|unlisten') { listeners.get(args.event)?.delete(args.eventId); return null; }
      if (cmd === 'plugin:event|emit' || cmd === 'plugin:event|emit_to') { window.__emit(args.event, args.payload); return null; }
      if (cmd.startsWith('plugin:')) {
        if (cmd === 'plugin:webview|get_all_webviews' || cmd === 'plugin:window|get_all_windows') return [];
        return null;
      }
      const r = await fetch('/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, args: { ...args, __locale: locale } }),
      });
      const body = await r.json();
      if (!r.ok) throw body;
      return body;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) { listeners.get(event)?.delete(id); },
  };

  addEventListener('error', (e) => window.__log('error: ' + e.message + ' ' + (e.filename || '')));
  addEventListener('unhandledrejection', (e) => window.__log('rejection: ' + ((e.reason && (e.reason.stack || e.reason.message)) || JSON.stringify(e.reason))));
  const ce = console.error;
  console.error = (...a) => { window.__log('console.error: ' + a.map(String).join(' ')); ce(...a); };
})();
