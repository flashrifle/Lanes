// Serialized write-op queue (one per repo) + one retry on `busy` (index.lock held by an IDE). Pure, no IPC.
import { toAppError } from '../../api';

export type Sleep = (ms: number) => Promise<void>;
export const BUSY_RETRY_MS = 500;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs `fn`; if it fails with code 'busy', waits `delayMs` and runs it once more. */
export async function withBusyRetry<T>(fn: () => Promise<T>, sleep: Sleep = realSleep, delayMs = BUSY_RETRY_MS): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (toAppError(e).code !== 'busy') throw e;
    await sleep(delayMs);
    return fn();
  }
}

export interface OpQueue {
  /** Runs after every previously queued op settled (success or failure). Busy is retried once. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Ops queued or running. */
  readonly pending: number;
}

export function createOpQueue(sleep: Sleep = realSleep, onChange?: (pending: number) => void): OpQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      pending++;
      onChange?.(pending);
      const p = tail.then(() => withBusyRetry(fn, sleep));
      tail = p.then(() => undefined, () => undefined);
      void tail.then(() => { pending--; onChange?.(pending); });
      return p;
    },
    get pending() { return pending; },
  };
}
