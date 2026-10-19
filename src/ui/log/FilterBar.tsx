import { useEffect, useRef, useState } from 'react';
import type { GraphSortType } from '../../types';
import { Dropdown } from '../common/Dropdown';
import { Icon } from '../common/Icons';
import { datePresetRange, parseDateInput, type DatePreset } from '../state/logic';
import { Tooltip } from '../common/Tooltip';
import { useRepo, useRepoStore } from '../state/repoContext';
import { modKey } from '../platform';
import { filePicker } from '../../historywindow/FilePicker';
import { DENSITIES, densityLabel, setDensity, useDensity, type Density } from './density';
import { colorOf, MUTED_LINE } from './palette';
import { t, type Key } from '../../i18n';
import { call } from '../../api';
import type { CompareSummary } from '../../types';
import { currentRev, headCtxOf, shortHash } from '../ops/logic';

const SORTS: { id: GraphSortType; key: Key }[] = [
  { id: 'bek', key: 'sort.bek' },
  { id: 'normal', key: 'sort.normal' },
  { id: 'linearBek', key: 'sort.linearBek' },
];

const PRESETS: { id: DatePreset; key: Key }[] = [
  { id: 'today', key: 'preset.today' },
  { id: 'week', key: 'preset.week' },
  { id: 'month', key: 'preset.month' },
  { id: 'year', key: 'preset.year' },
];

function toDateInput(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function FilterBar() {
  const store = useRepoStore();
  const { reload, setDateRange, setPaths, setScopeRefs, setSort, setTextFilter, setUsers } = store;
  const filterUi = useRepo((s) => s.filterUi);
  const filterError = useRepo((s) => s.filterError);
  const scopeRefs = useRepo((s) => s.scopeRefs);
  const snapshot = useRepo((s) => s.snapshot);
  const authors = useRepo((s) => s.authors);
  const repo = useRepo((s) => s.repo);
  const sort = useRepo((s) => s.sort);
  const loading = useRepo((s) => s.loading);
  const layout = useRepo((s) => s.layout);
  const density = useDensity();
  const revRange = filterUi.revRange;
  const [cmpA, setCmpA] = useState('');
  const [cmpB, setCmpB] = useState('');
  const [counts, setCounts] = useState<CompareSummary | null>(null);
  const snapId = snapshot?.snapshotId;
  useEffect(() => {
    setCounts(null);
    if (!revRange || !repo) return;
    let cancelled = false;
    call('compare_refs', { repoPath: repo.path, a: revRange.include, b: revRange.exclude })
      .then((c) => { if (!cancelled) setCounts(c); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [revRange?.include, revRange?.exclude, repo?.path, snapId]); // eslint-disable-line react-hooks/exhaustive-deps

  const [text, setText] = useState(filterUi.text.text);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const first = useRef(true);
  const regex = filterUi.text.regex;
  const matchCase = filterUi.text.matchCase;
  // The debounced timer must see the *current* flags, not the ones captured when it was scheduled.
  const flags = useRef({ regex, matchCase });
  flags.current = { regex, matchCase };
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTextFilter({ text: textRef.current, ...flags.current }), 300);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  /** Flag toggles apply immediately (with the current text) and cancel any pending debounced edit. */
  const toggleFlag = (patch: Partial<{ regex: boolean; matchCase: boolean }>) => {
    clearTimeout(timer.current);
    setTextFilter({ text: textRef.current, ...flags.current, ...patch });
  };

  // external reset (e.g. repo switch)
  useEffect(() => { if (filterUi.text.text === '' && text !== '') setText(''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterUi.text.text]);

  const refs = snapshot?.refs.refs ?? [];
  const shortOf = (full: string) => refs.find((r) => r.fullName === full)?.name ?? (/^[0-9a-f]{40}$/.test(full) ? shortHash(full) : full.replace(/^refs\/(heads|remotes|tags)\//, ''));
  const branchLabel = scopeRefs ? t('filter.branchN', { n: scopeRefs.length }) : t('filter.branch');
  const dotOf = (full: string): string => {
    const r = refs.find((x) => x.fullName === full);
    const row = r?.index != null && layout ? layout.rowOf(r.index) : -1;
    return row >= 0 && layout ? colorOf(layout.getRow(row).nodeColor) : MUTED_LINE;
  };
  const selectable = refs.filter((r) => r.type === 'head' || r.type === 'localBranch' || r.type === 'remoteBranch');
  const toggleScope = (full: string) => {
    const cur = scopeRefs ?? [];
    setScopeRefs(cur.includes(full) ? cur.filter((x) => x !== full) : [...cur, full]);
  };

  const users = filterUi.users;
  const me = repo?.user.email ?? repo?.user.name ?? null;
  const toggleUser = (u: string) => {
    const cur = users ?? [];
    const next = cur.includes(u) ? cur.filter((x) => x !== u) : [...cur, u];
    setUsers(next.length ? next : null);
  };

  const date = filterUi.date;
  const dateActive = !!date && (date.since != null || date.until != null);
  const sortKey = SORTS.find((s) => s.id === sort)?.key;
  const sortLabel = sortKey ? t(sortKey) : '';
  const dateLabel = !dateActive ? t('filter.date') : t('filter.dateRange', { from: toDateInput(date!.since) || '…', to: toDateInput(date!.until) || '…' });

  const paths = filterUi.paths;
  const [pathInput, setPathInput] = useState('');
  const addPath = () => {
    const p = pathInput.trim().replace(/^\.?\//, '');
    if (!p) return;
    setPaths([...(paths ?? []).filter((x) => x !== p), p]);
    setPathInput('');
  };

  return (
    <div className="filter-bar">
      <div className={'search-box' + (filterError ? ' error' : '')}>
        <Icon name="search" size={13} />
        <input
          value={text}
          placeholder={t('filter.searchPh')}
          spellCheck={false}
          aria-label={t('filter.searchAria')}
          aria-invalid={filterError}
          title={filterError ? t('filter.badRegex') : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <Tooltip label={regex ? t('filter.regexOn') : t('filter.regexOff')}>
          <button className={'toggle' + (regex ? ' on' : '')} aria-pressed={regex} onClick={() => toggleFlag({ regex: !regex })}>.*</button>
        </Tooltip>
        <Tooltip label={matchCase ? t('filter.caseOn') : t('filter.caseOff')}>
          <button className={'toggle' + (matchCase ? ' on' : '')} aria-pressed={matchCase} onClick={() => toggleFlag({ matchCase: !matchCase })}>Cc</button>
        </Tooltip>
      </div>

      <Dropdown label={branchLabel} active={!!scopeRefs} title={t('filter.branchTitle')}>
        {() => (
          <div className="pop-list">
            <label className="pop-item"><input type="radio" checked={!scopeRefs} onChange={() => setScopeRefs(null)} />{t('filter.allBranches')}</label>
            <div className="pop-sep" />
            {selectable.map((r) => (
              <label key={r.fullName} className="pop-item">
                <input type="checkbox" checked={!!scopeRefs?.includes(r.fullName)} onChange={() => toggleScope(r.fullName)} />
                {r.type === 'head' ? 'HEAD' : r.name}
              </label>
            ))}
          </div>
        )}
      </Dropdown>

      {scopeRefs && scopeRefs.map((full) => (
        <span key={full} className="chip" title={full}>
          <i className="chip-dot" style={{ background: dotOf(full) }} />
          <span className="chip-text">{shortOf(full)}</span>
          <Tooltip label={t('filter.removeBranchTip')} side="bottom">
            <button className="chip-x" aria-label={t('filter.removeBranchAria', { name: shortOf(full) })} onClick={() => { const n = scopeRefs.filter((x) => x !== full); setScopeRefs(n.length ? n : null); }}>
              <Icon name="close" size={9} />
            </button>
          </Tooltip>
        </span>
      ))}

      <Dropdown label={t('compare.label')} active={!!revRange} title={t('compare.title')}>
        {(close) => {
          const opts = refs.filter((r) => r.type !== 'head');
          const head = headCtxOf(snapshot?.refs);
          const a = cmpA || revRange?.include || currentRev(head);
          const b = cmpB || revRange?.exclude || (opts.find((r) => r.type === 'localBranch' && !r.isCurrent)?.fullName ?? '');
          const sel = (v: string, set: (x: string) => void) => (
            <select value={v} onChange={(e) => set(e.target.value)}>
              {head.fullName == null && <option value="">—</option>}
              {head.fullName != null && <option value={head.fullName}>{head.branch} (HEAD)</option>}
              {opts.filter((r) => r.fullName !== head.fullName).map((r) => <option key={r.fullName} value={r.fullName}>{r.name}</option>)}
            </select>
          );
          return (
            <div className="compare-pop">
              <label>{t('compare.a')}{sel(a, setCmpA)}</label>
              <label>{t('compare.b')}{sel(b, setCmpB)}</label>
              <button className="btn primary small" disabled={!a || !b || a === b} onClick={() => { store.ops.compare(a, b); close(); }}>{t('compare.apply')}</button>
            </div>
          );
        }}
      </Dropdown>

      {revRange && (
        <span className="chip compare" title={t('compare.chipTip', { a: shortOf(revRange.include), b: shortOf(revRange.exclude) })}>
          <span className="chip-text">{shortOf(revRange.include)} ↔ {shortOf(revRange.exclude)}</span>
          {counts && <span className="compare-counts">{t('compare.counts', { a: counts.aOnly, b: counts.bOnly })}{counts.mergeBase ? ` · ${t('compare.base', { hash: shortHash(counts.mergeBase) })}` : ''}</span>}
          <Tooltip label={t('compare.swap')} side="bottom">
            <button className="chip-x" aria-label={t('compare.swap')} onClick={() => store.ops.compare(revRange.exclude, revRange.include)}>⇄</button>
          </Tooltip>
          <Tooltip label={t('compare.clear')} side="bottom">
            <button className="chip-x" aria-label={t('compare.clear')} onClick={() => store.ops.clearCompare()}><Icon name="close" size={9} /></button>
          </Tooltip>
        </span>
      )}

      <Dropdown label={users ? t('filter.userLabel', { v: users.length === 1 ? users[0] : t('filter.userCount', { n: users.length }) }) : t('filter.user')} active={!!users} onClear={() => setUsers(null)} title={t('filter.userTitle')}>
        {() => (
          <div className="pop-list">
            {me && (
              <label className="pop-item"><input type="checkbox" checked={!!users?.includes(me)} onChange={() => toggleUser(me)} />{t('filter.me', { name: repo?.user.name ?? me })}</label>
            )}
            {authors.slice(0, 300).map((a) => (
              <label key={a.email + a.name} className="pop-item" title={a.email}>
                <input type="checkbox" checked={!!users?.includes(a.email)} onChange={() => toggleUser(a.email)} />
                <span className="grow">{a.name}</span><span className="muted">{a.commitCount}</span>
              </label>
            ))}
            {authors.length === 0 && <div className="pop-empty">{t('filter.noUsers')}</div>}
          </div>
        )}
      </Dropdown>

      <Dropdown label={dateLabel} active={dateActive} onClear={() => setDateRange(null)} title={t('filter.dateTitle')}>
        {(close) => (
          <div className="pop-list">
            {PRESETS.map((p) => (
              <button key={p.id} className="pop-item btn-like" onClick={() => { setDateRange(datePresetRange(p.id)); close(); }}>{t(p.key)}</button>
            ))}
            <div className="pop-sep" />
            <div className="pop-row">
              <span>{t('filter.from')}</span>
              <input type="date" value={toDateInput(date?.since ?? null)} onChange={(e) => setDateRange({ since: parseDateInput(e.target.value, false), until: date?.until ?? null })} />
            </div>
            <div className="pop-row">
              <span>{t('filter.to')}</span>
              <input type="date" value={toDateInput(date?.until ?? null)} onChange={(e) => setDateRange({ since: date?.since ?? null, until: parseDateInput(e.target.value, true) })} />
            </div>
          </div>
        )}
      </Dropdown>

      <Dropdown label={paths ? t('filter.pathLabel', { v: paths.length === 1 ? paths[0] : t('filter.pathCount', { n: paths.length }) }) : t('filter.path')} active={!!paths} onClear={() => setPaths(null)} title={t('filter.pathTitle')}>
        {() => (
          <div className="pop-list wide">
            <div className="pop-row">
              <input
                autoFocus
                placeholder={t('filter.pathPh')}
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addPath(); }}
              />
            </div>
            {(paths ?? []).map((p) => (
              <div key={p} className="pop-item">
                <span className="grow">{p}</span>
                <Tooltip label={t('filter.pathRemove')} side="left">
                  <button className="icon-btn" onClick={() => { const n = (paths ?? []).filter((x) => x !== p); setPaths(n.length ? n : null); }}><Icon name="close" size={10} /></button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </Dropdown>

      <div className="grow" />

      <Dropdown label={<Icon name="sort" size={14} />} title={t('filter.sortTitle', { sort: sortLabel, density: densityLabel(density) })} align="right">
        {(close) => (
          <div className="pop-list">
            <div className="pop-title">{t('filter.sort')}</div>
            {SORTS.map((s) => (
              <label key={s.id} className="pop-item">
                <input type="radio" checked={sort === s.id} onChange={() => { setSort(s.id); close(); }} />{t(s.key)}
              </label>
            ))}
            <div className="pop-sep" />
            <div className="pop-title">{t('filter.rowHeight')}</div>
            {(Object.keys(DENSITIES) as Density[]).map((d) => (
              <label key={d} className="pop-item">
                <input type="radio" checked={density === d} onChange={() => { setDensity(d); close(); }} />
                {densityLabel(d)}<span className="muted grow" style={{ textAlign: 'right' }}>{DENSITIES[d].rowH}px</span>
              </label>
            ))}
          </div>
        )}
      </Dropdown>
      <Tooltip label={t('fp.open')} shortcut={modKey('H', true)}>
        <button className="icon-btn" onClick={() => { if (repo) filePicker.open({ repoPath: repo.path, repoName: repo.name }); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6M8 5v3.2l2.2 1.4" />
          </svg>
        </button>
      </Tooltip>
      <Tooltip label={t('filter.refresh')} shortcut={modKey('R')}>
        <button className={'icon-btn' + (loading ? ' spin' : '')} onClick={() => void reload()}>
          <Icon name="refresh" size={14} />
        </button>
      </Tooltip>
    </div>
  );
}
