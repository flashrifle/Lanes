// One stacked Escape handler per window: dialogs, menus and popovers push a layer; Escape goes to the topmost
// layer only (and stops there). Modal layers also gate global shortcuts (⌘W / ⌘R / ⌘T / ⌘1-9).
import { useEffect, useRef, type RefObject } from 'react';

export interface Layer {
  /** Escape handler. Missing (or a busy modal) = Escape is swallowed by this layer. */
  onEscape?: () => void;
  modal: boolean;
}

const stack: Layer[] = [];
let installed = false;

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  // Capture phase on window: this also skips every bubble-phase handler (window-level Escape listeners, React).
  e.stopImmediatePropagation();
  top.onEscape?.();
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKeyDown, true);
}

/** Push a layer; returns its remover. */
export function pushLayer(layer: Layer): () => void {
  install();
  stack.push(layer);
  return () => {
    const i = stack.lastIndexOf(layer);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** A modal dialog is open in this window. */
export function hasModalLayer(): boolean { return stack.some((l) => l.modal); }
/** Any dialog / menu / popover layer is open in this window. */
export function hasLayer(): boolean { return stack.length > 0; }
/** Test hook. */
export function layerCount(): number { return stack.length; }

/** Register a layer while `enabled`. The handler is read through a ref, so it may change every render. */
export function useLayer(onEscape: (() => void) | undefined, opts: { modal?: boolean; enabled?: boolean } = {}): void {
  const { modal = false, enabled = true } = opts;
  const h = useRef(onEscape);
  h.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    return pushLayer({ modal, onEscape: () => h.current?.() });
  }, [modal, enabled]);
}

const TABBABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Modal behaviour for a dialog element: a modal Escape layer (Escape and backdrop are ignored while `busy`),
 * Tab / Shift+Tab focus trap, initial focus inside the dialog, and focus restored to the opener on close.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onClose: () => void, busy = false): void {
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useLayer(() => { if (!busyRef.current) onClose(); }, { modal: true });

  useEffect(() => {
    const el = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (el && !el.contains(document.activeElement)) (tabbables(el)[0] ?? el).focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !el) return;
      const list = tabbables(el);
      if (list.length === 0) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !el.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
    };
    el?.addEventListener('keydown', trap);
    return () => {
      el?.removeEventListener('keydown', trap);
      // Restore only when focus would otherwise be lost (it was inside the dialog, or fell back to <body>).
      const a = document.activeElement;
      if (opener && opener.isConnected && (!a || a === document.body || el?.contains(a))) opener.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
