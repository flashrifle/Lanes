import { describe, expect, it } from 'vitest';
import { clickLine, inRange, rangeOf, rangeOfNumbers } from './lineSelection';
import { parseHistorySession, parseLineRange } from './session';

describe('HistorySession.lineRange', () => {
  const base = { repoPath: '/x/repo', path: 'a.ts', rev: 'abc123' };

  it('is optional and absent by default', () => {
    expect(parseHistorySession(base)).not.toHaveProperty('lineRange');
  });

  it('accepts a valid range', () => {
    expect(parseHistorySession({ ...base, lineRange: { start: 10, end: 20 } })?.lineRange).toEqual({ start: 10, end: 20 });
    expect(parseHistorySession({ ...base, lineRange: { start: 5, end: 5 } })?.lineRange).toEqual({ start: 5, end: 5 });
  });

  it('drops invalid ranges but keeps the session', () => {
    for (const bad of [
      { start: 0, end: 3 }, { start: -1, end: 3 }, { start: 5, end: 4 }, { start: 1.5, end: 3 }, { start: '1', end: 3 },
      { start: 1 }, { start: 1, end: 10_000_001 }, null, 'x', [1, 2], { start: NaN, end: 3 },
    ]) {
      const s = parseHistorySession({ ...base, lineRange: bad });
      expect(s).not.toBeNull();
      expect(s).not.toHaveProperty('lineRange');
    }
  });

  it('parseLineRange copies only start/end', () => {
    expect(parseLineRange({ start: 1, end: 2, extra: true })).toEqual({ start: 1, end: 2 });
  });

  it('survives a JSON round trip', () => {
    const s = parseHistorySession({ ...base, lineRange: { start: 3, end: 9 } })!;
    expect(parseHistorySession(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('line selection', () => {
  it('click selects one line, shift extends in either direction', () => {
    const a = clickLine(null, 10, false);
    expect(rangeOf(a)).toEqual({ start: 10, end: 10 });
    expect(rangeOf(clickLine(a, 14, true))).toEqual({ start: 10, end: 14 });
    expect(rangeOf(clickLine(a, 7, true))).toEqual({ start: 7, end: 10 });
    expect(rangeOf(clickLine(clickLine(a, 14, true), 3, false))).toEqual({ start: 3, end: 3 });
    expect(rangeOf(clickLine(null, 4, true))).toEqual({ start: 4, end: 4 });
  });
  it('rangeOfNumbers ignores junk', () => {
    expect(rangeOfNumbers([NaN, 0, 4, 9, -2])).toEqual({ start: 4, end: 9 });
    expect(rangeOfNumbers([NaN])).toBeNull();
    expect(inRange({ start: 2, end: 4 }, 4)).toBe(true);
    expect(inRange({ start: 2, end: 4 }, 5)).toBe(false);
  });
});
