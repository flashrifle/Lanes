import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../types';
import { buildFileTree, fileExt } from './fileTree';

const f = (path: string): ChangedFile => ({
  path, oldPath: null, status: 'modified', additions: 1, deletions: 0, binary: false, fromHash: 'a', toHash: 'b',
});

describe('buildFileTree', () => {
  it('compresses single-child chains and counts files', () => {
    const t = buildFileTree([f('src/app/config/app.config.ts'), f('src/app/config/b.ts'), f('README.md')]);
    expect(t.map((n) => n.name)).toEqual(['src/app/config', 'README.md']);
    const dir = t[0];
    expect(dir.kind === 'dir' && dir.fileCount).toBe(2);
    expect(dir.kind === 'dir' && dir.children.map((c) => c.name)).toEqual(['app.config.ts', 'b.ts']);
  });
  it('does not compress when dir has files', () => {
    const t = buildFileTree([f('a/x.ts'), f('a/b/y.ts')]);
    expect(t).toHaveLength(1);
    const a = t[0];
    expect(a.kind === 'dir' && a.name).toBe('a');
    expect(a.kind === 'dir' && a.children.map((c) => c.name)).toEqual(['b', 'x.ts']);
  });
  it('fileExt', () => {
    expect(fileExt('a.TS')).toBe('ts');
    expect(fileExt('.gitignore')).toBe('');
  });
});
