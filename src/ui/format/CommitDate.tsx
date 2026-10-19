// Commit date text that follows settings.dateFormat live (LangRoot no longer remounts on a date-format change).
import { useSyncExternalStore } from 'react';
import { getSettings, subscribeSettings } from '../app/settingsStore';
import { formatCommitDate } from './date';

/** Re-renders the caller when settings.dateFormat changes; returns the current value. */
export function useDateFormat(): 'relative' | 'absolute' {
  return useSyncExternalStore(subscribeSettings, () => getSettings().dateFormat);
}

export function CommitDate({ ts }: { ts: number }) {
  useDateFormat();
  return <>{formatCommitDate(ts)}</>;
}
