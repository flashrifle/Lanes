// Last error seen by any repo tab, for the "Report Issue" URL (no telemetry). Owned by ui-app.
import { toAppError } from '../../api';
import type { AppError } from '../../types';

let last: { error: AppError; at: number } | null = null;

export function recordError(e: unknown): void {
  last = { error: toAppError(e), at: Date.now() };
}

export function getLastError(): { error: AppError; at: number } | null {
  return last;
}
