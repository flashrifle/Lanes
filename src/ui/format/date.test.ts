import { describe, expect, it } from 'vitest';
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
