import { useSyncExternalStore } from 'react';

export type Density = 'comfortable' | 'compact';

export interface GraphMetrics {
  rowH: number;
  laneW: number;
  lineW: number;
  /** Station radius (centre line of the ring) and ring thickness. */
  nodeR: number;
  ring: number;
  /** Interchange (merge) radius and inner dot radius. */
  mergeR: number;
  dotR: number;
}

export const DENSITIES: Record<Density, GraphMetrics> = {
  comfortable: { rowH: 36, laneW: 28, lineW: 6.5, nodeR: 6, ring: 3.5, mergeR: 9, dotR: 4.5 },
  compact: { rowH: 26, laneW: 20, lineW: 4.5, nodeR: 4.5, ring: 2.5, mergeR: 6.5, dotR: 3 },
};

export const DENSITY_LABEL: Record<Density, string> = { comfortable: '넓게', compact: '촘촘하게' };
const KEY = 'lanes.density';

function load(): Density {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'compact' || v === 'comfortable') return v;
  } catch { /* storage unavailable */ }
  return 'comfortable';
}

let current: Density = load();
const listeners = new Set<() => void>();

export function setDensity(d: Density): void {
  if (d === current) return;
  current = d;
  try { localStorage.setItem(KEY, d); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export function useDensity(): Density {
  return useSyncExternalStore(subscribe, () => current);
}

export const useMetrics = (): GraphMetrics => DENSITIES[useDensity()];
