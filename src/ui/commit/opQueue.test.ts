import { describe, expect, it, vi } from 'vitest';
import { createOpQueue, withBusyRetry } from './opQueue';

const busy = { code: 'busy', message: 'index.lock', stderr: null };
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const p = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

describe('withBusyRetry', () => {
  it('retries once after the delay on busy', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValueOnce(busy).mockResolvedValueOnce('ok');
    await expect(withBusyRetry(fn, sleep)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });
  it('gives up after the second busy', async () => {
    const fn = vi.fn().mockRejectedValue(busy);
    await expect(withBusyRetry(fn, async () => {})).rejects.toBe(busy);
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('does not retry other errors', async () => {
    const err = { code: 'gitFailed', message: 'x', stderr: null };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withBusyRetry(fn, async () => {})).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('createOpQueue', () => {
  it('runs ops one at a time in submission order, also after a failure', async () => {
    const log: string[] = [];
    const pendings: number[] = [];
    const q = createOpQueue(async () => {}, (n) => pendings.push(n));
    const d1 = deferred<void>();
    const p1 = q.run(async () => { log.push('1 start'); await d1.p; log.push('1 end'); throw new Error('boom'); });
    const p2 = q.run(async () => { log.push('2 start'); return 2; });
    const p3 = q.run(async () => { log.push('3 start'); return 3; });
    await Promise.resolve();
    expect(log).toEqual(['1 start']);
    expect(q.pending).toBe(3);
    d1.resolve();
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe(2);
    await expect(p3).resolves.toBe(3);
    expect(log).toEqual(['1 start', '1 end', '2 start', '3 start']);
    await new Promise((r) => setTimeout(r, 0));
    expect(q.pending).toBe(0);
    expect(pendings[0]).toBe(1);
    expect(pendings.at(-1)).toBe(0);
  });
  it('a busy retry holds the queue', async () => {
    const log: string[] = [];
    const q = createOpQueue(async () => { log.push('sleep'); });
    let first = true;
    const a = q.run(async () => { log.push('a'); if (first) { first = false; throw busy; } return 'a'; });
    const b = q.run(async () => { log.push('b'); return 'b'; });
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
    expect(log).toEqual(['a', 'sleep', 'a', 'b']);
  });
});
