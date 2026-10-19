// Pure blame helpers: run grouping, age buckets, per-commit stripe colour.
import type { BlameCommit, BlameLine } from '../types';

export interface BlameRuns {
  /** runOf[i] = index of the run containing line i. */
  runOf: Uint32Array;
  /** runStart[r] = first line index of run r; runs are maximal stretches of consecutive lines from one commit. */
  runStart: number[];
  runHash: string[];
}

export function buildBlameRuns(lines: readonly Pick<BlameLine, 'hash'>[]): BlameRuns {
  const runOf = new Uint32Array(lines.length);
  const runStart: number[] = [];
  const runHash: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].hash;
    if (i === 0 || h !== lines[i - 1].hash) {
      runStart.push(i);
      runHash.push(h);
    }
    runOf[i] = runStart.length - 1;
  }
  return { runOf, runStart, runHash };
}

/** True when line i is the first line of its run (the only line that shows gutter text). */
export const isRunStart = (runs: BlameRuns, i: number): boolean => runs.runStart[runs.runOf[i]] === i;

export const AGE_BUCKETS = 6;

/**
 * Age bucket per commit hash: AGE_BUCKETS-1 = newest, 0 = oldest. Rank-based over distinct author times
 * (robust against one ancient commit squashing everything else into one bucket).
 */
export function ageBuckets(commits: readonly Pick<BlameCommit, 'hash' | 'authorTime'>[], buckets = AGE_BUCKETS): Map<string, number> {
  const out = new Map<string, number>();
  if (commits.length === 0 || buckets < 1) return out;
  const times = [...new Set(commits.map((c) => c.authorTime))].sort((a, b) => a - b);
  const rank = new Map<number, number>();
  times.forEach((t, i) => rank.set(t, i));
  const n = times.length;
  for (const c of commits) {
    const r = rank.get(c.authorTime)!;
    out.set(c.hash, n === 1 ? buckets - 1 : Math.min(buckets - 1, Math.floor((r / (n - 1)) * (buckets - 1) + 1e-9)));
  }
  return out;
}

/** Stable palette index (0..15) for a commit hash. */
export function hashColorIndex(hash: string): number {
  const v = parseInt(hash.slice(0, 7), 16);
  if (Number.isFinite(v)) return v % 16;
  let h = 0;
  for (let i = 0; i < hash.length; i++) h = (h * 31 + hash.charCodeAt(i)) | 0;
  return ((h % 16) + 16) % 16;
}

/** Short "Name" for the gutter: first word if the name is long. */
export function shortAuthor(name: string, max = 14): string {
  const n = name.trim();
  if (n.length <= max) return n;
  const first = n.split(/\s+/)[0];
  return first.length <= max ? first : first.slice(0, max - 1) + '…';
}
