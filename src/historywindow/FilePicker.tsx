// Main-window file picker (⌘⇧H / Ctrl+Shift+H, FilterBar button): fuzzy search over `list_files` (HEAD),
// Enter opens the File History window.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import './history.css';
import { call, toAppError } from '../api';
import { Store, useStoreState } from '../ui/state/createStore';
import { rankFiles, type FuzzyMatch } from './fuzzy';
import { openHistoryWindow } from './session';
import { t } from '../i18n';
import { useLayer } from '../ui/common/layers';

interface PickerTarget { repoPath: string; repoName: string }
interface PickerState { target: PickerTarget | null }

class FilePickerStore extends Store<PickerState> {
  constructor() { super({ target: null }); }
  open = (target: PickerTarget): void => this.set({ target });
  close = (): void => this.set({ target: null });
}
export const filePicker = new FilePickerStore();

const fileCache = new Map<string, string[]>();
const LIMIT = 200;

function Highlighted({ text, offset, positions }: { text: string; offset: number; positions: Set<number> }) {
  const out: ReactNode[] = [];
  let buf = '';
  let hl = false;
  const flush = (k: number) => { if (buf) out.push(hl ? <b key={k}>{buf}</b> : buf); buf = ''; };
  for (let i = 0; i < text.length; i++) {
    const h = positions.has(offset + i);
    if (h !== hl) { flush(i); hl = h; }
    buf += text[i];
  }
  flush(text.length);
  return <>{out}</>;
}

function Item({ m, on, onPick }: { m: FuzzyMatch; on: boolean; onPick: () => void }) {
  const slash = m.path.lastIndexOf('/');
  const name = m.path.slice(slash + 1);
  const dir = slash >= 0 ? m.path.slice(0, slash) : '';
  const pos = useMemo(() => new Set(m.positions), [m.positions]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: 'nearest' }); }, [on]);
  return (
    <div ref={ref} className={'fp-item' + (on ? ' on' : '')} role="option" aria-selected={on} onMouseDown={(e) => { e.preventDefault(); onPick(); }} title={m.path}>
      <span className="fp-name"><Highlighted text={name} offset={slash + 1} positions={pos} /></span>
      <span className="fp-dir"><Highlighted text={dir} offset={0} positions={pos} /></span>
    </div>
  );
}

export function FilePickerHost() {
  const target = useStoreState(filePicker, (s) => s.target);
  if (!target) return null;
  return <FilePicker key={target.repoPath} target={target} />;
}

function FilePicker({ target }: { target: PickerTarget }) {
  useLayer(() => filePicker.close(), { modal: true });
  const [files, setFiles] = useState<string[] | null>(() => fileCache.get(target.repoPath) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cur, setCur] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    call('list_files', { repoPath: target.repoPath, rev: null })
      .then((f) => { fileCache.set(target.repoPath, f); if (!cancelled) { setFiles(f); setError(null); } })
      .catch((e) => { if (!cancelled && !fileCache.has(target.repoPath)) setError(toAppError(e).message); });
    return () => { cancelled = true; };
  }, [target.repoPath]);

  const matches = useMemo(() => (files ? rankFiles(query, files, LIMIT) : []), [files, query]);
  useEffect(() => setCur(0), [query]);

  const pick = (m: FuzzyMatch | undefined) => {
    if (!m) return;
    openHistoryWindow({ repoPath: target.repoPath, repoName: target.repoName, path: m.path, rev: null })
      .then(() => filePicker.close())
      .catch((e) => setOpenError(t('changes.historyOpenFail', { msg: toAppError(e).message })));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); filePicker.close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCur((c) => Math.min(matches.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
    else if (e.key === 'PageDown') { e.preventDefault(); setCur((c) => Math.min(matches.length - 1, c + 10)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setCur((c) => Math.max(0, c - 10)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(matches[cur]); }
  };

  return (
    <div className="fp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) filePicker.close(); }}>
      <div className="fp-dialog" role="dialog" aria-label={t('fp.title')} onKeyDown={onKey}>
        <div className="fp-head">
          <span className="fp-title">{t('fp.title')}</span>
          <input
            className="fp-input"
            autoFocus
            spellCheck={false}
            placeholder={t('fp.placeholder')}
            aria-label={t('fp.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="fp-list" role="listbox">
          {error && <div className="fp-empty err">{error}</div>}
          {!error && !files && <div className="fp-empty">{t('common.loading')}</div>}
          {files && matches.length === 0 && <div className="fp-empty">{t('fp.noFiles')}</div>}
          {matches.map((m, i) => <Item key={m.path} m={m} on={i === cur} onPick={() => pick(m)} />)}
        </div>
        <div className="fp-foot">
          <span>{openError ?? t('fp.hint')}</span>
          {files && <span>{t('fp.count', { n: files.length })}</span>}
        </div>
      </div>
    </div>
  );
}
