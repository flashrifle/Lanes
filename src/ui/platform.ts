export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

/** "⌘R" on macOS, "Ctrl+R" elsewhere. */
export function modKey(key: string, shift = false): string {
  return IS_MAC ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

/** The "command" modifier of a keyboard/mouse event (Cmd on macOS, Ctrl elsewhere). */
export function hasMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}
