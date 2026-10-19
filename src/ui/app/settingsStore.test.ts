import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
let handler: ((p: unknown) => void) | null = null;
vi.mock('../../api', () => ({
  call: (...a: unknown[]) => call(...a),
  onEvent: vi.fn(async (_n: string, cb: (p: unknown) => void) => { handler = cb; return () => {}; }),
}));

import {
  __resetSettingsForTests,
  DEFAULT_SETTINGS,
  getSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
  startSettingsSync,
} from './settingsStore';

beforeEach(() => {
  __resetSettingsForTests();
  call.mockReset();
  handler = null;
});

describe('normalizeSettings', () => {
  it('fills defaults and rejects invalid values', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    const n = normalizeSettings({ language: 'fr', density: 'compact', backgroundFetchMinutes: 20, gitPath: '  ', checkForUpdates: false });
    expect(n.language).toBe('system');
    expect(n.density).toBe('compact');
    expect(n.backgroundFetchMinutes).toBeNull();
    expect(n.gitPath).toBeNull();
    expect(n.checkForUpdates).toBe(false);
    expect(normalizeSettings({ backgroundFetchMinutes: 30 }).backgroundFetchMinutes).toBe(30);
  });
});

describe('settings store', () => {
  it('loads from the backend and keeps defaults on failure', async () => {
    call.mockRejectedValueOnce({ code: 'internal', message: 'x', stderr: null });
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
    call.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, language: 'en' });
    expect((await loadSettings()).language).toBe('en');
  });

  it('save applies optimistically, adopts the stored value, and sends the merged settings', async () => {
    call.mockImplementation(async (_c: string, a: { settings: typeof DEFAULT_SETTINGS }) => ({ ...a.settings, gitPath: '/opt/git' }));
    const p = saveSettings({ density: 'compact' });
    expect(getSettings().density).toBe('compact');
    const stored = await p;
    expect(call).toHaveBeenCalledWith('set_settings', { settings: { ...DEFAULT_SETTINGS, density: 'compact' } });
    expect(stored.gitPath).toBe('/opt/git');
    expect(getSettings().gitPath).toBe('/opt/git');
  });

  it('save reverts and rethrows when the backend rejects', async () => {
    call.mockRejectedValue({ code: 'invalidArgument', message: 'bad', stderr: null });
    await expect(saveSettings({ backgroundFetchMinutes: 15 })).rejects.toMatchObject({ code: 'invalidArgument' });
    expect(getSettings().backgroundFetchMinutes).toBeNull();
  });

  it('follows settings-changed events', async () => {
    startSettingsSync();
    await Promise.resolve();
    handler?.({ ...DEFAULT_SETTINGS, language: 'ko', dateFormat: 'absolute' });
    expect(getSettings().language).toBe('ko');
    expect(getSettings().dateFormat).toBe('absolute');
  });
});
