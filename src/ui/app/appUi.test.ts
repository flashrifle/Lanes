import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
vi.mock('../../api', () => ({
  call: (...a: unknown[]) => call(...a),
  onEvent: vi.fn(async () => () => {}),
  toAppError: (e: unknown) => e,
}));

import { AppUiStore, classifyUpdateError } from './appUi';

const info = { version: '0.2.0', currentVersion: '0.1.0', notes: 'n', pubDate: null };
let s: AppUiStore;
beforeEach(() => { call.mockReset(); s = new AppUiStore(); });

describe('update flow', () => {
  it('silent launch check is invisible on up-to-date and on failure', async () => {
    call.mockResolvedValueOnce(null);
    await s.check(true);
    expect(s.getState().update.kind).toBe('idle');
    call.mockRejectedValueOnce({ code: 'updateFailed', message: 'pubkey placeholder', stderr: null });
    await s.check(true);
    expect(s.getState().update.kind).toBe('idle');
  });

  it('silent check opens the dialog when an update exists; manual shows every outcome', async () => {
    call.mockResolvedValueOnce(info);
    await s.check(true);
    expect(s.getState().update).toEqual({ kind: 'available', info });
    s.dismissUpdate();
    call.mockResolvedValueOnce(null);
    await s.check(false);
    expect(s.getState().update.kind).toBe('upToDate');
    call.mockRejectedValueOnce({ code: 'updateFailed', message: 'error sending request: connection refused', stderr: null });
    await s.check(false);
    expect(s.getState().update).toMatchObject({ kind: 'error', reason: 'offline' });
  });

  it('install then restart; failure returns to an error that can be retried', async () => {
    call.mockResolvedValueOnce(info);
    await s.check(true);
    call.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await s.install();
    expect(call.mock.calls.map((c) => c[0])).toEqual(['check_for_update', 'install_update', 'restart_app']);
    call.mockReset();
    s = new AppUiStore();
    call.mockResolvedValueOnce(info);
    await s.check(true);
    call.mockRejectedValueOnce({ code: 'updateFailed', message: 'signature mismatch', stderr: null });
    await s.install();
    expect(s.getState().update).toMatchObject({ kind: 'error', reason: 'failed', info });
  });

  it('classifies errors', () => {
    expect(classifyUpdateError('dns error')).toBe('offline');
    expect(classifyUpdateError('invalid signature')).toBe('failed');
  });
});
