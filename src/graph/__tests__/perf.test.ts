import { describe, expect, it } from 'vitest';
import { build, randomSnapshot } from './helpers';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const PERF = env.PERF === '1';

describe.skipIf(!PERF)('perf 100k', () => {
  const N = 100_000;
  const snap = randomSnapshot(N, 42, { mergeRate: 0.12 });

  for (const sortType of ['normal', 'bek'] as const) {
    it(`buildGraph(${sortType}) < 300 ms, getRow < 50 us amortized`, () => {
      build(snap, { sortType }); // warm-up JIT
      const t0 = performance.now();
      const l = build(snap, { sortType });
      const t1 = performance.now();
      for (let r = 0; r < l.rowCount; r++) l.getRow(r);
      const t2 = performance.now();
      const buildMs = t1 - t0;
      const perRowUs = ((t2 - t1) * 1000) / l.rowCount;
      console.log(`[perf] ${sortType}: build ${buildMs.toFixed(1)} ms, getRow ${perRowUs.toFixed(2)} us/row, maxLanes ${l.maxLaneCount}`);
      expect(buildMs).toBeLessThan(300);
      expect(perRowUs).toBeLessThan(50);

      const visible = new Uint8Array(N);
      for (let i = 0; i < N; i += 3) visible[i] = 1;
      const t3 = performance.now();
      const f = build(snap, { sortType, visible });
      const t4 = performance.now();
      for (let r = 0; r < f.rowCount; r++) f.getRow(r);
      const t5 = performance.now();
      console.log(`[perf] ${sortType} filtered 1/3: build ${(t4 - t3).toFixed(1)} ms, getRow ${(((t5 - t4) * 1000) / f.rowCount).toFixed(2)} us/row`);
      expect(t4 - t3).toBeLessThan(300);
    });
  }
});
