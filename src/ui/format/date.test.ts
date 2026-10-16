import { describe, expect, it } from 'vitest';
import { formatCommitDate, formatFullDate } from './date';

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

describe('formatCommitDate', () => {
  const now = new Date(2026, 9, 16, 10, 0, 0);
  it('today', () => {
    expect(formatCommitDate(sec(new Date(2026, 9, 16, 9, 5)), now)).toMatch(/^오늘 (오전|오후) \d{1,2}:\d{2}$/);
  });
  it('yesterday with PM time', () => {
    const s = formatCommitDate(sec(new Date(2026, 9, 15, 17, 23)), now);
    expect(s).toMatch(/^어제 오후 5:23$/);
  });
  it('yesterday across month boundary', () => {
    const n = new Date(2026, 10, 1, 8, 0);
    expect(formatCommitDate(sec(new Date(2026, 9, 31, 23, 59)), n)).toMatch(/^어제 /);
  });
  it('older dates', () => {
    expect(formatCommitDate(sec(new Date(2026, 9, 3, 12, 0)), now)).toBe('2026. 10. 3.');
    expect(formatCommitDate(sec(new Date(2025, 0, 1, 12, 0)), now)).toBe('2025. 1. 1.');
  });
  it('full date', () => {
    expect(formatFullDate(sec(new Date(2026, 9, 3, 17, 23)))).toBe('2026. 10. 3. 오후 5:23');
  });
});
