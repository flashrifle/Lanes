import { createContext, useContext } from 'react';
import { useStoreState } from './createStore';
import type { RepoState, RepoStore } from './repoStore';

export const RepoCtx = createContext<RepoStore | null>(null);

/** The RepoStore of the tab this component lives in. */
export function useRepoStore(): RepoStore {
  const s = useContext(RepoCtx);
  if (!s) throw new Error('useRepoStore outside of a repo tab');
  return s;
}

export function useRepo<T>(selector: (s: RepoState) => T): T {
  return useStoreState(useRepoStore(), selector);
}
