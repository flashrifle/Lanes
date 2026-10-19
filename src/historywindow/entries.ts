// Pure helpers over FileHistory entries.
import type { FileHistoryEntry } from '../types';

/** Case-insensitive filter over subject, author name/email and hash prefix. Empty query = all. */
export function filterEntries(entries: readonly FileHistoryEntry[], query: string): FileHistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return entries.slice();
  const hexOnly = /^[0-9a-f]+$/.test(q);
  return entries.filter(
    (e) =>
      e.subject.toLowerCase().includes(q) ||
      e.authorName.toLowerCase().includes(q) ||
      e.authorEmail.toLowerCase().includes(q) ||
      (hexOnly && e.hash.startsWith(q)),
  );
}

/** Index of the entry whose hash equals (or starts with, for a short hash) `hash`; -1 if absent. */
export function findEntry(entries: readonly FileHistoryEntry[], hash: string | null | undefined): number {
  if (!hash) return -1;
  const h = hash.toLowerCase();
  const exact = entries.findIndex((e) => e.hash === h);
  if (exact >= 0 || h.length >= 40) return exact;
  return entries.findIndex((e) => e.hash.startsWith(h));
}

/** The file's earlier names, newest first (from rename entries). */
export function previousNames(entries: readonly FileHistoryEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) if (e.oldPath && e.oldPath !== e.path && !out.includes(e.oldPath)) out.push(e.oldPath);
  return out;
}
