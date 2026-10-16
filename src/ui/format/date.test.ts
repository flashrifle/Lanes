import { afterEach, describe, expect, it } from 'vitest';
import { setLang } from '../../i18n';
import { formatCommitDate, formatFullDate } from './date';

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

describe('formatCommitDate', () => {
  const now = new Date(2026, 9, 16, 10, 0, 0);
  it('today', () => {
    expect(formatCommitDate(sec(new Date(2026, 9, 16, 9, 5)), now)).toBe('오늘 09:05');
  });
  it('yesterday with 24h time', () => {
    expect(formatCommitDate(sec(new Date(2026, 9, 15, 17, 23)), now)).toBe('어제 17:23');
  });
  it('yesterday across month boundary', () => {
    const n = new Date(2026, 10, 1, 8, 0);
    expect(formatCommitDate(sec(new Date(2026, 9, 31, 23, 59)), n)).toMatch(/^어제 /);
  });
  it('older dates', () => {
    expect(formatCommitDate(sec(new Date(2026, 9, 3, 12, 0)), now)).toBe('10월 3일');
    expect(formatCommitDate(sec(new Date(2025, 0, 1, 12, 0)), now)).toBe('2025년 1월 1일');
  });
  it('full date', () => {
    expect(formatFullDate(sec(new Date(2026, 9, 3, 17, 23)))).toBe('2026. 10. 3. 오후 5:23');
  });
});

describe('English dates', () => {
  const now = new Date(2026, 9, 16, 10, 0, 0);
  afterEach(() => setLang('ko'));
  it('formats in English', () => {
    setLang('en');
    expect(formatCommitDate(sec(new Date(2026, 9, 16, 9, 5)), now)).toBe('Today 09:05');
    expect(formatCommitDate(sec(new Date(2026, 9, 15, 17, 23)), now)).toBe('Yesterday 17:23');
    expect(formatCommitDate(sec(new Date(2026, 9, 3, 12, 0)), now)).toBe('Oct 3');
    expect(formatCommitDate(sec(new Date(2025, 0, 1, 12, 0)), now)).toBe('Jan 1, 2025');
    expect(formatFullDate(sec(new Date(2026, 9, 3, 17, 23)))).toMatch(/^Oct 3, 2026, 5:23\sPM$/);
  });
});
