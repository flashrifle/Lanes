import { beforeAll, describe, expect, it, vi } from 'vitest';

// node environment: a bare EventTarget stands in for window.
beforeAll(() => { (globalThis as { window?: unknown }).window = new EventTarget(); });

const esc = () => {
  const e = new Event('keydown', { cancelable: true, bubbles: true });
  Object.defineProperty(e, 'key', { value: 'Escape' });
  window.dispatchEvent(e);
  return e;
};

describe('layer stack', () => {
  it('Escape goes to the topmost layer only, and stops there', async () => {
    const { pushLayer, hasModalLayer, hasLayer } = await import('./layers');
    const below = vi.fn();
    pushLayer({ modal: false })(); // installs the stack's capture listener first, like at app start
    const later = vi.fn();
    window.addEventListener('keydown', later); // a window listener registered later (e.g. a global shortcut)
    const popDialog = pushLayer({ modal: true, onEscape: below });
    const top = vi.fn();
    const popMenu = pushLayer({ modal: false, onEscape: top });
    expect(hasModalLayer()).toBe(true);
    const e = esc();
    expect(top).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    popMenu();
    esc();
    expect(below).toHaveBeenCalledTimes(1);
    popDialog();
    expect(hasLayer()).toBe(false);
    expect(hasModalLayer()).toBe(false);
    const e2 = esc();
    expect(e2.defaultPrevented).toBe(false); // nothing open: Escape passes through
    expect(later).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', later);
  });

  it('a busy modal swallows Escape (no handler)', async () => {
    const { pushLayer } = await import('./layers');
    const below = vi.fn();
    const pop1 = pushLayer({ modal: false, onEscape: below });
    const pop2 = pushLayer({ modal: true });
    esc();
    expect(below).not.toHaveBeenCalled();
    pop2(); pop1();
  });

  it('removing a layer out of order keeps the others', async () => {
    const { pushLayer, layerCount } = await import('./layers');
    const a = vi.fn();
    const b = vi.fn();
    const popA = pushLayer({ modal: false, onEscape: a });
    const popB = pushLayer({ modal: false, onEscape: b });
    popA();
    esc();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    popB();
    expect(layerCount()).toBe(0);
  });
});
