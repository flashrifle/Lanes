import { describe, expect, it } from 'vitest';
import { build, checkInvariant, randomSnapshot, rng, SORTS } from './helpers';

describe('up/down pairing invariant on seeded random DAGs', () => {
  for (const sortType of SORTS) {
    for (const collapseLongEdges of [true, false]) {
      it(`sort=${sortType} collapse=${collapseLongEdges}`, () => {
        for (let seed = 1; seed <= 25; seed++) {
          const n = 50 + ((seed * 37) % 400);
          const snap = randomSnapshot(n, seed, { maxJump: seed % 3 === 0 ? 60 : 8 });
          const full = build(snap, { sortType, collapseLongEdges });
          expect(full.rowCount).toBe(n);
          const err = checkInvariant(full);
          expect(err, `seed ${seed} (full)`).toBeNull();

          // random mask
          const rand = rng(seed * 7919);
          const density = [0.1, 0.4, 0.8][seed % 3];
          const visible = new Uint8Array(n);
          let cnt = 0;
          for (let i = 0; i < n; i++) if (rand() < density) (visible[i] = 1), cnt++;
          const filtered = build(snap, { sortType, collapseLongEdges, visible });
          expect(filtered.rowCount).toBe(cnt);
          expect(checkInvariant(filtered), `seed ${seed} (filtered)`).toBeNull();
          // filtered rows keep the relative order of the full layout
          let last = -1;
          for (let r = 0; r < filtered.rowCount; r++) {
            const fr = full.rowOf(filtered.commitIndexAt(r));
            expect(fr).toBeGreaterThan(last);
            last = fr;
          }
        }
      });
    }
  }

  it('every loaded parent connection is drawn (unfiltered, no collapse)', () => {
    for (let seed = 100; seed < 110; seed++) {
      const snap = randomSnapshot(300, seed);
      const l = build(snap, { collapseLongEdges: false });
      // count down half-edges leaving each node == number of distinct parents (incl. missing)
      for (let r = 0; r < l.rowCount - 1; r++) {
        const row = l.getRow(r);
        const c = row.commitIndex;
        const ps = new Set(snap.parents[c].filter((p) => p !== c));
        const fromNode = row.edges.filter((e) => e.dir === 'down' && e.lane === row.nodeLane).length;
        expect(fromNode).toBe(ps.size);
      }
    }
  });
});
