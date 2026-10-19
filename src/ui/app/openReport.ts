import { openUrl } from '@tauri-apps/plugin-opener';
import { call } from '../../api';
import type { Diagnostics } from '../../types';
import { getLastError } from './lastError';
import { buildReportIssue } from './reportIssue';

/** Gathers diagnostics + the last error, builds the prefilled issue URL and opens it in the browser. */
export async function openReportIssue(): Promise<void> {
  let diagnostics: Diagnostics | null = null;
  try { diagnostics = await call('get_diagnostics', {}); } catch { /* report without it */ }
  const { url } = buildReportIssue({ diagnostics, error: getLastError()?.error ?? null });
  await openUrl(url);
}
