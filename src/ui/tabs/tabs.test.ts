import { describe, expect, it } from 'vitest';
import { addTab, closeTabModel, cycleTab, findTabByPath, parseTabs, serializeTabs, tabForShortcut, tabLabels } from './tabs';

const t = (id: number, path = `/r/${id}`) => ({ id, path });

describe('tabs model', () => {
  it('adds and activates; duplicate path only switches', () => {
    let m = addTab({ tabs: [], activeId: null }, t(1));
    m = addTab(m, t(2));
    expect(m.activeId).toBe(2);
    m = addTab(m, t(3, '/r/1'));
    expect(m.tabs.map((x) => x.id)).toEqual([1, 2]);
    expect(m.activeId).toBe(1);
    expect(findTabByPath(m.tabs, '/r/2')?.id).toBe(2);
  });
  it('closing active activates right neighbour, else left, else null', () => {
    const base = { tabs: [t(1), t(2), t(3)], activeId: 2 };
    expect(closeTabModel(base, 2).activeId).toBe(3);
    expect(closeTabModel({ ...base, activeId: 3 }, 3).activeId).toBe(2);
    expect(closeTabModel({ tabs: [t(1)], activeId: 1 }, 1)).toEqual({ tabs: [], activeId: null });
  });
  it('closing an inactive tab keeps the active one', () => {
    const r = closeTabModel({ tabs: [t(1), t(2), t(3)], activeId: 3 }, 1);
    expect(r.activeId).toBe(3);
    expect(r.tabs.length).toBe(2);
  });
  it('closing an unknown id is a no-op', () => {
    const m = { tabs: [t(1)], activeId: 1 };
    expect(closeTabModel(m, 9)).toBe(m);
  });
  it('cycles with wrap', () => {
    const m = { tabs: [t(1), t(2), t(3)], activeId: 3 };
    expect(cycleTab(m, 1)).toBe(1);
    expect(cycleTab({ ...m, activeId: 1 }, -1)).toBe(3);
    expect(cycleTab({ tabs: [], activeId: null }, 1)).toBeNull();
  });
  it('shortcut index: 9 = last', () => {
    const tabs = [t(1), t(2), t(3)];
    expect(tabForShortcut(tabs, 2)?.id).toBe(2);
    expect(tabForShortcut(tabs, 5)).toBeUndefined();
    expect(tabForShortcut(tabs, 9)?.id).toBe(3);
  });
  it('disambiguates duplicate names', () => {
    const l = tabLabels([{ id: 1, name: 'app', path: '/a/x/app' }, { id: 2, name: 'app', path: '/b/y/app' }, { id: 3, name: 'z', path: '/z' }]);
    expect(l.get(1)).toBe('app — x');
    expect(l.get(2)).toBe('app — y');
    expect(l.get(3)).toBe('z');
  });
});

describe('tab persistence', () => {
  it('round-trips', () => {
    const raw = serializeTabs([t(1), t(2)], 2);
    expect(parseTabs(raw)).toEqual({ paths: ['/r/1', '/r/2'], active: '/r/2' });
  });
  it('is tolerant of garbage', () => {
    expect(parseTabs(null)).toEqual({ paths: [], active: null });
    expect(parseTabs('{nope')).toEqual({ paths: [], active: null });
    expect(parseTabs('{"paths":[1,"/a","/a"],"active":"/zzz"}')).toEqual({ paths: ['/a'], active: null });
  });
});
