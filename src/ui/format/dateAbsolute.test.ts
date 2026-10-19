import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('../../api', () => ({ call: (...a: unknown[]) => call(...a), onEvent: vi.fn(async () => () => {}) }));

import { __resetSettingsForTests, DEFAULT_SETTINGS, saveSettings } from '../app/settingsStore';
import { formatAbsoluteDate, formatCommitDate } from './date';

const sec = (d: Date) => Math.floor(d.getTime() / 1000);

describe('absolute date mode', () => {
  beforeEach(() => {
    __resetSettingsForTests();
    call.mockReset();
    call.mockImplementation(async (_c: string, a: { settings: unknown }) => a.settings);
  });
  afterEach(() => __resetSettingsForTests());

  it('formats YYYY-MM-DD HH:mm', () => {
    expect(formatAbsoluteDate(sec(new Date(2026, 9, 3, 7, 5)))).toBe('2026-10-03 07:05');
  });

  it('formatCommitDate switches with settings.dateFormat', async () => {
    const now = new Date(2026, 9, 16, 10, 0, 0);
    const ts = sec(new Date(2026, 9, 16, 9, 5));
    expect(formatCommitDate(ts, now)).toBe('오늘 09:05');
    await saveSettings({ dateFormat: 'absolute' });
    expect(formatCommitDate(ts, now)).toBe('2026-10-16 09:05');
    await saveSettings({ dateFormat: DEFAULT_SETTINGS.dateFormat });
    expect(formatCommitDate(ts, now)).toBe('오늘 09:05');
  });
});
