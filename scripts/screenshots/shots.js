// Shot definitions, shared by the page (seeding + driver) and shoot.mjs (window sizes / URLs).
// Classic script: runs before mock.js. Seeds localStorage synchronously (sync XHR to server.py) so the app
// reads the right tabs / split sizes / window sessions on its first render.
(function (root) {
  const TEXT = {
    ko: {
      commit: 'Undo Commit',        // selected commit (main shots, diff window)
      highlight: '작업 버튼 줄',       // its branch line is highlighted in the "highlight" shot
      message: 'docs: 홈페이지 링크 추가\n\nREADME와 릴리스 노트에 GitHub Pages 주소를 넣음',
      quickMessage: 'docs: README에 웹사이트 주소 추가',
      historySelect: '화살표 방향을',     // history window: selected commit
    },
    en: {
      commit: 'Undo Commit',
      highlight: 'repo action toolbar',
      message: 'docs: add homepage link\n\nPoint the README and the release notes at the GitHub Pages site',
      quickMessage: 'docs: add the website to the README',
      historySelect: 'orient arrows',
    },
  };
  // name: [width, height, extra query]. Chrome's headless window can't be narrower than ~500px, so narrower
  // shots are laid out at that width with the page pinned to `width` (index.html) and cropped by shoot.mjs.
  const SHOTS = {
    main: [1440, 900, ''],
    highlight: [1440, 900, ''],
    changes: [1440, 900, ''],
    history: [1400, 860, 'historySession=shot'],
    diff: [1300, 820, 'diffSession=shot'],
    quick: [380, 520, 'quickCommit=1'],
  };
  const CONFIG = {
    historyFile: 'src/ui/log/GraphCell.tsx',
    diffFile: 'src/ui/commit/commitStore.ts',
  };
  root.__SHOTS__ = { TEXT, SHOTS, CONFIG };
  if (typeof document === 'undefined') return;

  const q = new URLSearchParams(location.search);
  const shot = q.get('shot') || 'main';
  const lang = q.get('lang') === 'en' ? 'en' : 'ko';
  const text = TEXT[lang];

  function call(cmd, args) {
    const x = new XMLHttpRequest();
    x.open('POST', '/invoke', false);
    x.setRequestHeader('Content-Type', 'application/json');
    x.send(JSON.stringify({ cmd, args: args || {} }));
    return JSON.parse(x.responseText);
  }

  const repo = call('get_recent_repos')[0];
  const commit = call('__find', { text: text.commit });
  const highlight = call('__find', { text: text.highlight });
  const seed = {
    'tabs:v1': { paths: [repo.path], active: repo.path },
    'split:branches': '250',
    'split:right': '460',
    'split:changes': '250',
  };
  if (shot === 'history') {
    seed['history-session:shot'] = { repoPath: repo.path, repoName: repo.name, path: CONFIG.historyFile, rev: null,
      selectHash: call('__find', { text: text.historySelect }) };
    seed['history-session-latest'] = 'shot';
    seed['hw-prefs'] = { mode: 'blame', collapse: false };
  }
  if (shot === 'diff') {
    const files = call('get_changed_files', { repoPath: repo.path, hashes: [commit] }).files;
    const details = call('get_commit_details', { repoPath: repo.path, hash: commit });
    seed['diff-session:shot'] = {
      repoPath: repo.path, repoName: repo.name, files,
      index: Math.max(0, files.findIndex((f) => f.path === CONFIG.diffFile)), title: details.subject,
    };
    seed['diff-session-latest'] = 'shot';
    seed['dw-prefs'] = { mode: 'sbs', collapse: true };
  }
  root.__SEED__ = seed;
  root.__SHOT__ = { shot, lang, text, commit, highlight, repo, config: CONFIG };
})(typeof window !== 'undefined' ? window : globalThis);
