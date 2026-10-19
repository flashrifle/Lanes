import { describe, expect, it } from 'vitest';
import type { FileHistoryEntry } from '../types';
import { AGE_BUCKETS, ageBuckets, buildBlameRuns, hashColorIndex, isRunStart, shortAuthor } from './blame';
import { filterEntries, findEntry, previousNames } from './entries';
import { fuzzyScore, rankFiles } from './fuzzy';
import {
  historyWindowTitle,
  latestHistorySessionId,
  loadHistorySession,
  parseHistorySession,
  saveHistorySession,
  type KV,
} from './session';

class MemStorage implements KV {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

describe('blame runs', () => {
  it('groups consecutive lines of the same commit', () => {
    const r = buildBlameRuns([{ hash: 'a' }, { hash: 'a' }, { hash: 'b' }, { hash: 'a' }, { hash: 'a' }, { hash: 'a' }]);
    expect(r.runStart).toEqual([0, 2, 3]);
    expect(r.runHash).toEqual(['a', 'b', 'a']);
    expect([...r.runOf]).toEqual([0, 0, 1, 2, 2, 2]);
    expect([0, 1, 2, 3, 4, 5].map((i) => isRunStart(r, i))).toEqual([true, false, true, true, false, false]);
  });
  it('handles empty input', () => {
    const r = buildBlameRuns([]);
    expect(r.runStart).toEqual([]);
    expect(r.runOf.length).toBe(0);
  });
});

describe('age buckets', () => {
  it('newest = top bucket, oldest = 0, rank based', () => {
    const m = ageBuckets([
      { hash: 'old', authorTime: 1 },
      { hash: 'mid', authorTime: 1_000_000 },
      { hash: 'new', authorTime: 1_000_001 },
    ]);
    expect(m.get('old')).toBe(0);
    expect(m.get('new')).toBe(AGE_BUCKETS - 1);
    const mid = m.get('mid')!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(AGE_BUCKETS - 1);
  });
  it('single commit / equal times are newest', () => {
    expect(ageBuckets([{ hash: 'x', authorTime: 5 }]).get('x')).toBe(AGE_BUCKETS - 1);
    const m = ageBuckets([{ hash: 'x', authorTime: 5 }, { hash: 'y', authorTime: 5 }]);
    expect(m.get('x')).toBe(m.get('y'));
  });
  it('is monotonic in time and stays within range', () => {
    const cs = Array.from({ length: 37 }, (_, i) => ({ hash: 'h' + i, authorTime: i * 100 }));
    const m = ageBuckets(cs);
    let prev = -1;
    for (const c of cs) {
      const b = m.get(c.hash)!;
      expect(b).toBeGreaterThanOrEqual(prev);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(AGE_BUCKETS);
      prev = b;
    }
  });
  it('empty input', () => {
    expect(ageBuckets([]).size).toBe(0);
  });
});

describe('blame misc', () => {
  it('hash colour index is stable and in range', () => {
    expect(hashColorIndex('ffffff0abc')).toBe(hashColorIndex('ffffff0def'));
    for (const h of ['0000000', 'abcdef1234', 'zz']) {
      const i = hashColorIndex(h);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(16);
    }
  });
  it('shortens long author names', () => {
    expect(shortAuthor('Ann')).toBe('Ann');
    expect(shortAuthor('Bartholomew Montgomery')).toBe('Bartholomew');
    expect(shortAuthor('Supercalifragilistic')).toBe('Supercalifrag…');
  });
});

describe('fuzzy file match', () => {
  const files = [
    'src/diffwindow/DiffWindowApp.tsx',
    'src/diffwindow/session.ts',
    'src/historywindow/session.ts',
    'src/App.tsx',
    'src/ui/details/ChangesTree.tsx',
    'docs/app-notes.md',
  ];
  it('requires all query chars in order', () => {
    expect(fuzzyScore('xyz', 'src/App.tsx')).toBeNull();
    expect(fuzzyScore('apx', 'src/App.tsx')).not.toBeNull();
    expect(fuzzyScore('xpa', 'src/App.tsx')).toBeNull();
  });
  it('ranks exact file-name matches first', () => {
    expect(rankFiles('App.tsx', files)[0].path).toBe('src/App.tsx');
    expect(rankFiles('ChangesTree', files)[0].path).toBe('src/ui/details/ChangesTree.tsx');
  });
  it('prefers file-name and word-start matches', () => {
    const r = rankFiles('dwa', files);
    expect(r[0].path).toBe('src/diffwindow/DiffWindowApp.tsx');
    const s = rankFiles('session', files).map((m) => m.path);
    expect(s.slice(0, 2).sort()).toEqual(['src/diffwindow/session.ts', 'src/historywindow/session.ts']);
  });
  it('ignores spaces and case; returns positions', () => {
    const m = fuzzyScore('APP TSX', 'src/App.tsx')!;
    expect(m).not.toBeNull();
    expect(m.positions.length).toBe(6);
    expect(m.positions).toEqual([...m.positions].sort((a, b) => a - b));
  });
  it('empty query returns the first files unranked; limit applies', () => {
    expect(rankFiles('', files, 2).map((m) => m.path)).toEqual(files.slice(0, 2));
    expect(rankFiles('s', files, 3).length).toBe(3);
  });
});

const entry = (p: Partial<FileHistoryEntry>): FileHistoryEntry => ({
  hash: 'a'.repeat(40), parents: [], authorName: 'Ann', authorEmail: 'ann@x.io', authorTime: 0, subject: 'init',
  path: 'f.ts', oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false, ...p,
});

describe('history entries', () => {
  const es = [
    entry({ hash: 'abc123'.padEnd(40, '0'), subject: 'Fix login bug', authorName: 'Bob' }),
    entry({ hash: 'def456'.padEnd(40, '0'), subject: 'Rename file', path: 'g.ts', oldPath: 'f.ts', status: 'renamed' }),
    entry({ hash: 'beef00'.padEnd(40, '0'), subject: 'Initial', authorEmail: 'carol@corp.io', authorName: 'Carol' }),
  ];
  it('filters by subject, author, email and hash prefix', () => {
    expect(filterEntries(es, '').length).toBe(3);
    expect(filterEntries(es, 'LOGIN').map((e) => e.subject)).toEqual(['Fix login bug']);
    expect(filterEntries(es, 'carol').length).toBe(1);
    expect(filterEntries(es, 'corp.io').length).toBe(1);
    expect(filterEntries(es, 'def4').map((e) => e.subject)).toEqual(['Rename file']);
  });
  it('finds entries by full or short hash', () => {
    expect(findEntry(es, 'beef00'.padEnd(40, '0'))).toBe(2);
    expect(findEntry(es, 'def456')).toBe(1);
    expect(findEntry(es, 'ffff')).toBe(-1);
    expect(findEntry(es, null)).toBe(-1);
  });
  it('lists previous names', () => {
    expect(previousNames(es)).toEqual(['f.ts']);
  });
});

describe('history session', () => {
  it('validates payloads', () => {
    expect(parseHistorySession(null)).toBeNull();
    expect(parseHistorySession({ repoPath: '/r' })).toBeNull();
    expect(parseHistorySession({ repoPath: '', path: 'a' })).toBeNull();
    expect(parseHistorySession({ repoPath: '/x/repo', path: 'a.ts', rev: 7 })).toEqual({ repoPath: '/x/repo', repoName: 'repo', path: 'a.ts', rev: null });
    const s = parseHistorySession({ repoPath: '/r', repoName: 'R', path: 'a', rev: 'abc', selectHash: 'abcd1234' });
    expect(s).toEqual({ repoPath: '/r', repoName: 'R', path: 'a', rev: 'abc', selectHash: 'abcd1234' });
    expect(parseHistorySession({ repoPath: '/r', path: 'a', selectHash: 'not-a-hash' })?.selectHash).toBeUndefined();
  });
  it('round-trips through storage, tracks latest and prunes old sessions', () => {
    const ls = new MemStorage();
    for (let i = 0; i < 12; i++) {
      saveHistorySession('id' + String(i).padStart(2, '0'), { repoPath: '/r', repoName: 'r', path: 'p' + i, rev: null }, ls);
    }
    expect(latestHistorySessionId(ls)).toBe('id11');
    expect(loadHistorySession('id11', ls)?.path).toBe('p11');
    expect(loadHistorySession('id00', ls)).toBeNull();
    let n = 0;
    for (let i = 0; i < ls.length; i++) if (ls.key(i)?.startsWith('history-session:')) n++;
    expect(n).toBe(8);
  });
  it('rejects corrupt stored JSON', () => {
    const ls = new MemStorage();
    ls.setItem('history-session:x', '{bad');
    expect(loadHistorySession('x', ls)).toBeNull();
    expect(loadHistorySession('x', null)).toBeNull();
  });
  it('builds the window title', () => {
    expect(historyWindowTitle('lanes', 'src/a/b.ts')).toBe('lanes — History: b.ts');
  });
});
