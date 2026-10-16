import { useEffect, useRef, useState } from 'react';
import type { GraphSortType } from '../../types';
import { Dropdown } from '../common/Dropdown';
import { Icon } from '../common/Icons';
import { datePresetRange, parseDateInput, type DatePreset } from '../state/logic';
import { reload, setDateRange, setPaths, setScopeRefs, setSort, setTextFilter, setUsers, useStore } from '../state/store';

const SORTS: { id: GraphSortType; label: string }[] = [
  { id: 'bek', label: '표준 (BEK)' },
  { id: 'normal', label: '날짜순' },
  { id: 'linearBek', label: '선형 (Linear BEK)' },
];

const PRESETS: { id: DatePreset; label: string }[] = [
  { id: 'today', label: '오늘' },
  { id: 'week', label: '최근 7일' },
  { id: 'month', label: '최근 30일' },
  { id: 'year', label: '최근 1년' },
];

function toDateInput(ts: number | null): string {
  if (ts == null) return '';
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function FilterBar() {
  const filterUi = useStore((s) => s.filterUi);
  const filterError = useStore((s) => s.filterError);
  const scopeRefs = useStore((s) => s.scopeRefs);
  const snapshot = useStore((s) => s.snapshot);
  const authors = useStore((s) => s.authors);
  const repo = useStore((s) => s.repo);
  const sort = useStore((s) => s.sort);
  const loading = useStore((s) => s.loading);

  const [text, setText] = useState(filterUi.text.text);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const first = useRef(true);
  const regex = filterUi.text.regex;
  const matchCase = filterUi.text.matchCase;

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTextFilter({ text, regex, matchCase }), 300);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // external reset (e.g. repo switch)
  useEffect(() => { if (filterUi.text.text === '' && text !== '') setText(''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterUi.text.text]);

  const refs = snapshot?.refs.refs ?? [];
  const shortOf = (full: string) => refs.find((r) => r.fullName === full)?.name ?? full.replace(/^refs\/(heads|remotes|tags)\//, '');
  const branchLabel = scopeRefs ? `브랜치: ${scopeRefs.map(shortOf).join(', ')}` : '브랜치';
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
  const dateLabel = !dateActive ? '날짜' : `날짜: ${toDateInput(date!.since) || '…'} ~ ${toDateInput(date!.until) || '…'}`;

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
          placeholder="텍스트 또는 해시"
          spellCheck={false}
          title={filterError ? '잘못된 정규식입니다 (Rust regex 문법)' : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <button className={'toggle' + (regex ? ' on' : '')} title="정규식" onClick={() => setTextFilter({ text, regex: !regex, matchCase })}>.*</button>
        <button className={'toggle' + (matchCase ? ' on' : '')} title="대소문자 구분" onClick={() => setTextFilter({ text, regex, matchCase: !matchCase })}>Cc</button>
      </div>

      <Dropdown label={branchLabel} active={!!scopeRefs} onClear={() => setScopeRefs(null)} title="브랜치 필터">
        {() => (
          <div className="pop-list">
            <label className="pop-item"><input type="radio" checked={!scopeRefs} onChange={() => setScopeRefs(null)} />모든 브랜치</label>
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

      <Dropdown label={users ? `사용자: ${users.length === 1 ? users[0] : users.length + '명'}` : '사용자'} active={!!users} onClear={() => setUsers(null)} title="사용자 필터">
        {() => (
          <div className="pop-list">
            {me && (
              <label className="pop-item"><input type="checkbox" checked={!!users?.includes(me)} onChange={() => toggleUser(me)} />나 ({repo?.user.name ?? me})</label>
            )}
            {authors.slice(0, 300).map((a) => (
              <label key={a.email + a.name} className="pop-item" title={a.email}>
                <input type="checkbox" checked={!!users?.includes(a.email)} onChange={() => toggleUser(a.email)} />
                <span className="grow">{a.name}</span><span className="muted">{a.commitCount}</span>
              </label>
            ))}
            {authors.length === 0 && <div className="pop-empty">사용자 없음</div>}
          </div>
        )}
      </Dropdown>

      <Dropdown label={dateLabel} active={dateActive} onClear={() => setDateRange(null)} title="날짜 필터">
        {(close) => (
          <div className="pop-list">
            {PRESETS.map((p) => (
              <button key={p.id} className="pop-item btn-like" onClick={() => { setDateRange(datePresetRange(p.id)); close(); }}>{p.label}</button>
            ))}
            <div className="pop-sep" />
            <div className="pop-row">
              <span>시작</span>
              <input type="date" value={toDateInput(date?.since ?? null)} onChange={(e) => setDateRange({ since: parseDateInput(e.target.value, false), until: date?.until ?? null })} />
            </div>
            <div className="pop-row">
              <span>종료</span>
              <input type="date" value={toDateInput(date?.until ?? null)} onChange={(e) => setDateRange({ since: date?.since ?? null, until: parseDateInput(e.target.value, true) })} />
            </div>
          </div>
        )}
      </Dropdown>

      <Dropdown label={paths ? `경로: ${paths.length === 1 ? paths[0] : paths.length + '개'}` : '경로'} active={!!paths} onClear={() => setPaths(null)} title="경로 필터">
        {() => (
          <div className="pop-list wide">
            <div className="pop-row">
              <input
                autoFocus
                placeholder="저장소 상대 경로 입력 후 Enter"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addPath(); }}
              />
            </div>
            {(paths ?? []).map((p) => (
              <div key={p} className="pop-item">
                <span className="grow">{p}</span>
                <button className="icon-btn" onClick={() => { const n = (paths ?? []).filter((x) => x !== p); setPaths(n.length ? n : null); }}><Icon name="close" size={10} /></button>
              </div>
            ))}
          </div>
        )}
      </Dropdown>

      <div className="grow" />

      <Dropdown label={<Icon name="sort" size={14} />} title={`정렬: ${SORTS.find((s) => s.id === sort)?.label}`} align="right">
        {(close) => (
          <div className="pop-list">
            {SORTS.map((s) => (
              <label key={s.id} className="pop-item">
                <input type="radio" checked={sort === s.id} onChange={() => { setSort(s.id); close(); }} />{s.label}
              </label>
            ))}
          </div>
        )}
      </Dropdown>
      <button className={'icon-btn' + (loading ? ' spin' : '')} title="새로고침" onClick={() => void reload()}>
        <Icon name="refresh" size={14} />
      </button>
    </div>
  );
}
