import type { ChangedFile } from '../../types';

export type FileTreeNode =
  | { kind: 'dir'; id: string; name: string; fileCount: number; children: FileTreeNode[] }
  | { kind: 'file'; id: string; name: string; file: ChangedFile };

/** Directory tree from changed files; single-child directory chains are compressed ("a/b"). */
export function buildFileTree(files: ChangedFile[]): FileTreeNode[] {
  type D = { name: string; id: string; dirs: Map<string, D>; files: ChangedFile[] };
  const root: D = { name: '', id: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = cur.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], id: cur.id ? cur.id + '/' + parts[i] : parts[i], dirs: new Map(), files: [] };
        cur.dirs.set(parts[i], next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  const count = (d: D): number => d.files.length + [...d.dirs.values()].reduce((a, c) => a + count(c), 0);
  const conv = (d: D): FileTreeNode[] => {
    const out: FileTreeNode[] = [];
    for (const sub of [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      let name = sub.name;
      let cur = sub;
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        cur = [...cur.dirs.values()][0];
        name += '/' + cur.name;
      }
      out.push({ kind: 'dir', id: cur.id, name, fileCount: count(cur), children: conv(cur) });
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
      out.push({ kind: 'file', id: 'file:' + f.path, name: f.path.split('/').pop() ?? f.path, file: f });
    }
    return out;
  };
  return conv(root);
}

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}
