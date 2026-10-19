// Fuzzy file-path matching for the file picker (subsequence match, IntelliJ "Go to File"-like ranking).

export interface FuzzyMatch {
  path: string;
  score: number;
  /** Matched character positions in `path` (ascending), for highlighting. */
  positions: number[];
}

const isSep = (c: string) => c === '/' || c === '_' || c === '-' || c === '.' || c === ' ';

/**
 * Scores `path` against `query` (case-insensitive subsequence; spaces in the query are ignored).
 * Returns null when not every query char matches. Higher score = better. Prefers matches in the file name,
 * at word starts and contiguous runs, and shorter paths.
 */
export function fuzzyScore(query: string, path: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (q === '') return { path, score: 0, positions: [] };
  const p = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;

  // Try the greedy match starting from each possible first position inside the file name first, then the
  // whole path; keep the best. Greedy-from-a-start is O(n) and good enough for file pickers.
  let best: FuzzyMatch | null = null;
  const tryFrom = (start: number) => {
    const pos: number[] = [];
    let i = start;
    for (let k = 0; k < q.length; k++) {
      const j = p.indexOf(q[k], i);
      if (j < 0) return;
      pos.push(j);
      i = j + 1;
    }
    let s = 0;
    for (let k = 0; k < pos.length; k++) {
      const j = pos[k];
      s += 1;
      if (j >= nameStart) s += 2;
      if (j === 0 || isSep(path[j - 1]) || (path[j] !== p[j] && path[j - 1] === p[j - 1])) s += 3; // word / camel start
      if (k > 0 && pos[k - 1] === j - 1) s += 4; // contiguous
    }
    if (pos[0] === nameStart) s += 6;
    const name = p.slice(nameStart);
    if (name === q) s += 50;
    else if (name.startsWith(q)) s += 20;
    s -= path.length * 0.05;
    if (!best || s > best.score) best = { path, score: s, positions: pos };
  };
  tryFrom(0);
  let from = nameStart;
  for (let n = 0; n < 8; n++) {
    const j = p.indexOf(q[0], from);
    if (j < 0) break;
    tryFrom(j);
    from = j + 1;
  }
  return best;
}

/** Best `limit` matches for `query`, best first (ties: shorter path, then alphabetical). */
export function rankFiles(query: string, files: readonly string[], limit = 200): FuzzyMatch[] {
  if (query.trim() === '') return files.slice(0, limit).map((path) => ({ path, score: 0, positions: [] }));
  const out: FuzzyMatch[] = [];
  for (const f of files) {
    const m = fuzzyScore(query, f);
    if (m) out.push(m);
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out.slice(0, limit);
}
