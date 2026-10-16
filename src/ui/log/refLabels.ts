import type { Ref } from '../../types';

export type RefLabelKind = 'head' | 'local' | 'remote' | 'tag';

export interface RefLabel {
  text: string;
  kind: RefLabelKind;
  isCurrent: boolean;
  isFavorite: boolean;
  /** Full names this label stands for (local + upstream when merged). */
  fullNames: string[];
}

/** Group refs by snapshot index (skips refs not loaded). */
export function refsByIndex(refs: Ref[]): Map<number, Ref[]> {
  const m = new Map<number, Ref[]>();
  for (const r of refs) {
    if (r.index == null) continue;
    const l = m.get(r.index);
    if (l) l.push(r);
    else m.set(r.index, [r]);
  }
  return m;
}

/**
 * Labels for refs pointing at one commit. A local branch whose upstream is at the same
 * commit collapses with it into "origin & main". Order: HEAD/current, favorites, local, remote, tags.
 */
export function buildRefLabels(refs: Ref[]): RefLabel[] {
  const remotes = new Map(refs.filter((r) => r.type === 'remoteBranch').map((r) => [r.fullName, r]));
  const hasCurrentBranch = refs.some((r) => r.type === 'localBranch' && r.isCurrent);
  const usedRemotes = new Set<string>();
  const out: RefLabel[] = [];

  for (const r of refs) {
    if (r.type === 'head') {
      if (!hasCurrentBranch) out.push({ text: 'HEAD', kind: 'head', isCurrent: true, isFavorite: false, fullNames: ['HEAD'] });
    } else if (r.type === 'localBranch') {
      const up = r.upstream ? remotes.get(r.upstream) : undefined;
      if (up) {
        usedRemotes.add(up.fullName);
        const remoteName = up.remote ?? up.name.split('/')[0];
        const shortUp = up.name.startsWith(remoteName + '/') ? up.name.slice(remoteName.length + 1) : up.name;
        const left = shortUp === r.name ? remoteName : up.name;
        out.push({ text: `${left} & ${r.name}`, kind: 'local', isCurrent: r.isCurrent, isFavorite: r.isFavorite, fullNames: [r.fullName, up.fullName] });
      } else {
        out.push({ text: r.name, kind: 'local', isCurrent: r.isCurrent, isFavorite: r.isFavorite, fullNames: [r.fullName] });
      }
    }
  }
  for (const r of refs) {
    if (r.type === 'remoteBranch' && !usedRemotes.has(r.fullName)) {
      out.push({ text: r.name, kind: 'remote', isCurrent: false, isFavorite: r.isFavorite, fullNames: [r.fullName] });
    } else if (r.type === 'tag') {
      out.push({ text: r.name, kind: 'tag', isCurrent: false, isFavorite: false, fullNames: [r.fullName] });
    }
  }
  const rank = (l: RefLabel) => {
    if (l.kind === 'head' || l.isCurrent) return 0;
    if (l.isFavorite) return 1;
    return { head: 0, local: 2, remote: 3, tag: 4 }[l.kind];
  };
  return out
    .map((l, i) => ({ l, i }))
    .sort((a, b) => rank(a.l) - rank(b.l) || a.i - b.i)
    .map((x) => x.l);
}
