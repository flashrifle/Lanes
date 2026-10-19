// i18n part owned by ui-app (prefix: quick.*). Spread into src/i18n/en.ts; typed against quickKo's keys.
import type { Entry, Params } from '../ko';
import type { quickKo } from './quick.ko';

const n = (v: string | number): string => Number(v).toLocaleString('en-US');

export const quickEn: Record<keyof typeof quickKo, Entry> = {
  'quick.title': 'Quick Commit',
  'quick.noRepo': 'Choose a repository',
  'quick.noRepoHint': 'Pick "Quick Commit…" for a repository from the menu bar icon.',
  'quick.loading': 'Loading changes…',
  'quick.noChanges': 'No changes',
  'quick.files': (p: Params) => `${n(p.n)} changed ${Number(p.n) === 1 ? 'file' : 'files'}`,
  'quick.staged': (p: Params) => `${n(p.n)} selected`,
  'quick.selectAll': 'Select all',
  'quick.truncated': 'Too many files; showing only some',
  'quick.conflict': 'Conflict',
  'quick.conflictHint': 'Resolve the conflicts, then commit in Lanes',
  'quick.partial': 'Partially staged',
  'quick.messagePh': 'Commit message',
  'quick.commit': 'Commit',
  'quick.commitPush': 'Commit & Push',
  'quick.committing': 'Committing…',
  'quick.pushing': 'Pushing…',
  'quick.committed': 'Committed',
  'quick.pushed': 'Committed and pushed',
  'quick.commitFail': (p: Params) => `Commit failed: ${p.msg}`,
  'quick.pushFail': (p: Params) => `Committed, but the push failed: ${p.msg}`,
  'quick.noRemote': 'Committed, but there is no remote to push to',
  'quick.retryPush': 'Retry Push',
  'quick.openLanes': 'Open Lanes',
  'quick.statusFail': (p: Params) => `Can't load status: ${p.msg}`,
  'quick.detached': 'Detached HEAD',
  'quick.hint': 'Esc close · ⌘↩ commit',
};
