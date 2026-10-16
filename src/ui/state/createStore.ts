import { useSyncExternalStore } from 'react';

/** Minimal external store: immutable state object + subscribe. */
export class Store<S extends object> {
  protected state: S;
  private listeners = new Set<() => void>();
  constructor(initial: S) { this.state = initial; }
  getState = (): S => this.state;
  protected set(patch: Partial<S>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };
}

export function useStoreState<S extends object, T>(store: Store<S>, selector: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
