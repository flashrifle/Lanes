import { getSettings, saveSettings, useSettings } from '../app/settingsStore';
import { t } from '../../i18n';

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

export const densityLabel = (d: Density): string => t(d === 'compact' ? 'density.compact' : 'density.comfortable');

// Backed by AppSettings.density (src/ui/app/settingsStore.ts); every window follows `settings-changed`.
export function setDensity(d: Density): void {
  if (d === getSettings().density) return;
  void saveSettings({ density: d }).catch(() => { /* reverted by the store */ });
}

export function useDensity(): Density {
  return useSettings().density;
}

export const useMetrics = (): GraphMetrics => DENSITIES[useDensity()];
