import { describe, expect, it } from 'vitest';
import { diffWords, myersDiff, tokenize } from './intraline';

const pick = (s: string, rs: [number, number][]) => rs.map(([a, b]) => s.slice(a, b));

describe('tokenize', () => {
  it('splits words, whitespace, punctuation and newlines', () => {
    expect(tokenize('foo(bar, 12)\n  x').map((t) => t.text)).toEqual(['foo', '(', 'bar', ',', ' ', '12', ')', '\n', '  ', 'x']);
  });
  it('keeps Hangul words together', () => {
    expect(tokenize('이유를 알려').map((t) => t.text)).toEqual(['이유를', ' ', '알려']);
  });
});

describe('myersDiff', () => {
  it('marks minimal changes', () => {
    const r = myersDiff([1, 2, 3, 4], [1, 3, 4, 5])!;
    expect(Array.from(r.a)).toEqual([0, 1, 0, 0]);
    expect(Array.from(r.b)).toEqual([0, 0, 0, 1]);
  });
  it('handles empty sides', () => {
    const r = myersDiff([], [1, 2])!;
    expect(Array.from(r.b)).toEqual([1, 1]);
  });
  it('returns null over the edit cap', () => {
    expect(myersDiff([1, 2, 3], [4, 5, 6], 2)).toBeNull();
  });
});

describe('diffWords', () => {
  it('highlights only the differing words (screenshot case)', () => {
    const a = "  leaveReason: '떠나시는 이유를 알려주시면 더 나아질게요',";
    const b = "  leaveReason: '떠나시는 이유를 모두 골라 주세요',";
    const r = diffWords(a, b)!;
    expect(r).not.toBeNull();
    expect(pick(a, r.left)).toEqual(['알려주시면 더 나아질게요']);
    expect(pick(b, r.right)).toEqual(['모두 골라 주세요']);
  });

  it('bare sentence case', () => {
    const a = '떠나시는 이유를 알려주시면 더 나아질게요';
    const b = '떠나시는 이유를 모두 골라 주세요';
    const r = diffWords(a, b)!;
    expect(pick(a, r.left)).toEqual(['알려주시면 더 나아질게요']);
    expect(pick(b, r.right)).toEqual(['모두 골라 주세요']);
  });

  it('single token change', () => {
    const a = 'const x = foo(1);';
    const b = 'const x = bar(1);';
    const r = diffWords(a, b)!;
    expect(pick(a, r.left)).toEqual(['foo']);
    expect(pick(b, r.right)).toEqual(['bar']);
  });

  it('pure insertion leaves left empty', () => {
    const a = 'a(b)';
    const b = 'a(b, c)';
    const r = diffWords(a, b)!;
    expect(r.left).toEqual([]);
    expect(pick(b, r.right).join('')).toBe(', c');
  });

  it('identical strings → no ranges', () => {
    expect(diffWords('same', 'same')).toEqual({ left: [], right: [] });
  });

  it('falls back (null) for totally different lines', () => {
    expect(diffWords('import React from "react";', 'while (true) { go(); }')).toBeNull();
  });

  it('falls back (null) for very long lines', () => {
    const long = 'x'.repeat(2500);
    expect(diffWords(long, long + 'y')).toBeNull();
  });

  it('never highlights newlines in multi-line text', () => {
    const a = 'one\ntwo';
    const b = 'one\nthree';
    const r = diffWords(a, b)!;
    expect(pick(a, r.left)).toEqual(['two']);
    expect(pick(b, r.right)).toEqual(['three']);
  });
});
