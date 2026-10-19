import { describe, expect, it } from 'vitest';
import type { AppError, Diagnostics } from '../../types';
import { buildReportIssue, ISSUES_NEW_URL, MAX_URL_LENGTH, redactHome, stderrTail } from './reportIssue';

const diag: Diagnostics = {
  appVersion: '0.1.0', os: 'macOS 15.1', arch: 'aarch64', gitVersion: '2.50.1', gitPath: '/Users/alice/bin/git', locale: 'ko-KR',
};
const err = (o: Partial<AppError> = {}): AppError => ({ code: 'pushRejected', message: 'rejected', stderr: null, ...o });

function parse(url: string) {
  const u = new URL(url);
  return { base: u.origin + u.pathname, title: u.searchParams.get('title')!, body: u.searchParams.get('body')! };
}

describe('redactHome', () => {
  it('replaces explicit and generic home dirs', () => {
    expect(redactHome('/Users/alice/repo/x', '/Users/alice')).toBe('~/repo/x');
    expect(redactHome('at /Users/bob/code and /home/carol/z')).toBe('at ~/code and ~/z');
    expect(redactHome('/opt/homebrew/bin/git')).toBe('/opt/homebrew/bin/git');
  });
});

describe('stderrTail', () => {
  it('keeps the last lines, drops blanks, caps characters', () => {
    const s = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n\n');
    const t = stderrTail(s, 5);
    expect(t.split('\n')).toEqual(['line 45', 'line 46', 'line 47', 'line 48', 'line 49']);
    expect(stderrTail('x'.repeat(5000), 20, 100).length).toBe(101);
    expect(stderrTail(null)).toBe('');
  });
});

describe('buildReportIssue', () => {
  it('targets the Lanes issue tracker and round-trips the encoded text', () => {
    const r = buildReportIssue({ diagnostics: diag, error: err({ message: 'a & b = c # d?', stderr: 'remote: 한글 ✓\nfatal' }) });
    const p = parse(r.url);
    expect(p.base).toBe(ISSUES_NEW_URL);
    expect(p.title).toBe('[Bug] pushRejected: a & b = c # d?');
    expect(p.body).toContain('- Lanes: 0.1.0');
    expect(p.body).toContain('- OS: macOS 15.1 (aarch64)');
    expect(p.body).toContain('- git: 2.50.1 (~/bin/git)');
    expect(p.body).toContain('remote: 한글 ✓\nfatal');
    expect(r.url).not.toContain(' ');
  });

  it('works without diagnostics or error', () => {
    const r = buildReportIssue({ diagnostics: null, error: null });
    expect(r.url.startsWith(ISSUES_NEW_URL)).toBe(true);
    expect(parse(r.url).body).toContain('diagnostics unavailable');
  });

  it('redacts $HOME in message and stderr', () => {
    const r = buildReportIssue({
      diagnostics: diag,
      error: err({ message: 'cannot open /Users/alice/proj/.git', stderr: 'fatal: /Users/alice/proj not a repo' }),
      home: '/Users/alice',
    });
    expect(decodeURIComponent(r.url)).not.toContain('alice/proj');
    expect(parse(r.url).body).toContain('~/proj');
  });

  it('keeps only the stderr tail', () => {
    const stderr = Array.from({ length: 100 }, (_, i) => `err ${i}`).join('\n');
    const body = parse(buildReportIssue({ diagnostics: diag, error: err({ stderr }) }).url).body;
    expect(body).toContain('err 99');
    expect(body).toContain('err 80');
    expect(body).not.toContain('err 79\n');
  });

  it('caps the URL length, even with huge non-ASCII input', () => {
    const stderr = '한글 오류 메시지 '.repeat(5000);
    const r = buildReportIssue({ diagnostics: diag, error: err({ message: '메시지 '.repeat(2000), stderr }) });
    expect(r.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(parse(r.url).body).toContain('Environment');
  });

  it('neutralizes code fences inside stderr', () => {
    const body = parse(buildReportIssue({ diagnostics: diag, error: err({ stderr: 'a ``` b' }) }).url).body;
    expect(body.match(/```/g)?.length).toBe(2);
  });
});
